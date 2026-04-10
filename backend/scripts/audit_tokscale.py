"""
对账：按 Tokscale 采集来源汇总 token_usage_logs，便于与 Tokscale 本地导出 JSON 对比。

用法（在 backend 目录且已配置 DATABASE_URL）:
  python scripts/audit_tokscale.py
  python scripts/audit_tokscale.py --days 30
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timedelta, time as dt_time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import func, select

from app.canonical import source_app_key_sql_case
from app.config import settings
from app.database import async_session
from app.models import TokenUsageLog
from app.routers.dashboard import ESTIMATE_SOURCE


def _dashboard_tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.DASHBOARD_TIMEZONE)
    except Exception:
        return ZoneInfo("Asia/Shanghai")


async def run_audit(days: int) -> None:
    tz = _dashboard_tz()
    end_d = datetime.now(tz).date()
    start_d = end_d - timedelta(days=days - 1)
    start_ts = datetime.combine(start_d, dt_time.min, tzinfo=tz)
    end_ts = datetime.combine(end_d, dt_time(23, 59, 59, 999999), tzinfo=tz)

    async with async_session() as db:
        total = await db.execute(
            select(
                func.coalesce(func.sum(TokenUsageLog.total_tokens), 0),
                func.coalesce(func.sum(TokenUsageLog.cost_cny), 0),
                func.count(),
            ).where(
                TokenUsageLog.source == "tokscale",
                TokenUsageLog.request_at.between(start_ts, end_ts),
            )
        )
        row = total.one()
        print(f"Tokscale 汇总（近 {days} 天，业务时区 {tz.key}）")
        print(f"  total_tokens: {int(row[0])}")
        print(f"  cost_cny:     {float(row[1]):.4f}")
        print(f"  rows:         {int(row[2])}")
        print()

        sak = source_app_key_sql_case(TokenUsageLog.source_app, TokenUsageLog.source)
        r2 = await db.execute(
            select(sak, func.sum(TokenUsageLog.total_tokens))
            .where(
                TokenUsageLog.source == "tokscale",
                TokenUsageLog.request_at.between(start_ts, end_ts),
            )
            .group_by(sak)
            .order_by(func.sum(TokenUsageLog.total_tokens).desc())
        )
        print("按应用（归一化 source_app）:")
        for k, t in r2.all():
            print(f"  {k!r}: {int(t)}")

    print()
    print("其他来源（同期行数）:")
    async with async_session() as db:
        for src in ("client", "gateway", ESTIMATE_SOURCE):
            c = await db.execute(
                select(func.count()).where(
                    TokenUsageLog.source == src,
                    TokenUsageLog.request_at.between(start_ts, end_ts),
                )
            )
            print(f"  {src}: {c.scalar() or 0}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=30, help="统计天数")
    args = p.parse_args()
    if not os.environ.get("DATABASE_URL"):
        print("请设置环境变量 DATABASE_URL（与 backend 一致）", file=sys.stderr)
        sys.exit(1)
    asyncio.run(run_audit(args.days))


if __name__ == "__main__":
    main()
