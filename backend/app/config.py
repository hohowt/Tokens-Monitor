from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://monitor:monitor_dev_123@localhost:5432/token_monitor"
    REDIS_URL: str = "redis://localhost:6379/0"

    # New API 配置
    NEWAPI_BASE_URL: str = "http://localhost:3001"
    NEWAPI_ADMIN_TOKEN: str = ""

    # 大屏统计、按日聚合使用的时区（与客户端本地日期一致，避免「晚上用的算到前一天」）
    DASHBOARD_TIMEZONE: str = "Asia/Shanghai"

    # 汇率
    USD_TO_CNY: float = 7.25

    # 告警 Webhook（企微/钉钉/飞书）
    ALERT_WEBHOOK_URL: str = ""

    # 同步间隔（分钟）
    SYNC_INTERVAL_MINUTES: int = 10

    # Tokscale 等上报失败时是否在 API 响应中带简短错误信息（便于排障；生产可关）
    EXPOSE_INTERNAL_ERRORS: bool = False

    model_config = {"env_file": ".env"}


settings = Settings()
