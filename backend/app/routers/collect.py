"""
Data collection endpoints for client-reported AI token usage.
Receives batched usage records from the Go client applications.
"""

import hashlib
from datetime import date, datetime, time as dt_time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.canonical import dashboard_tz, source_app_display_name
from app.config import settings
from app.database import get_db
from app.models import Client, Department, ModelPricing, TokenUsageLog, User
from app.pricing import calc_cost_usd
from app.schemas import TokscaleSubmitRequest

router = APIRouter(prefix="/api", tags=["collect"])

# ── Schemas ──────────────────────────────────────────────────

class UsageRecordIn(BaseModel):
    client_id: str
    user_name: str
    user_id: str
    department: str | None = None
    source: str | None = None
    model: str
    vendor: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    request_time: str
    request_id: str | None = None
    source_app: str | None = None
    endpoint: str | None = None


class IdentityCheckResponse(BaseModel):
    status: str
    message: str
    existing_name: str | None = None
    other_employee_ids: list[str] = []
    known_apps: list[str] = []


class ClientHeartbeatIn(BaseModel):
    client_id: str
    user_name: str
    user_id: str
    department: str | None = None
    hostname: str | None = None
    version: str | None = None


class MyStatsResponse(BaseModel):
    today_tokens: int
    today_requests: int


class MyDailyUsagePoint(BaseModel):
    date: str
    total_tokens: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    cost_cny: float
    requests: int
    exact_tokens: int = 0
    estimated_tokens: int = 0
    exact_requests: int = 0
    estimated_requests: int = 0


class MyDailyUsageResponse(BaseModel):
    points: list[MyDailyUsagePoint]
    total_tokens: int
    total_cost_usd: float
    total_cost_cny: float
    total_requests: int
    exact_tokens: int = 0
    estimated_tokens: int = 0
    exact_requests: int = 0
    estimated_requests: int = 0


class IdentityConflictError(Exception):
    def __init__(self, employee_id: str, existing_name: str, provided_name: str):
        self.employee_id = employee_id
        self.existing_name = existing_name
        self.provided_name = provided_name
        super().__init__(
            f"employee_id={employee_id!r} already belongs to {existing_name!r}, got {provided_name!r}"
        )


# ── Pricing cache (plain dicts to avoid DetachedInstanceError) ──

_pricing_cache: dict[str, tuple[float, float]] = {}  # model_name → (input_price, output_price)
_pricing_cache_ts: datetime | None = None


async def _get_pricing(db: AsyncSession) -> dict[str, tuple[float, float]]:
    global _pricing_cache, _pricing_cache_ts
    now = datetime.now(timezone.utc)
    if _pricing_cache_ts and (now - _pricing_cache_ts).total_seconds() < 300:
        return _pricing_cache

    result = await db.execute(select(ModelPricing).where(ModelPricing.effective_to.is_(None)))
    _pricing_cache = {
        p.model_name: (float(p.input_price_per_1k), float(p.output_price_per_1k))
        for p in result.scalars().all()
    }
    _pricing_cache_ts = now
    return _pricing_cache



# ── User cache ───────────────────────────────────────────────

_user_cache: dict[str, int] = {}  # employee_id → user.id
_dept_cache: dict[str, int] = {}  # department name → department.id


def _normalize_identity_value(value: str | None) -> str:
    return (value or "").strip()


def _normalize_department_value(value: str | None) -> str | None:
    normalized = (value or "").strip()
    return normalized or None


def _normalize_person_name(value: str | None) -> str:
    return "".join((value or "").split()).casefold()


def _has_complete_identity(user_id: str | None, user_name: str | None) -> bool:
    return bool(_normalize_identity_value(user_id) and _normalize_identity_value(user_name))


def _same_person_name(left: str | None, right: str | None) -> bool:
    normalized_left = _normalize_person_name(left)
    normalized_right = _normalize_person_name(right)
    return bool(normalized_left and normalized_right and normalized_left == normalized_right)



