"""从 New API 同步 Token 消耗日志到本地数据库。"""

import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import ModelPricing, SyncState, TokenUsageLog

logger = logging.getLogger(__name__)


async def sync_newapi_logs():
    """拉取 New API 的日志并写入本地 token_usage_logs 表。"""
    if not settings.NEWAPI_BASE_URL or not settings.NEWAPI_ADMIN_TOKEN:
        logger.warning("New API 配置未设置，跳过同步")
        return

    async with async_session() as db:
        # 获取上次同步位置
        state = await _get_or_create_sync_state(db, "newapi")
        last_id = int(state.last_sync_id or "0")

        try:
            await _update_sync_status(db, state, "running")

            # 调用 New API 的日志接口
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    f"{settings.NEWAPI_BASE_URL}/api/log/search",
                    params={"p": 0, "per_page": 500, "log_id_min": last_id + 1},
                    headers={"Authorization": f"Bearer {settings.NEWAPI_ADMIN_TOKEN}"},
                )
                resp.raise_for_status()
                data = resp.json()

            logs = data.get("data", {}).get("logs", [])
            if not logs:
                await _update_sync_status(db, state, "idle")
                return

            # 加载定价表缓存
            pricing = await _load_pricing(db)

            max_id = last_id
            for log in logs:
                log_id = log.get("id", 0)
                max_id = max(max_id, log_id)

                model_name = log.get("model_name", "unknown")
                input_tokens = log.get("prompt_tokens", 0)
                output_tokens = log.get("completion_tokens", 0)
                total_tokens = input_tokens + output_tokens

                cost_usd = _calc_cost(pricing, model_name, input_tokens, output_tokens)
                cost_cny = round(cost_usd * settings.USD_TO_CNY, 4)

                created_at_ts = log.get("created_at", 0)
                request_at = datetime.fromtimestamp(created_at_ts, tz=timezone.utc) if created_at_ts else datetime.now(timezone.utc)

                usage_log = TokenUsageLog(
                    user_id=_map_newapi_user(log.get("user_id")),
                    model_name=model_name,
                    provider=_infer_provider(model_name),
                    source="gateway",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    cost_cny=cost_cny,
                    request_id=str(log_id),
                    request_at=request_at,
                )
                db.add(usage_log)

            state.last_sync_id = str(max_id)
            state.last_sync_at = datetime.now(timezone.utc)
            await _update_sync_status(db, state, "idle")
            await db.commit()
            logger.info(f"同步 New API 日志 {len(logs)} 条，最新 ID: {max_id}")

        except Exception as e:
            logger.exception("同步 New API 日志失败")
            await _update_sync_status(db, state, "error", str(e))
            await db.commit()


def _infer_provider(model_name: str) -> str:
    model_lower = model_name.lower()
    # OpenAI
    if any(k in model_lower for k in ("gpt", "dall-e", "tts-", "whisper", "text-embedding")):
        return "openai"
    if model_lower.startswith(("o1", "o3", "o4", "chatgpt")):
        return "openai"
    # Anthropic
    if "claude" in model_lower:
        return "anthropic"
    # Google
    if any(k in model_lower for k in ("gemini", "gemma", "palm")):
        return "google"
    # DeepSeek
    if "deepseek" in model_lower:
        return "deepseek"
    # 通义千问
    if any(k in model_lower for k in ("qwen", "qwq")):
        return "qwen"
    # 百度文心
    if "ernie" in model_lower:
        return "baidu"
    # 智谱
    if any(k in model_lower for k in ("glm", "chatglm")):
        return "zhipu"
    # Moonshot / Kimi
    if any(k in model_lower for k in ("moonshot", "kimi")):
        return "moonshot"
    # 零一万物
    if model_lower.startswith("yi-"):
        return "yi"
    # 豆包
    if "doubao" in model_lower:
        return "doubao"
    # MiniMax
    if any(k in model_lower for k in ("abab", "minimax")):
        return "minimax"
    # 讯飞星火
    if "spark" in model_lower:
        return "spark"
    # 百川
    if "baichuan" in model_lower:
        return "baichuan"
    # 腾讯混元
    if "hunyuan" in model_lower:
        return "hunyuan"
    # Mistral
    if any(k in model_lower for k in ("mistral", "mixtral", "codestral", "pixtral")):
        return "mistral"
    # Meta Llama
    if "llama" in model_lower:
        return "meta"
    # Cohere
    if any(k in model_lower for k in ("command", "embed-", "rerank")):
        return "cohere"
    # xAI Grok
    if "grok" in model_lower:
        return "xai"
    # Amazon
    if model_lower.startswith("amazon.") or "nova" in model_lower or "titan" in model_lower:
        return "amazon"
    # 商汤
    if "sensechat" in model_lower:
        return "sensetime"
    # 阶跃星辰
    if model_lower.startswith("step-"):
        return "stepfun"
    # 天工
    if "skywork" in model_lower:
        return "skywork"
    # Perplexity
    if "sonar" in model_lower:
        return "perplexity"
    return "other"


def _calc_cost(pricing: dict, model_name: str, input_tokens: int, output_tokens: int) -> float:
    p = pricing.get(model_name)
    if not p:
        return 0.0
    input_cost = (input_tokens / 1000) * float(p["input"])
    output_cost = (output_tokens / 1000) * float(p["output"])
    return round(input_cost + output_cost, 6)


def _map_newapi_user(newapi_user_id: int | None) -> int | None:
    # TODO: 实现 New API 用户 ID 到本地用户 ID 的映射
    # 可通过 users 表的 newapi_user_id 字段关联
    return None


async def _load_pricing(db: AsyncSession) -> dict:
    result = await db.execute(
        select(ModelPricing).where(ModelPricing.effective_to.is_(None))
    )
    pricing = {}
    for p in result.scalars().all():
        pricing[p.model_name] = {"input": p.input_price_per_1k, "output": p.output_price_per_1k}
    return pricing


async def _get_or_create_sync_state(db: AsyncSession, source: str) -> SyncState:
    result = await db.execute(select(SyncState).where(SyncState.source == source))
    state = result.scalar_one_or_none()
    if not state:
        state = SyncState(source=source, status="idle")
        db.add(state)
        await db.flush()
    return state


async def _update_sync_status(db: AsyncSession, state: SyncState, status: str, error: str | None = None):
    state.status = status
    state.error_message = error
    state.updated_at = datetime.now(timezone.utc)
