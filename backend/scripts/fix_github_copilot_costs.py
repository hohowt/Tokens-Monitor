"""按当前 GitHub Copilot 折扣口径重算历史成本，并重建受影响日期汇总。"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import date
from pathlib import Path

from sqlalchemy import Date, cast, func, select

if "__file__" in globals() and not str(__file__).startswith("<"):
    ROOT = Path(__file__).resolve().parent.parent
else:
    ROOT = Path.cwd()
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

from app.config import settings
from app.database import async_session
from app.models import ModelPricing, TokenUsageLog
from app.pricing import calc_cost_usd
from app.services.aggregator import aggregate_daily


TARGET_PROVIDER = "github-copilot"


async def _load_pricing(db):
    result = await db.execute(select(ModelPricing).where(ModelPricing.effective_to.is_(None)))
    return {
        row.model_name: (float(row.input_price_per_1k), float(row.output_price_per_1k))
        for row in result.scalars().all()
    }


async def main() -> None:
    local_day = cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), Date)

    async with async_session() as db:
        pricing = await _load_pricing(db)
        result = await db.execute(
            select(
                TokenUsageLog.id,
                TokenUsageLog.model_name,
                TokenUsageLog.input_tokens,
                TokenUsageLog.output_tokens,
                TokenUsageLog.total_tokens,
                local_day.label("local_day"),
            ).where(
                TokenUsageLog.provider == TARGET_PROVIDER,
                TokenUsageLog.source != "client-mitm-estimate",
            )
        )

        affected_dates: set[date] = set()
        updated = 0
        for row in result.all():
            recalculated_usd = calc_cost_usd(
                pricing,
                row.model_name,
                int(row.input_tokens or 0),
                int(row.output_tokens or 0),
                int(row.total_tokens or 0),
                provider=TARGET_PROVIDER,
            )
            recalculated_cny = round(recalculated_usd * settings.USD_TO_CNY, 4)

            log_row = await db.get(TokenUsageLog, row.id)
            if log_row is None:
                continue
            if float(log_row.cost_usd or 0) == recalculated_usd and float(log_row.cost_cny or 0) == recalculated_cny:
                continue

            log_row.cost_usd = recalculated_usd
            log_row.cost_cny = recalculated_cny
            updated += 1
            if isinstance(row.local_day, date):
                affected_dates.add(row.local_day)

        await db.commit()

    rebuilt = 0
    for day in sorted(affected_dates):
        await aggregate_daily(day)
        rebuilt += 1

    print(f"recalculated github copilot rows={updated}")
    print(f"rebuilt daily summaries days={rebuilt}")


if __name__ == "__main__":
    asyncio.run(main())