def _raise_identity_conflict(exc: IdentityConflictError) -> None:
    raise HTTPException(
        status_code=409,
        detail={
            "code": "identity_conflict",
            "employee_id": exc.employee_id,
            "existing_name": exc.existing_name,
            "provided_name": exc.provided_name,
            "message": f"工号 {exc.employee_id} 已绑定姓名“{exc.existing_name}”，与当前填写的“{exc.provided_name}”不一致。",
        },
    )


def _safe_non_negative_int(value: int | None) -> int:
    return max(int(value or 0), 0)


def _sum_tokscale_tokens(tokens) -> int:
    return (
        _safe_non_negative_int(tokens.input)
        + _safe_non_negative_int(tokens.output)
        + _safe_non_negative_int(tokens.cacheRead)
        + _safe_non_negative_int(tokens.cacheWrite)
        + _safe_non_negative_int(tokens.reasoning)
    )


def _tokscale_input_tokens(tokens) -> int:
    """input + cacheRead + cacheWrite (all input-side tokens)"""
    return (
        _safe_non_negative_int(tokens.input)
        + _safe_non_negative_int(tokens.cacheRead)
        + _safe_non_negative_int(tokens.cacheWrite)
    )


def _tokscale_output_tokens(tokens) -> int:
    """output + reasoning (all output-side tokens)"""
    return (
        _safe_non_negative_int(tokens.output)
        + _safe_non_negative_int(tokens.reasoning)
    )



def _tokscale_request_at(day: str, timestamp_ms: int | None) -> datetime:
    if timestamp_ms:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)

    local_date = date.fromisoformat(day)
    local_midday = datetime.combine(local_date, dt_time(hour=12), tzinfo=dashboard_tz())
    return local_midday.astimezone(timezone.utc)


def _tokscale_range(day_start: str, day_end: str) -> tuple[datetime, datetime]:
    tz = dashboard_tz()
    start_date = date.fromisoformat(day_start)
    end_date = date.fromisoformat(day_end)
    start_ts = datetime.combine(start_date, dt_time.min, tzinfo=tz).astimezone(timezone.utc)
    end_ts = datetime.combine(end_date, dt_time(23, 59, 59, 999999), tzinfo=tz).astimezone(timezone.utc)
    return start_ts, end_ts


def _build_tokscale_request_id(user_id: str, day: str, client: str, provider: str | None, model: str) -> str:
    raw = f"{user_id}|{day}|{client}|{provider or ''}|{model}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]
    return f"ts:{day}:{digest}"


async def _get_existing_user_by_employee_id(db: AsyncSession, employee_id: str) -> User | None:
    result = await db.execute(
        select(User).where(User.employee_id == employee_id)
    )
    return result.scalar_one_or_none()


async def _get_same_name_employee_ids(db: AsyncSession, name: str, exclude_employee_id: str) -> list[str]:
    normalized_name = _normalize_identity_value(name)
    if not normalized_name:
        return []

    result = await db.execute(
        select(User.employee_id)
        .where(User.name == normalized_name, User.employee_id != exclude_employee_id)
        .order_by(User.employee_id)
        .limit(3)
    )
    return [row[0] for row in result.all() if row[0]]


async def _get_known_apps_for_user(db: AsyncSession, internal_user_id: int) -> list[str]:
    result = await db.execute(
        select(TokenUsageLog.source_app)
        .where(
            TokenUsageLog.user_id == internal_user_id,
            TokenUsageLog.source_app.isnot(None),
            TokenUsageLog.source_app != "",
        )
        .distinct()
        .order_by(TokenUsageLog.source_app)
    )
    known_apps: list[str] = []
    for (source_app,) in result.all():
        display_name = source_app_display_name(source_app)
        if display_name not in known_apps:
            known_apps.append(display_name)
    return known_apps[:5]


