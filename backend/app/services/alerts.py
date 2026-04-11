"""告警服务：检测配额超限和异常突增。"""

import logging
from datetime import date, timedelta, datetime, timezone

import httpx
from sqlalchemy import Date as SADate, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.canonical import dashboard_tz
from app.config import settings
from app.database import async_session
from app.models import Alert, DailyUsageSummary, Department, User

logger = logging.getLogger(__name__)


def _tz_today() -> date:
    return datetime.now(dashboard_tz()).date()


def _month_start_local() -> date:
    t = _tz_today()
    return t.replace(day=1)


def _alert_created_local_date():
    return cast(func.timezone(settings.DASHBOARD_TIMEZONE, Alert.created_at), SADate)


async def check_alerts():
    """检查配额超限和异常突增，生成告警。"""
    async with async_session() as db:
        await _check_user_quota(db)
        await _check_department_budget(db)
        await _check_spike(db)
        await db.commit()


async def _check_user_quota(db: AsyncSession):
    """检查用户日/月配额。"""
    month_start = _month_start_local()

    users = await db.execute(
        select(User).where(User.is_active.is_(True), User.quota_monthly > 0)
    )
    for user in users.scalars().all():
        result = await db.execute(
            select(func.coalesce(func.sum(DailyUsageSummary.total_tokens), 0))
            .where(
                DailyUsageSummary.user_id == user.id,
                DailyUsageSummary.date >= month_start,
            )
        )
        monthly_usage = result.scalar() or 0

        if user.quota_monthly and monthly_usage > user.quota_monthly:
            await _create_alert(
                db, "quota_exceeded", "user", user.id,
                f"{user.name} 本月 Token 消耗 {monthly_usage:,} 已超过配额 {user.quota_monthly:,}",
                user.quota_monthly, monthly_usage,
            )


async def _check_department_budget(db: AsyncSession):
    """检查部门月度预算。"""
    month_start = _month_start_local()

    depts = await db.execute(select(Department).where(Department.budget_monthly > 0))
    for dept in depts.scalars().all():
        result = await db.execute(
            select(func.coalesce(func.sum(DailyUsageSummary.total_tokens), 0))
            .where(
                DailyUsageSummary.department_id == dept.id,
                DailyUsageSummary.date >= month_start,
            )
        )
        usage = result.scalar() or 0
        if usage > dept.budget_monthly:
            await _create_alert(
                db, "budget_exceeded", "department", dept.id,
                f"部门 {dept.name} 本月 Token 消耗 {usage:,} 已超过预算 {dept.budget_monthly:,}",
                dept.budget_monthly, usage,
            )


async def _check_spike(db: AsyncSession):
    """检查 Token 消耗突增（日环比超过 300%，即当日 > 前一日 × 3）。"""
    today = _tz_today()
    yesterday = today - timedelta(days=1)
    day_before = today - timedelta(days=2)

    result = await db.execute(
        select(
            DailyUsageSummary.user_id,
            DailyUsageSummary.date,
            func.sum(DailyUsageSummary.total_tokens),
        )
        .where(DailyUsageSummary.date.in_([yesterday, day_before]))
        .group_by(DailyUsageSummary.user_id, DailyUsageSummary.date)
    )
    user_daily = {}
    for row in result.all():
        uid, d, tokens = row
        user_daily.setdefault(uid, {})[d] = int(tokens)

    for uid, daily in user_daily.items():
        prev = daily.get(day_before, 0)
        curr = daily.get(yesterday, 0)
        if prev > 0 and curr > prev * 3:
            user = await db.get(User, uid)
            name = user.name if user else f"user#{uid}"
            await _create_alert(
                db, "spike", "user", uid,
                f"{name} Token 消耗突增：{day_before} 为 {prev:,}，{yesterday} 为 {curr:,}（+{round((curr-prev)/prev*100)}%）",
                prev, curr,
            )


async def _create_alert(
    db: AsyncSession, alert_type: str, target_type: str, target_id: int,
    message: str, threshold: int, actual: int,
):
    existing = await db.execute(
        select(Alert).where(
            Alert.alert_type == alert_type,
            Alert.target_type == target_type,
            Alert.target_id == target_id,
            _alert_created_local_date() == _tz_today(),
        ).limit(1)
    )
    if existing.scalars().first():
        return

    alert = Alert(
        alert_type=alert_type,
        target_type=target_type,
        target_id=target_id,
        message=message,
        threshold_value=threshold,
        actual_value=actual,
    )
    db.add(alert)
    await db.flush()

    await _send_webhook(message)
    alert.notified_at = datetime.now(timezone.utc)


async def _send_webhook(message: str):
    """发送告警到企微/钉钉/飞书 Webhook。"""
    if not settings.ALERT_WEBHOOK_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                settings.ALERT_WEBHOOK_URL,
                json={"msgtype": "text", "text": {"content": f"[AI Token 告警] {message}"}},
            )
    except Exception:
        logger.exception("发送告警 Webhook 失败")
