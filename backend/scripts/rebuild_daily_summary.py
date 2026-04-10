"""在 backend 镜像内执行：从 token_usage_logs 重算 daily_usage_summary。"""

from __future__ import annotations

import asyncio
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from zoneinfo import ZoneInfo

from app.config import settings
from app.services.aggregator import aggregate_daily


async def main() -> None:
    tz = ZoneInfo(settings.DASHBOARD_TIMEZONE)
    today = datetime.now(tz).date()
    start = today - timedelta(days=400)
    d: date = start
    n = 0
    while d < today:
        await aggregate_daily(d)
        n += 1
        d += timedelta(days=1)
    print(f"rebuilt {n} days up to {today - timedelta(days=1)}")


if __name__ == "__main__":
    asyncio.run(main())