async def _get_or_create_department(db: AsyncSession, name: str | None) -> int | None:
    normalized = (name or "").strip()
    if not normalized:
        return None

    if normalized in _dept_cache:
        cached_department = await db.get(Department, _dept_cache[normalized])
        if cached_department:
            return cached_department.id
        _dept_cache.pop(normalized, None)

    result = await db.execute(
        select(Department).where(Department.name == normalized)
    )
    department = result.scalar_one_or_none()
    if department:
        _dept_cache[normalized] = department.id
        return department.id

    department = Department(name=normalized)
    db.add(department)
    await db.flush()
    _dept_cache[normalized] = department.id
    return department.id


async def _get_or_create_user(db: AsyncSession, employee_id: str, name: str, department: str | None) -> int:
    normalized_employee_id = _normalize_identity_value(employee_id)
    normalized_name = _normalize_identity_value(name)
    department_id = await _get_or_create_department(db, department)

    if normalized_employee_id in _user_cache:
        cached_user = await db.get(User, _user_cache[normalized_employee_id])
        if cached_user:
            if normalized_name and not _same_person_name(cached_user.name, normalized_name):
                cached_user.name = normalized_name
            if department_id != cached_user.department_id:
                cached_user.department_id = department_id
            await db.flush()
            return cached_user.id
        _user_cache.pop(normalized_employee_id, None)

    user = await _get_existing_user_by_employee_id(db, normalized_employee_id)
    if user:
        if normalized_name and not _same_person_name(user.name, normalized_name):
            user.name = normalized_name
        if department_id != user.department_id:
            user.department_id = department_id
        await db.flush()
        _user_cache[normalized_employee_id] = user.id
        return user.id

    user = User(
        employee_id=normalized_employee_id,
        name=normalized_name,
        department_id=department_id,
    )
    db.add(user)
    await db.flush()
    _user_cache[normalized_employee_id] = user.id
    return user.id


async def _upsert_client_presence(
    db: AsyncSession,
    *,
    client_id: str,
    user_name: str,
    user_id: str,
    department: str | None,
    hostname: str | None,
    version: str | None,
    ip_address: str | None,
) -> None:
    result = await db.execute(
        select(Client).where(Client.client_id == client_id)
    )
    client = result.scalar_one_or_none()

    if client:
        await db.execute(
            update(Client)
            .where(Client.client_id == client_id)
            .values(
                last_seen=datetime.now(timezone.utc),
                ip_address=ip_address,
                version=version,
                user_name=user_name,
                user_id=user_id,
                department=department,
                hostname=hostname,
            )
        )
        return

    db.add(Client(
        client_id=client_id,
        user_name=user_name,
        user_id=user_id,
        department=department,
        hostname=hostname,
        ip_address=ip_address,
        version=version,
        last_seen=datetime.now(timezone.utc),
    ))


