import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import collect, dashboard, extension, user_auth
from app.services.scheduler import start_scheduler, stop_scheduler

logger = logging.getLogger(__name__)


def _get_cors_origins() -> list[str]:
    raw = settings.CORS_ALLOWED_ORIGINS
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    # 未配置时允许所有来源，确保大屏等只读页面可正常访问
    return ["*"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.DATABASE_URL:
        raise RuntimeError("DATABASE_URL 未配置，请在 .env 或环境变量中设置")
    if not settings.COLLECT_API_KEY:
        logger.warning("COLLECT_API_KEY 未配置，上报接口处于迁移宽限期（无认证）")
    if not settings.ADMIN_PASSWORD:
        logger.warning("ADMIN_PASSWORD 未配置，管理接口将返回 503")
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="AI Token Monitor", version="1.0.0", lifespan=lifespan)

_origins = _get_cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    # allow_credentials 不可与 allow_origins=["*"] 同时使用
    allow_credentials=("*" not in _origins),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard.router)
app.include_router(collect.router)
app.include_router(extension.router)
app.include_router(user_auth.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
