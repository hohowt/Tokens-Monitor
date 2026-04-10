from datetime import date, datetime, time as dt_time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select, text, cast, Date as SADate
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import Alert, Client, Department, TokenUsageLog, User
from app.schemas import (
    AlertItem,
    AlertListResponse,
    BreakdownItem,
    BreakdownResponse,
    OverviewResponse,
    RankingItem,
    RankingResponse,
    TrendPoint,
    TrendResponse,
    UsageLogItem,
    UsageLogResponse,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


ESTIMATE_SOURCE = "client-mitm-estimate"


def _request_count_expr():
    return func.coalesce(TokenUsageLog.request_count, 1)


def _source_display_name(source: str | None) -> str:
    mapping = {
        "gateway": "网关同步",
        "client": "本地精确解析",
        "tokscale": "Tokscale 扫描",
        ESTIMATE_SOURCE: "本地估算补齐",
    }
    return mapping.get(source or "", source or "unknown")


def _source_app_display_name(source_app: str | None) -> str:
    if not source_app:
        return "未标记应用"
    mapping = {
        # IDE / 编辑器
        "vscode": "VS Code",
        "vscode-insiders": "VS Code Insiders",
        "cursor": "Cursor",
        # Tokscale 支持的 AI 客户端
        "claude": "Claude Code",
        "opencode": "OpenCode",
        "openclaw": "OpenClaw",
        "codex": "Codex CLI",
        "gemini": "Gemini CLI",
        "amp": "Amp",
        "droid": "Droid",
        "hermes": "Hermes Agent",
        "pi": "Pi",
        "kimi": "Kimi CLI",
        "qwen": "Qwen CLI",
        "roocode": "Roo Code",
        "kilocode": "Kilo Code",
        "kilo": "Kilo CLI",
        "mux": "Mux",
        "crush": "Crush",
        "synthetic": "Synthetic",
        # 其他
        "powershell": "PowerShell",
        "cmd": "CMD",
        "gateway-sync": "网关同步",
        "unknown-app": "未标记应用",
    }
    return mapping.get(source_app, source_app)


def _endpoint_display_name(endpoint: str | None) -> str:
    normalized = (endpoint or "").strip()
    if not normalized:
        return "未记录接口"
    return normalized


def _source_app_key_expr():
    return case(
        (
            (TokenUsageLog.source_app.is_(None)) | (TokenUsageLog.source_app == ""),
            case((TokenUsageLog.source == "gateway", "gateway-sync"), else_="unknown-app"),
        ),
        else_=TokenUsageLog.source_app,
    )


def _apply_source_app_filter(stmt, source_app: str | None):
    normalized = (source_app or "").strip()
    if not normalized:
        return stmt
    return stmt.where(_source_app_key_expr() == normalized)


def _dashboard_tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.DASHBOARD_TIMEZONE)
    except Exception:
        return ZoneInfo("Asia/Shanghai")


def _ts_range(days: int, start_date: date | None = None, end_date: date | None = None):
    """返回大屏统计用的 [start_ts, end_ts]，按 DASHBOARD_TIMEZONE 的日历日边界（默认同国内本地日）。"""
    tz = _dashboard_tz()
    end_d = end_date or datetime.now(tz).date()
    start_d = start_date or (end_d - timedelta(days=days - 1))
    start_ts = datetime.combine(start_d, dt_time.min, tzinfo=tz)
    end_ts = datetime.combine(end_d, dt_time(23, 59, 59, 999999), tzinfo=tz)
    return start_ts, end_ts


def _request_local_date_column():
    """PostgreSQL: 将 timestamptz 转为业务时区后再取日期，趋势图横轴与本地「几月几号」一致。"""
    return cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), SADate)


# ── Overview ──────────────────────────────────────────────
@router.get("/overview", response_model=OverviewResponse)
async def get_overview(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    prev_start_ts = start_ts - timedelta(days=days)

    # Current period
    current_stmt = _apply_source_app_filter(
        select(
            func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
            func.coalesce(func.sum(TokenUsageLog.cost_cny), 0),
            func.coalesce(func.sum(_request_count_expr()), 0),
            func.count(func.distinct(TokenUsageLog.user_id)),
            func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, TokenUsageLog.total_tokens), else_=0)), 0),
            func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, _request_count_expr()), else_=0)), 0),
        ).where(TokenUsageLog.request_at.between(start_ts, end_ts)),
        source_app,
    )
    cur = await db.execute(current_stmt)
    tokens, cost, requests, users, estimated_tokens, estimated_requests = cur.one()
    users_count = int(users or 0)
    exact_tokens = int(tokens) - int(estimated_tokens)
    exact_requests = int(requests) - int(estimated_requests)

    # Previous period for comparison
    prev_stmt = _apply_source_app_filter(
        select(
            func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
            func.coalesce(func.sum(TokenUsageLog.cost_cny), 0),
        ).where(TokenUsageLog.request_at.between(prev_start_ts, start_ts - timedelta(seconds=1))),
        source_app,
    )
    prev = await db.execute(prev_stmt)
    prev_tokens, prev_cost = prev.one()

    def pct(cur_val, prev_val):
        if not prev_val:
            return None
        return round((cur_val - prev_val) / prev_val * 100, 1)

    return OverviewResponse(
        total_tokens=int(tokens),
        total_cost_cny=round(float(cost), 2),
        total_requests=int(requests),
        active_users=users_count,
        avg_tokens_per_user=int(tokens) // users_count if users_count else 0,
        avg_cost_per_user=round(float(cost) / users_count, 2) if users_count else 0.0,
        exact_tokens=max(exact_tokens, 0),
        estimated_tokens=int(estimated_tokens),
        exact_requests=max(exact_requests, 0),
        estimated_requests=int(estimated_requests),
        tokens_change_pct=pct(tokens, prev_tokens),
        cost_change_pct=pct(cost, prev_cost),
    )