@router.get("/clients/identity-check", response_model=IdentityCheckResponse)
async def identity_check(
    user_id: str,
    user_name: str,
    department: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    normalized_user_id = _normalize_identity_value(user_id)
    normalized_user_name = _normalize_identity_value(user_name)

    if not _has_complete_identity(normalized_user_id, normalized_user_name):
        return IdentityCheckResponse(
            status="incomplete",
            message="填写工号和姓名后会自动检查是否与服务器已有身份冲突。同一工号可在 VS Code、Cursor、PowerShell 等多个应用共用。",
        )

    user = await _get_existing_user_by_employee_id(db, normalized_user_id)
    other_employee_ids = await _get_same_name_employee_ids(db, normalized_user_name, normalized_user_id)

    if not user:
        message = "服务器暂无该工号记录，将按新用户创建。"
        if other_employee_ids:
            message += f" 检测到同名工号：{'、'.join(other_employee_ids)}，请再确认一下编号。"
        message += " 同一工号可在多个应用共用。"
        return IdentityCheckResponse(
            status="warning" if other_employee_ids else "new",
            message=message,
            other_employee_ids=other_employee_ids,
        )

    known_apps = await _get_known_apps_for_user(db, user.id)
    if not _same_person_name(user.name, normalized_user_name):
        message = f"该工号已绑定姓名“{user.name}”，与当前填写的“{normalized_user_name}”不一致。为避免串号，当前配置不会写入服务器。"
        if known_apps:
            message += f" 该工号已记录应用：{'、'.join(known_apps)}。"
        return IdentityCheckResponse(
            status="conflict",
            message=message,
            existing_name=user.name,
            known_apps=known_apps,
        )

    message = "服务器已存在该工号且姓名一致，可继续在多个应用共用。"
    if known_apps:
        message += f" 已记录应用：{'、'.join(known_apps)}。"
    if other_employee_ids:
        message += f" 另外检测到同名工号：{'、'.join(other_employee_ids)}，请确认当前编号无误。"
        return IdentityCheckResponse(
            status="warning",
            message=message,
            existing_name=user.name,
            other_employee_ids=other_employee_ids,
            known_apps=known_apps,
        )

    return IdentityCheckResponse(
        status="matched",
        message=message,
        existing_name=user.name,
        known_apps=known_apps,
    )


# ── Endpoints ────────────────────────────────────────────────

@router.post("/collect")
async def collect_usage(records: list[UsageRecordIn], db: AsyncSession = Depends(get_db)):
    """Receive batched token usage records from client applications."""
    if not records:
        return {"status": "ok", "inserted": 0}

    pricing = await _get_pricing(db)
    inserted = 0
    skipped_duplicates = 0
    request_ids = [rec.request_id for rec in records if rec.request_id]
    existing_pairs: set[tuple[str, str]] = set()

    if request_ids:
        result = await db.execute(
            select(TokenUsageLog.request_id, TokenUsageLog.source)
            .where(TokenUsageLog.request_id.in_(request_ids))
        )
        existing_pairs = {
            (request_id, source)
            for request_id, source in result.all()
            if request_id and source
        }

    for rec in records:
        source = rec.source or "client"
        if rec.request_id and (rec.request_id, source) in existing_pairs:
            skipped_duplicates += 1
            continue

        try:
            user_id = await _get_or_create_user(db, rec.user_id, rec.user_name, rec.department)
        except IdentityConflictError as exc:
            _raise_identity_conflict(exc)

        # 估算流量（gRPC/二进制体积粗算）不计入成本，避免虚报费用。
        # 精确来源（client / gateway 等）正常计算成本。
        if source == "client-mitm-estimate":
            cost_usd = 0.0
            cost_cny = 0.0
        else:
            cost_usd = calc_cost_usd(pricing, rec.model, rec.prompt_tokens, rec.completion_tokens)
            cost_cny = round(cost_usd * settings.USD_TO_CNY, 4)

        try:
            request_at = datetime.fromisoformat(rec.request_time.replace("Z", "+00:00"))
        except ValueError:
            request_at = datetime.now(timezone.utc)

        log_entry = TokenUsageLog(
            user_id=user_id,
            model_name=rec.model,
            provider=rec.vendor,
            source=source,
            source_app=(rec.source_app or "").strip() or None,
            endpoint=(rec.endpoint or "").strip() or None,
            input_tokens=rec.prompt_tokens,
            output_tokens=rec.completion_tokens,
            total_tokens=rec.total_tokens,
            request_count=1,
            cost_usd=cost_usd,
            cost_cny=cost_cny,
            request_id=rec.request_id,
            request_at=request_at,
        )
        db.add(log_entry)
        inserted += 1
        if rec.request_id:
            existing_pairs.add((rec.request_id, source))

    await db.commit()
    return {"status": "ok", "inserted": inserted, "skipped_duplicates": skipped_duplicates}


@router.post("/collect/tokscale")
async def collect_tokscale_usage(
    data: TokscaleSubmitRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    contributions = data.payload.contributions
    if not contributions:
        return {"status": "ok", "inserted": 0, "replaced": 0, "sources": []}

    normalized_user_id = _normalize_identity_value(data.user_id)
    normalized_user_name = _normalize_identity_value(data.user_name)
    normalized_department = _normalize_department_value(data.department)
    if not _has_complete_identity(normalized_user_id, normalized_user_name):
        raise HTTPException(status_code=400, detail="missing_identity")

    try:
        internal_user_id = await _get_or_create_user(db, normalized_user_id, normalized_user_name, normalized_department)
    except IdentityConflictError as exc:
        _raise_identity_conflict(exc)

    ip = request.client.host if request.client else None
    await _upsert_client_presence(
        db,
        client_id=data.client_id,
        user_name=normalized_user_name,
        user_id=normalized_user_id,
        department=normalized_department,
        hostname=data.hostname,
        version=data.version,
        ip_address=ip,
    )

    submitted_clients = sorted({
        client.client.strip()
        for contribution in contributions
        for client in contribution.clients
        if client.client and client.client.strip()
    })
    range_start = data.payload.meta.dateRange.start
    range_end = data.payload.meta.dateRange.end
    start_ts, end_ts = _tokscale_range(range_start, range_end)

    delete_stmt = delete(TokenUsageLog).where(
        TokenUsageLog.user_id == internal_user_id,
        TokenUsageLog.source == "tokscale",
        TokenUsageLog.request_at.between(start_ts, end_ts),
    )
    if submitted_clients:
        delete_stmt = delete_stmt.where(TokenUsageLog.source_app.in_(submitted_clients))
    delete_result = await db.execute(delete_stmt)
    replaced = delete_result.rowcount or 0

    inserted = 0
    for contribution in contributions:
        request_at = _tokscale_request_at(contribution.date, contribution.timestampMs)
        single_client_fallback = len(contribution.clients) == 1

        for client_contrib in contribution.clients:
            source_app = client_contrib.client.strip() or "unknown-app"
            provider = (client_contrib.providerId or "").strip() or "unknown"
            model = client_contrib.modelId.strip()
            total_tokens = _sum_tokscale_tokens(client_contrib.tokens)
            request_count = _safe_non_negative_int(client_contrib.messages)
            if request_count == 0 and single_client_fallback:
                request_count = _safe_non_negative_int(contribution.totals.messages)

            db.add(TokenUsageLog(
                user_id=internal_user_id,
                model_name=model,
                provider=provider,
                source="tokscale",
                source_app=source_app,
                endpoint=None,
                input_tokens=_tokscale_input_tokens(client_contrib.tokens),
                output_tokens=_tokscale_output_tokens(client_contrib.tokens),
                total_tokens=total_tokens,
                request_count=request_count,
                cost_usd=round(max(float(client_contrib.cost or 0.0), 0.0), 6),
                cost_cny=round(max(float(client_contrib.cost or 0.0), 0.0) * settings.USD_TO_CNY, 4),
                request_id=_build_tokscale_request_id(normalized_user_id, contribution.date, source_app, provider, model),
                request_at=request_at,
            ))
            inserted += 1

    await db.commit()
    return {
        "status": "ok",
        "inserted": inserted,
        "replaced": replaced,
        "sources": submitted_clients,
        "date_range": {"start": range_start, "end": range_end},
    }


@router.post("/clients/heartbeat")
async def client_heartbeat(
    data: ClientHeartbeatIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Register or update a client's online status."""
    normalized_user_id = _normalize_identity_value(data.user_id)
    normalized_user_name = _normalize_identity_value(data.user_name)
    normalized_department = _normalize_department_value(data.department)

    if not _has_complete_identity(normalized_user_id, normalized_user_name):
        return {"status": "ignored", "reason": "missing_identity"}

    ip = request.client.host if request.client else None

    try:
        await _get_or_create_user(db, normalized_user_id, normalized_user_name, normalized_department)
    except IdentityConflictError as exc:
        _raise_identity_conflict(exc)

    result = await db.execute(
        select(Client).where(Client.client_id == data.client_id)
    )
    client = result.scalar_one_or_none()

    if client:
        await db.execute(
            update(Client)
            .where(Client.client_id == data.client_id)
            .values(
                last_seen=datetime.now(timezone.utc),
                ip_address=ip,
                version=data.version,
                user_name=normalized_user_name,
                user_id=normalized_user_id,
                department=normalized_department,
                hostname=data.hostname,
            )
        )
    else:
        client = Client(
            client_id=data.client_id,
            user_name=normalized_user_name,
            user_id=normalized_user_id,
            department=normalized_department,
            hostname=data.hostname,
            ip_address=ip,
            version=data.version,
            last_seen=datetime.now(timezone.utc),
        )
        db.add(client)

    await db.commit()
    return {"status": "ok"}


from app.routers.dashboard import ESTIMATE_SOURCE, _request_local_date_column, _ts_range

@router.get("/clients/my-stats", response_model=MyStatsResponse)
async def get_my_stats(
    user_id: str,
    user_name: str,
    department: str | None = None,
    days: int = Query(1, ge=1, le=365),
    db: AsyncSession = Depends(get_db)
):
    normalized_user_id = _normalize_identity_value(user_id)
    normalized_user_name = _normalize_identity_value(user_name)
    normalized_department = _normalize_department_value(department)

    if not _has_complete_identity(normalized_user_id, normalized_user_name):
        return MyStatsResponse(today_tokens=0, today_requests=0)

    try:
        internal_user_id = await _get_or_create_user(db, normalized_user_id, normalized_user_name, normalized_department)
    except IdentityConflictError as exc:
        _raise_identity_conflict(exc)
    await db.commit()
    start_ts, end_ts = _ts_range(days)
    
    stmt = select(
        func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
        func.coalesce(func.sum(func.coalesce(TokenUsageLog.request_count, 1)), 0),
    ).where(
        TokenUsageLog.user_id == internal_user_id,
        TokenUsageLog.request_at.between(start_ts, end_ts)
    )
    result = await db.execute(stmt)
    row = result.first()
    today_tokens = int(row[0]) if row else 0
    today_requests = int(row[1]) if row else 0

    return MyStatsResponse(today_tokens=int(today_tokens), today_requests=int(today_requests))


@router.get("/clients/my-daily-usage", response_model=MyDailyUsageResponse)
async def get_my_daily_usage(
    user_id: str,
    user_name: str,
    department: str | None = None,
    days: int = Query(30, ge=1, le=365),
    start_date: date | None = None,
    end_date: date | None = None,
    include_tokscale: bool = False,
    db: AsyncSession = Depends(get_db),
):
    normalized_user_id = _normalize_identity_value(user_id)
    normalized_user_name = _normalize_identity_value(user_name)
    normalized_department = _normalize_department_value(department)

    if not _has_complete_identity(normalized_user_id, normalized_user_name):
        return MyDailyUsageResponse(
            points=[],
            total_tokens=0,
            total_cost_usd=0.0,
            total_cost_cny=0.0,
            total_requests=0,
        )

    try:
        internal_user_id = await _get_or_create_user(db, normalized_user_id, normalized_user_name, normalized_department)
    except IdentityConflictError as exc:
        _raise_identity_conflict(exc)
    await db.commit()

    start_ts, end_ts = _ts_range(days, start_date, end_date)
    local_day = _request_local_date_column()
    request_count_expr = func.coalesce(TokenUsageLog.request_count, 1)

    stmt = (
        select(
            local_day.label("d"),
            func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
            func.coalesce(func.sum(TokenUsageLog.input_tokens), 0),
            func.coalesce(func.sum(TokenUsageLog.output_tokens), 0),
            func.coalesce(func.sum(TokenUsageLog.cost_usd), 0),
            func.coalesce(func.sum(TokenUsageLog.cost_cny), 0),
            func.coalesce(func.sum(request_count_expr), 0),
            func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, TokenUsageLog.total_tokens), else_=0)), 0),
            func.coalesce(func.sum(case((TokenUsageLog.source == ESTIMATE_SOURCE, request_count_expr), else_=0)), 0),
        )
        .where(
            TokenUsageLog.user_id == internal_user_id,
            TokenUsageLog.request_at.between(start_ts, end_ts),
        )
        .group_by(local_day)
        .order_by(local_day)
    )
    if not include_tokscale:
        stmt = stmt.where(TokenUsageLog.source != "tokscale")

    result = await db.execute(stmt)
    points: list[MyDailyUsagePoint] = []
    total_tokens = 0
    total_cost_usd = 0.0
    total_cost_cny = 0.0
    total_requests = 0
    exact_tokens = 0
    estimated_tokens = 0
    exact_requests = 0
    estimated_requests = 0

    for row in result.all():
        day, day_total_tokens, input_tokens, output_tokens, cost_usd, cost_cny, requests, day_estimated_tokens, day_estimated_requests = row
        day_total_tokens = int(day_total_tokens or 0)
        day_requests = int(requests or 0)
        day_estimated_tokens = int(day_estimated_tokens or 0)
        day_estimated_requests = int(day_estimated_requests or 0)
        day_exact_tokens = max(day_total_tokens - day_estimated_tokens, 0)
        day_exact_requests = max(day_requests - day_estimated_requests, 0)

        points.append(MyDailyUsagePoint(
            date=day.isoformat(),
            total_tokens=day_total_tokens,
            input_tokens=int(input_tokens or 0),
            output_tokens=int(output_tokens or 0),
            cost_usd=round(float(cost_usd or 0), 6),
            cost_cny=round(float(cost_cny or 0), 4),
            requests=day_requests,
            exact_tokens=day_exact_tokens,
            estimated_tokens=day_estimated_tokens,
            exact_requests=day_exact_requests,
            estimated_requests=day_estimated_requests,
        ))

        total_tokens += day_total_tokens
        total_cost_usd += float(cost_usd or 0)
        total_cost_cny += float(cost_cny or 0)
        total_requests += day_requests
        exact_tokens += day_exact_tokens
        estimated_tokens += day_estimated_tokens
        exact_requests += day_exact_requests
        estimated_requests += day_estimated_requests

    return MyDailyUsageResponse(
        points=points,
        total_tokens=total_tokens,
        total_cost_usd=round(total_cost_usd, 6),
        total_cost_cny=round(total_cost_cny, 4),
        total_requests=total_requests,
        exact_tokens=exact_tokens,
        estimated_tokens=estimated_tokens,
        exact_requests=exact_requests,
        estimated_requests=estimated_requests,
    )


@router.get("/clients/online")
async def get_online_clients(db: AsyncSession = Depends(get_db)):
    """Return count of clients seen recently (last_seen within window).

    使用 15 分钟窗口：客户端心跳约每 30s 一次，避免短暂网络抖动或大屏刷新间隔导致误显示 0 在线。
    """
    threshold = datetime.now(timezone.utc) - timedelta(minutes=15)
    result = await db.execute(
        select(func.count()).select_from(Client).where(Client.last_seen >= threshold)
    )
    count = result.scalar()

    # Also return full client list
    result = await db.execute(
        select(Client).order_by(Client.last_seen.desc())
    )
    clients = result.scalars().all()

    return {
        "online_count": count,
        "clients": [
            {
                "client_id": c.client_id,
                "user_name": c.user_name,
                "user_id": c.user_id,
                "department": c.department,
                "hostname": c.hostname,
                "version": c.version,
                "last_seen": c.last_seen.isoformat() if c.last_seen else None,
                "is_online": c.last_seen and c.last_seen >= threshold,
            }
            for c in clients
        ],
    }
