"""将历史 estimate 来源的成本归零，并重建受影响日期的 daily_usage_summary。"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import date
from pathlib import Path

from sqlalchemy import Date, cast, func, select, update

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

from app.database import async_session
from app.models import TokenUsageLog
from app.services.aggregator import aggregate_daily
from app.config import settings


ESTIMATE_SOURCE = "client-mitm-estimate"


async def main() -> None:
    local_day = cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), Date)

    async with async_session() as db:
        affected_dates_result = await db.execute(
            select(local_day)
            .where(TokenUsageLog.source == ESTIMATE_SOURCE)
            .distinct()
            .order_by(local_day)
        )
        affected_dates = [row[0] for row in affected_dates_result.all() if isinstance(row[0], date)]

        update_result = await db.execute(
            update(TokenUsageLog)
            .where(
                TokenUsageLog.source == ESTIMATE_SOURCE,
                (func.coalesce(TokenUsageLog.cost_usd, 0) != 0)
                | (func.coalesce(TokenUsageLog.cost_cny, 0) != 0),
            )
            .values(cost_usd=0, cost_cny=0)
        )
        await db.commit()

    rebuilt = 0
    for day in affected_dates:
        await aggregate_daily(day)
        rebuilt += 1

    print(f"reset estimate costs rows={update_result.rowcount or 0}")
    print(f"rebuilt daily summaries days={rebuilt}")


if __name__ == "__main__":
    asyncio.run(main())