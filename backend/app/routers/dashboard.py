from datetime import date, datetime, time as dt_time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select, cast, Date as SADate
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin
from app.canonical import dashboard_tz, provider_key_sql_case, source_app_display_name, source_app_key_sql_case
from app.config import settings
from app.database import get_db
from app.models import Alert, Client, Department, ModelPricing, TokenUsageLog, User
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


def _billable_cost_expr(column):
    return case((TokenUsageLog.source == ESTIMATE_SOURCE, 0), else_=column)


def _source_display_name(source: str | None) -> str:
    mapping = {
        "gateway": "网关同步",
        "client": "本地精确解析",
        "tokscale": "Tokscale 扫描",
        ESTIMATE_SOURCE: "本地估算补齐",
    }
    return mapping.get(source or "", source or "unknown")



def _endpoint_display_name(endpoint: str | None) -> str:
    normalized = (endpoint or "").strip()
    if not normalized:
        return "未记录接口"
    return normalized


def _source_app_key_expr():
    return source_app_key_sql_case(TokenUsageLog.source_app, TokenUsageLog.source)


def _apply_source_app_filter(stmt, source_app: str | None):
    normalized = (source_app or "").strip()
    if not normalized:
        return stmt
    return stmt.where(_source_app_key_expr() == normalized)


