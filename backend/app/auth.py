import logging
import secrets

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User

logger = logging.getLogger(__name__)
_api_key_warned = False


async def require_api_key(request: Request) -> None:
    """数据上报接口的 API Key 认证依赖。

    从 X-API-Key 请求头读取 Key 并比对。
    COLLECT_API_KEY 为空时进入迁移宽限期：放行但记录告警日志。
    """
    global _api_key_warned
    if not settings.COLLECT_API_KEY:
        if not _api_key_warned:
            logger.warning("COLLECT_API_KEY 未配置，所有上报请求将被放行（迁移宽限期）")
            _api_key_warned = True
        return

    provided = request.headers.get("X-API-Key", "")
    if not provided or not secrets.compare_digest(provided, settings.COLLECT_API_KEY):
        raise HTTPException(status_code=401, detail="invalid_api_key")


async def require_admin(request: Request) -> None:
    """管理接口的密码认证依赖。

    从 Authorization: Bearer <password> 头读取密码并比对。
    ADMIN_PASSWORD 为空时拒绝所有请求返回 503。
    """
    if not settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="admin_not_configured")

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")

    password = auth[7:]
    if not secrets.compare_digest(password, settings.ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="unauthorized")


async def _lookup_user_by_token(token: str, db: AsyncSession) -> User | None:
    """通过 auth_token 查找活跃用户。"""
    result = await db.execute(
        select(User).where(User.auth_token == token, User.is_active == True)  # noqa: E712
    )
    return result.scalar_one_or_none()


async def require_user_token(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    """用户 token 认证依赖。返回已认证的 User 对象。"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="unauthorized")
    user = await _lookup_user_by_token(token, db)
    if not user:
        raise HTTPException(status_code=401, detail="invalid_token")
    return user


async def require_api_key_or_user_token(
    request: Request, db: AsyncSession = Depends(get_db)
) -> User | None:
    """双重认证：接受 API Key 或用户 token。

    - 有 Authorization: Bearer <token> 头 → 尝试用户 token 认证，成功返回 User
    - 有 X-API-Key 头 → 走 API Key 认证，返回 None
    - 都没有 → 若 API Key 处于宽限期则放行返回 None，否则 401
    """
    # 优先尝试用户 token
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        if token:
            user = await _lookup_user_by_token(token, db)
            if user:
                return user
            raise HTTPException(status_code=401, detail="invalid_token")

    # fallback 到 API Key
    global _api_key_warned
    if not settings.COLLECT_API_KEY:
        if not _api_key_warned:
            logger.warning("COLLECT_API_KEY 未配置，所有上报请求将被放行（迁移宽限期）")
            _api_key_warned = True
        return None

    provided = request.headers.get("X-API-Key", "")
    if provided and secrets.compare_digest(provided, settings.COLLECT_API_KEY):
        return None

    raise HTTPException(status_code=401, detail="invalid_api_key")