# ── Trend ─────────────────────────────────────────────────
@router.get("/trend", response_model=TrendResponse)
async def get_trend(
    days: int = Query(15, ge=1, le=365),
    start_date: date | None = None,
    end_date: date | None = None,
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days, start_date, end_date)
    dt = _request_local_date_column()
    stmt = _apply_source_app_filter(
        select(
            dt.label("d"),
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.input_tokens),
            func.sum(TokenUsageLog.output_tokens),
            func.sum(TokenUsageLog.cost_cny),
            func.coalesce(func.sum(_request_count_expr()), 0),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(dt)
        .order_by(dt),
        source_app,
    )
    result = await db.execute(stmt)
    points = []
    total_t = 0
    total_c = 0.0
    for row in result.all():
        d, tt, it, ot, c, r = row
        points.append(TrendPoint(
            date=d.isoformat(), total_tokens=int(tt), input_tokens=int(it),
            output_tokens=int(ot), cost_cny=round(float(c), 2), requests=int(r),
        ))
        total_t += int(tt)
        total_c += float(c)
    n = len(points) or 1
    return TrendResponse(points=points, avg_tokens=total_t // n, avg_cost=round(total_c / n, 2))


# ── Ranking by user ───────────────────────────────────────
@router.get("/by-user", response_model=RankingResponse)
async def get_by_user(
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(20, ge=1, le=100),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            User.id, User.name,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
            func.coalesce(func.sum(_request_count_expr()), 0),
        )
        .join(User, TokenUsageLog.user_id == User.id)
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(User.id, User.name)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc())
        .limit(limit),
        source_app,
    )
    result = await db.execute(stmt)
    items = [
        RankingItem(id=r[0], name=r[1], total_tokens=int(r[2]), cost_cny=round(float(r[3]), 2), requests=int(r[4]))
        for r in result.all()
    ]
    return RankingResponse(items=items)


# ── Ranking by department ─────────────────────────────────
@router.get("/by-department", response_model=RankingResponse)
async def get_by_department(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            Department.id,
            Department.name,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
            func.coalesce(func.sum(_request_count_expr()), 0),
        )
        .join(User, TokenUsageLog.user_id == User.id)
        .join(Department, User.department_id == Department.id)
        .where(
            TokenUsageLog.request_at.between(start_ts, end_ts),
            User.department_id.isnot(None),
        )
        .group_by(Department.id, Department.name)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    items = [
        RankingItem(id=r[0], name=r[1], total_tokens=int(r[2]), cost_cny=round(float(r[3]), 2), requests=int(r[4]))
        for r in result.all()
    ]
    return RankingResponse(items=items)