def _ts_range(days: int, start_date: date | None = None, end_date: date | None = None):
    """返回大屏统计用的 [start_ts, end_ts]，按 DASHBOARD_TIMEZONE 的日历日边界（默认同国内本地日）。"""
    tz = dashboard_tz()
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
    employee_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    start_ts, end_ts = _ts_range(days)
    prev_start_ts = start_ts - timedelta(days=days)

    # 可选：按 employee_id 过滤（扩展侧边栏用）
    user_filter_id: int | None = None
    if employee_id:
        user_row = await db.execute(
            select(User.id).where(User.employee_id == employee_id.strip())
        )
        found_id = user_row.scalar_one_or_none()
        if found_id is None:
            # 用户不存在，直接返回空数据
            return OverviewResponse(
                total_tokens=0, total_cost_cny=0.0, total_requests=0,
                active_users=0, avg_tokens_per_user=0, avg_cost_per_user=0.0,
                exact_tokens=0, estimated_tokens=0, exact_requests=0,
                estimated_requests=0, tokens_change_pct=None, cost_change_pct=None,
            )
        user_filter_id = found_id

    # 排除测试/停用用户的 user_id 集合
    _excluded_user_ids = select(User.id).where(
        (User.is_test == True) | (User.is_active == False)  # noqa: E712
    ).scalar_subquery()

    # Current period
    current_base = select(
        func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
        func.coalesce(func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)), 0),
        func.coalesce(func.sum(_request_count_expr()), 0),
        func.count(func.distinct(case(
            (TokenUsageLog.user_id.not_in(_excluded_user_ids), TokenUsageLog.user_id),
            else_=None,
        ))),
        func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, TokenUsageLog.total_tokens), else_=0)), 0),
        func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, _request_count_expr()), else_=0)), 0),
        # 定价覆盖：排除估算流量后，cost_cny > 0 的 token 认为"已定价"
        func.coalesce(func.sum(case((((TokenUsageLog.source != ESTIMATE_SOURCE) & (TokenUsageLog.cost_cny > 0)), TokenUsageLog.total_tokens), else_=0)), 0),
    ).where(TokenUsageLog.request_at.between(start_ts, end_ts))
    if user_filter_id is not None:
        current_base = current_base.where(TokenUsageLog.user_id == user_filter_id)
    current_stmt = _apply_source_app_filter(current_base, source_app)
    cur = await db.execute(current_stmt)
    tokens, cost, requests, users, estimated_tokens, estimated_requests, priced_tokens = cur.one()
    users_count = int(users or 0)
    exact_tokens = int(tokens) - int(estimated_tokens)
    exact_requests = int(requests) - int(estimated_requests)
    priced_tokens_val = int(priced_tokens)
    unpriced_tokens_val = int(tokens) - priced_tokens_val

    # Previous period for comparison
    prev_base = select(
        func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
        func.coalesce(func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)), 0),
    ).where(TokenUsageLog.request_at.between(prev_start_ts, start_ts - timedelta(seconds=1)))
    if user_filter_id is not None:
        prev_base = prev_base.where(TokenUsageLog.user_id == user_filter_id)
    prev_stmt = _apply_source_app_filter(prev_base, source_app)
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
        priced_tokens=max(priced_tokens_val, 0),
        unpriced_tokens=max(unpriced_tokens_val, 0),
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
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
            User.id, User.name, User.employee_id,
            func.sum(TokenUsageLog.total_tokens),
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
            func.coalesce(func.sum(_request_count_expr()), 0),
        )
        .join(User, TokenUsageLog.user_id == User.id)
        .where(
            TokenUsageLog.request_at.between(start_ts, end_ts),
            User.is_test == False,  # noqa: E712
            User.is_active == True,  # noqa: E712
        )
        .group_by(User.id, User.name, User.employee_id)
        .order_by(func.sum(TokenUsageLog.total_tokens).desc())
        .limit(limit),
        source_app,
    )
    result = await db.execute(stmt)
    items = [
        RankingItem(id=r[0], name=r[1], employee_id=r[2] or "", total_tokens=int(r[3]), cost_cny=round(float(r[4]), 2), requests=int(r[5]))
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
            func.coalesce(func.sum(_request_count_expr()), 0),
        )
        .join(User, TokenUsageLog.user_id == User.id)
        .join(Department, User.department_id == Department.id)
        .where(
            TokenUsageLog.request_at.between(start_ts, end_ts),
            User.department_id.isnot(None),
            User.is_test == False,  # noqa: E712
            User.is_active == True,  # noqa: E712
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
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
    canon_provider = provider_key_sql_case(TokenUsageLog.provider)
    stmt = _apply_source_app_filter(
        select(
            canon_provider.label("provider_key"),
            func.sum(TokenUsageLog.total_tokens),
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
        )
        .where(TokenUsageLog.request_at.between(start_ts, end_ts))
        .group_by(canon_provider)
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
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
            name=source_app_display_name(r[0]),
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
            func.sum(_billable_cost_expr(TokenUsageLog.cost_cny)),
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

    # Batch-load user/department names to avoid N+1 queries
    user_ids = {a.target_id for a in alerts if a.target_type == "user"}
    dept_ids = {a.target_id for a in alerts if a.target_type == "department"}
    user_map: dict[int, str] = {}
    dept_map: dict[int, str] = {}
    if user_ids:
        rows = await db.execute(select(User.id, User.name).where(User.id.in_(user_ids)))
        user_map = {r[0]: r[1] for r in rows}
    if dept_ids:
        rows = await db.execute(select(Department.id, Department.name).where(Department.id.in_(dept_ids)))
        dept_map = {r[0]: r[1] for r in rows}

    items = []
    for a in alerts:
        target_name = f"{a.target_type}#{a.target_id}"
        if a.target_type == "user" and a.target_id in user_map:
            target_name = user_map[a.target_id]
        elif a.target_type == "department" and a.target_id in dept_map:
            target_name = dept_map[a.target_id]
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
            TokenUsageLog.total_tokens, _billable_cost_expr(TokenUsageLog.cost_cny),
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


@router.get("/admin/unpriced-models", dependencies=[Depends(require_admin)])
async def get_unpriced_models(
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """返回有流量但未配置定价的模型列表，按 token 消耗降序。"""
    tz = dashboard_tz()
    now = datetime.now(tz)
    start = datetime.combine(now.date() - timedelta(days=days - 1), dt_time.min, tzinfo=tz)

    priced_q = select(ModelPricing.model_name).where(ModelPricing.effective_to.is_(None))
    priced_rows = await db.execute(priced_q)
    priced_models = {r[0] for r in priced_rows.all()}

    usage_q = (
        select(
            TokenUsageLog.model_name,
            func.sum(func.coalesce(TokenUsageLog.total_tokens, 0)).label("total_tokens"),
            func.count().label("requests"),
        )
        .where(TokenUsageLog.request_at >= start)
        .where(TokenUsageLog.source != ESTIMATE_SOURCE)
        .group_by(TokenUsageLog.model_name)
        .order_by(func.sum(func.coalesce(TokenUsageLog.total_tokens, 0)).desc())
    )
    rows = await db.execute(usage_q)
    result = []
    for r in rows.all():
        model = r[0] or "unknown"
        # 前缀匹配检查（与 pricing.py 的 calc_cost_usd 一致）
        is_priced = model in priced_models or any(
            model.startswith(p) for p in priced_models
        )
        if not is_priced:
            result.append({
                "model": model,
                "total_tokens": int(r[1]),
                "requests": int(r[2]),
            })
    return result


@router.post("/admin/merge-users", dependencies=[Depends(require_admin)])
async def merge_users(
    source_employee_id: str = Query(..., description="被合并的用户工号（数据迁移到目标用户后停用）"),
    target_employee_id: str = Query(..., description="目标用户工号（保留）"),
    db: AsyncSession = Depends(get_db),
):
    """将源用户的所有 token_usage_logs 迁移到目标用户，然后停用源用户。"""
    from sqlalchemy import update as sa_update

    src_row = await db.execute(select(User).where(User.employee_id == source_employee_id.strip()))
    src_user = src_row.scalar_one_or_none()
    if not src_user:
        raise HTTPException(404, f"源用户 {source_employee_id} 不存在")

    tgt_row = await db.execute(select(User).where(User.employee_id == target_employee_id.strip()))
    tgt_user = tgt_row.scalar_one_or_none()
    if not tgt_user:
        raise HTTPException(404, f"目标用户 {target_employee_id} 不存在")

    if src_user.id == tgt_user.id:
        raise HTTPException(400, "源用户和目标用户相同")

    # 迁移 token_usage_logs
    result = await db.execute(
        sa_update(TokenUsageLog)
        .where(TokenUsageLog.user_id == src_user.id)
        .values(user_id=tgt_user.id)
    )
    migrated = result.rowcount or 0

    # 停用源用户
    src_user.is_active = False
    await db.commit()

    return {
        "status": "ok",
        "migrated_records": migrated,
        "source": {"employee_id": src_user.employee_id, "name": src_user.name, "is_active": False},
        "target": {"employee_id": tgt_user.employee_id, "name": tgt_user.name},
    }


@router.patch("/admin/users/{employee_id}", dependencies=[Depends(require_admin)])
async def update_user_flags(
    employee_id: str,
    is_test: bool | None = Query(None, description="标记为测试用户"),
    db: AsyncSession = Depends(get_db),
):
    """管理接口：更新用户标记（如 is_test）。"""
    row = await db.execute(select(User).where(User.employee_id == employee_id.strip()))
    user = row.scalar_one_or_none()
    if not user:
        raise HTTPException(404, f"用户 {employee_id} 不存在")

    if is_test is not None:
        user.is_test = is_test

    await db.commit()
    return {
        "employee_id": user.employee_id,
        "name": user.name,
        "is_test": user.is_test,
        "is_active": user.is_active,
    }
