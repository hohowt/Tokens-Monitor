"""每日聚合 ETL：从 token_usage_logs 聚合到 daily_usage_summary。"""

import logging
from datetime import date, timedelta, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import Date, cast, func, select
from sqlalchemy.dialects.postgresql import insert

from app.config import settings
from app.database import async_session
from app.models import DailyUsageSummary, TokenUsageLog

logger = logging.getLogger(__name__)


def _dashboard_yesterday() -> date:
    tz = ZoneInfo(settings.DASHBOARD_TIMEZONE)
    return (datetime.now(tz) - timedelta(days=1)).date()


async def aggregate_daily(target_date: date | None = None):
    """聚合指定日期的 Token 消耗数据到 daily_usage_summary。"""
    if target_date is None:
        target_date = _dashboard_yesterday()

    local_day = cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), Date)
    model_coal = func.coalesce(TokenUsageLog.model_name, "")
    prov_coal = func.coalesce(TokenUsageLog.provider, "")

    async with async_session() as db:
        result = await db.execute(
            select(
                TokenUsageLog.user_id,
                TokenUsageLog.project_id,
                model_coal.label("model_name"),
                prov_coal.label("provider"),
                TokenUsageLog.department_id,
                func.coalesce(func.sum(TokenUsageLog.request_count), 0).label("total_requests"),
                func.sum(TokenUsageLog.input_tokens).label("input_tokens"),
                func.sum(TokenUsageLog.output_tokens).label("output_tokens"),
                func.sum(TokenUsageLog.total_tokens).label("total_tokens"),
                func.sum(TokenUsageLog.cost_usd).label("cost_usd"),
                func.sum(TokenUsageLog.cost_cny).label("cost_cny"),
            )
            .where(local_day == target_date, TokenUsageLog.user_id.isnot(None))
            .group_by(
                TokenUsageLog.user_id,
                TokenUsageLog.project_id,
                model_coal,
                prov_coal,
                TokenUsageLog.department_id,
            )
        )

        rows = result.all()
        if not rows:
            logger.info(f"日期 {target_date} 无数据需要聚合")
            return

        for row in rows:
            proj_key = row.project_id if row.project_id is not None else -1
            dept_key = row.department_id if row.department_id is not None else -1
            stmt = insert(DailyUsageSummary).values(
                date=target_date,
                user_id=row.user_id,
                project_id=row.project_id,
                proj_key=proj_key,
                dept_key=dept_key,
                department_id=row.department_id,
                model_name=row.model_name or "",
                provider=row.provider or "",
                total_requests=row.total_requests,
                input_tokens=int(row.input_tokens or 0),
                output_tokens=int(row.output_tokens or 0),
                total_tokens=int(row.total_tokens or 0),
                cost_usd=float(row.cost_usd or 0),
                cost_cny=float(row.cost_cny or 0),
            ).on_conflict_do_update(
                index_elements=["date", "user_id", "proj_key", "model_name", "provider", "dept_key"],
                set_={
                    "total_requests": row.total_requests,
                    "input_tokens": int(row.input_tokens or 0),
                    "output_tokens": int(row.output_tokens or 0),
                    "total_tokens": int(row.total_tokens or 0),
                    "cost_usd": float(row.cost_usd or 0),
                    "cost_cny": float(row.cost_cny or 0),
                    "project_id": row.project_id,
                    "department_id": row.department_id,
                },
            )
            await db.execute(stmt)

        await db.commit()
        logger.info(f"聚合完成：{target_date}，{len(rows)} 条记录")