# ── Breakdown by model ────────────────────────────────────
@router.get("/by-model", response_model=BreakdownResponse)
async def get_by_model(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            TokenUsageLog.model_name,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(TokenUsageLog.model_name)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    rows = result.all()
    grand_total = sum(int(r[1]) for r in rows) or 1
    items = [
        BreakdownItem(
            key=r[0] or "unknown",
            name=r[0] or "unknown", total_tokens=int(r[1]),
            cost_cny=round(float(r[2]), 2),
            percentage=round(int(r[1]) / grand_total * 100, 1),
        )
        for r in rows
    ]
    return BreakdownResponse(items=items)


# ── Breakdown by provider ─────────────────────────────────
@router.get("/by-provider", response_model=BreakdownResponse)
async def get_by_provider(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            TokenUsageLog.provider,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(TokenUsageLog.provider)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    rows = result.all()
    grand_total = sum(int(r[1]) for r in rows) or 1
    items = [
        BreakdownItem(
            key=r[0] or "unknown",
            name=r[0] or "unknown", total_tokens=int(r[1]),
            cost_cny=round(float(r[2]), 2),
            percentage=round(int(r[1]) / grand_total * 100, 1),
        )
        for r in rows
    ]
    return BreakdownResponse(items=items)


# ── Breakdown by source ───────────────────────────────────
@router.get("/by-source", response_model=BreakdownResponse)
async def get_by_source(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            TokenUsageLog.source,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(TokenUsageLog.source)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    rows = result.all()
    grand_total = sum(int(r[1]) for r in rows) or 1
    items = [
        BreakdownItem(
            key=r[0] or "unknown",
            name=_source_display_name(r[0]),
            total_tokens=int(r[1]),
            cost_cny=round(float(r[2]), 2),
            percentage=round(int(r[1]) / grand_total * 100, 1),
        )
        for r in rows
    ]
    return BreakdownResponse(items=items)


# ── Breakdown by source app ───────────────────────────────
@router.get("/by-source-app", response_model=BreakdownResponse)
async def get_by_source_app(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    source_app_key = _source_app_key_expr()
    stmt = _apply_source_app_filter(
        select(
            source_app_key.label("source_app"),
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(source_app_key)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    rows = result.all()
    grand_total = sum(int(r[1]) for r in rows) or 1
    items = [
        BreakdownItem(
            key=r[0],
            name=_source_app_display_name(r[0]),
            total_tokens=int(r[1]),
            cost_cny=round(float(r[2]), 2),
            percentage=round(int(r[1]) / grand_total * 100, 1),
        )
        for r in rows
    ]
    return BreakdownResponse(items=items)


# ── Breakdown by endpoint ─────────────────────────────────
@router.get("/by-endpoint", response_model=BreakdownResponse)
async def get_by_endpoint(
    days: int = Query(30, ge=1, le=365),
    source_app: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    stmt = _apply_source_app_filter(
        select(
            TokenUsageLog.endpoint.label("endpoint"),
            func.sum(TokenUsageLog.total_tokens),
            func.sum(TokenUsageLog.cost_cny),
        )
        .where(
            TokenUsageLog.request_at.between(start_ts, end_ts),
            TokenUsageLog.endpoint.is_not(None),
            TokenUsageLog.endpoint != "",
        )
        .group_by(TokenUsageLog.endpoint)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc()),
        source_app,
    )
    result = await db.execute(stmt)
    rows = result.all()
    grand_total = sum(int(r[1]) for r in rows) or 1
    items = [
        BreakdownItem(
            key=r[0] or "未记录接口",
            name=_endpoint_display_name(r[0]),
            total_tokens=int(r[1]),
            cost_cny=round(float(r[2]), 2),
            percentage=round(int(r[1]) / grand_total * 100, 1),
        )
        for r in rows
    ]
    return BreakdownResponse(items=items)


# ── Alerts ────────────────────────────────────────────────
@router.get("/alerts", response_model=AlertListResponse)
async def get_alerts(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    # Total count
    count_result = await db.execute(select(func.count(Alert.id)))
    total = count_result.scalar() or 0

    result = await db.execute(
        select(Alert)
        .order_by(Alert.created_at.desc())
        .offset(offset).limit(limit)
    )
    alerts = result.scalars().all()
    items = []
    for a in alerts:
        # Resolve target name
        target_name = f"{a.target_type}#{a.target_id}"
        if a.target_type == "user":
            u = await db.get(User, a.target_id)
            if u:
                target_name = u.name
        elif a.target_type == "department":
            d = await db.get(Department, a.target_id)
            if d:
                target_name = d.name
        items.append(AlertItem(
            id=a.id, alert_type=a.alert_type, target_type=a.target_type,
            target_name=target_name, message=a.message,
            actual_value=a.actual_value, threshold_value=a.threshold_value,
            created_at=a.created_at,
        ))
    return AlertListResponse(items=items, total=total)


# ── Usage detail logs ─────────────────────────────────────
@router.get("/logs", response_model=UsageLogResponse)
async def get_logs(
    days: int = Query(7, ge=1, le=90),
    user_id: int | None = None,
    model_name: str | None = None,
    source_app: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    start_ts, _ = _ts_range(days)
    base = (
        select(
            TokenUsageLog.id, User.name.label("user_name"),
            TokenUsageLog.model_name, TokenUsageLog.provider,
            TokenUsageLog.endpoint,
            TokenUsageLog.input_tokens, TokenUsageLog.output_tokens,
            TokenUsageLog.total_tokens, TokenUsageLog.cost_cny,
            TokenUsageLog.request_at,
        )
        .outerjoin(User, TokenUsageLog.user_id == User.id)
        .where(TokenUsageLog.request_at >= start_ts)
    )
    if user_id:
        base = base.where(TokenUsageLog.user_id == user_id)
    if model_name:
        base = base.where(TokenUsageLog.model_name == model_name)
    base = _apply_source_app_filter(base, source_app)

    count_q = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    rows = await db.execute(
        base.order_by(TokenUsageLog.request_at.desc()).offset(offset).limit(limit)
    )
    items = [
        UsageLogItem(
            id=r[0], user_name=r[1] or "unknown", model_name=r[2], provider=r[3],
            endpoint=r[4], input_tokens=r[5], output_tokens=r[6], total_tokens=r[7],
            cost_cny=round(float(r[8]), 4), request_at=r[9],
        )
        for r in rows.all()
    ]
    return UsageLogResponse(items=items, total=total)
