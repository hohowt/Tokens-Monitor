"""定时任务调度器。"""

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import settings

logger = logging.getLogger(__name__)
scheduler = AsyncIOScheduler()


def _run_async(coro_func):
    """包装异步任务供 APScheduler 调用。"""
    async def wrapper():
        try:
            await coro_func()
        except Exception:
            logger.exception(f"定时任务 {coro_func.__name__} 执行失败")
    return wrapper


def start_scheduler():
    from app.services.sync_newapi import sync_newapi_logs
    from app.services.aggregator import aggregate_daily
    from app.services.alerts import check_alerts

    # 每 N 分钟同步 New API 日志
    scheduler.add_job(
        _run_async(sync_newapi_logs), "interval",
        minutes=settings.SYNC_INTERVAL_MINUTES, id="sync_newapi",
    )

    # 每小时聚合当天数据
    scheduler.add_job(
        _run_async(aggregate_daily), "interval",
        hours=1, id="aggregate_daily",
    )

    # 每 30 分钟检查告警
    scheduler.add_job(
        _run_async(check_alerts), "interval",
        minutes=30, id="check_alerts",
    )

    scheduler.start()
    logger.info("定时任务调度器已启动")


def stop_scheduler():
    scheduler.shutdown(wait=False)
    logger.info("定时任务调度器已停止")
