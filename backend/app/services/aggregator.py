"""每日聚合 ETL：从 token_usage_logs 聚合到 daily_usage_summary。"""

import logging
from datetime import date, timedelta, datetime, timezone

from sqlalchemy import Date, cast, func, select, text
from sqlalchemy.dialects.postgresql import insert

from app.config import settings
from app.database import async_session
from app.models import DailyUsageSummary, TokenUsageLog, User

logger = logging.getLogger(__name__)


async def aggregate_daily(target_date: date | None = None):
    """聚合指定日期的 Token 消耗数据到 daily_usage_summary。"""
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    local_day = cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), Date)

    async with async_session() as db:
        # 查询明细聚合
        result = await db.execute(
            select(
                TokenUsageLog.user_id,
                TokenUsageLog.project_id,
                TokenUsageLog.model_name,
                TokenUsageLog.provider,
                func.count().label("total_requests"),
                func.sum(TokenUsageLog.input_tokens).label("input_tokens"),
                func.sum(TokenUsageLog.output_tokens).label("output_tokens"),
                func.sum(TokenUsageLog.total_tokens).label("total_tokens"),
                func.sum(TokenUsageLog.cost_usd).label("cost_usd"),
                func.sum(TokenUsageLog.cost_cny).label("cost_cny"),
            )
            .where(local_day == target_date)
            .group_by(
                TokenUsageLog.user_id,
                TokenUsageLog.project_id,
                TokenUsageLog.model_name,
                TokenUsageLog.provider,
            )
        )

        rows = result.all()
        if not rows:
            logger.info(f"日期 {target_date} 无数据需要聚合")
            return

        # 加载 user -> department 映射
        user_dept = {}
        users = await db.execute(select(User.id, User.department_id))
        for u in users.all():
            user_dept[u[0]] = u[1]

        for row in rows:
            dept_id = user_dept.get(row.user_id)
            stmt = insert(DailyUsageSummary).values(
                date=target_date,
                user_id=row.user_id,
                project_id=row.project_id,
                department_id=dept_id,
                model_name=row.model_name,
                provider=row.provider,
                total_requests=row.total_requests,
                input_tokens=int(row.input_tokens or 0),
                output_tokens=int(row.output_tokens or 0),
                total_tokens=int(row.total_tokens or 0),
                cost_usd=float(row.cost_usd or 0),
                cost_cny=float(row.cost_cny or 0),
            ).on_conflict_do_update(
                index_elements=["date", "user_id", "project_id", "model_name"],
                set_={
                    "total_requests": row.total_requests,
                    "input_tokens": int(row.input_tokens or 0),
                    "output_tokens": int(row.output_tokens or 0),
                    "total_tokens": int(row.total_tokens or 0),
                    "cost_usd": float(row.cost_usd or 0),
                    "cost_cny": float(row.cost_cny or 0),
                },
            )
            await db.execute(stmt)

        await db.commit()
        logger.info(f"聚合完成：{target_date}，{len(rows)} 条记录")
