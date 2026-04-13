"""模型定价：按目录价计算 USD 成本（每 1K token）。"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


GITHUB_COPILOT_PROVIDER_ALIASES = {
    "github-copilot",
    "github_copilot",
    "githubcopilot",
    "copilot",
}


# GitHub Copilot 元数据里已观察到的折扣倍率。
# 当客户端尚未上报精确倍率时，服务端用它做保守回退，避免按上游目录原价高估。
GITHUB_COPILOT_COST_MULTIPLIERS = {
    "gpt-5.4": 0.1,
    "gpt-5.3-codex": 0.1,
    "gpt-4.1": 0.1,
    "gpt-4.1-2025-04-14": 0.1,
}


def _normalize_model_name(model: str) -> str:
    normalized = (model or "").strip()
    if "·" in normalized:
        normalized = normalized.split("·", 1)[0]
    return normalized


def _longest_prefix_match(value: str, candidates: dict[str, float]) -> Optional[float]:
    best_len = -1
    best_value: Optional[float] = None
    for name, candidate_value in candidates.items():
        if value.startswith(name) and len(name) > best_len:
            best_len = len(name)
            best_value = candidate_value
        elif name.startswith(value) and len(name) > best_len:
            best_len = len(name)
            best_value = candidate_value
    return best_value


def _normalize_provider_name(provider: str | None) -> str:
    normalized = (provider or "").strip().lower()
    if not normalized:
        return ""
    return "github-copilot" if normalized in GITHUB_COPILOT_PROVIDER_ALIASES else normalized


def _resolve_cost_multiplier(provider: str | None, model: str, cost_multiplier: float | None) -> float:
    if cost_multiplier and 0 < cost_multiplier <= 10:
        return float(cost_multiplier)

    normalized_provider = _normalize_provider_name(provider)
    normalized_model = _normalize_model_name(model).lower()
    if normalized_provider != "github-copilot" or not normalized_model:
        return 1.0

    matched = _longest_prefix_match(normalized_model, GITHUB_COPILOT_COST_MULTIPLIERS)
    return matched if matched and matched > 0 else 1.0


def calc_cost_usd(
    pricing: dict[str, tuple[float, float]],
    model: str,
    input_tokens: int,
    output_tokens: int,
    total_tokens: int = 0,
    provider: str | None = None,
    cost_multiplier: float | None = None,
) -> float:
    """按目录价计算 USD。优先精确匹配模型名；否则取「最长前缀」匹配，减少误配。"""
    model = (model or "").strip()
    if not model:
        return 0.0

    # 去掉估算后缀 "·opaque(估算)"，匹配真实模型定价
    bare = _normalize_model_name(model)
    multiplier = _resolve_cost_multiplier(provider, bare, cost_multiplier)

    def _calc(p: tuple[float, float]) -> float:
        inp, out = input_tokens, output_tokens
        if not inp and not out and total_tokens:
            # 无 input/output 分拆时，按 70/30 估算
            inp = int(total_tokens * 0.7)
            out = total_tokens - inp
        raw_cost = (inp / 1000 * p[0]) + (out / 1000 * p[1])
        return round(raw_cost * multiplier, 6)

    price = pricing.get(model) or pricing.get(bare)
    if price:
        return _calc(price)

    best_len = -1
    best_price: tuple[float, float] | None = None
    for name, p in pricing.items():
        if bare.startswith(name) and len(name) > best_len:
            best_len = len(name)
            best_price = p
        elif name.startswith(bare) and len(name) > best_len:
            best_len = len(name)
            best_price = p

    if not best_price:
        logger.debug("pricing miss: model=%r has no catalog entry", model)
        return 0.0

    return _calc(best_price)


def tokscale_costs(cost: float, currency: str | None, usd_to_cny: float) -> tuple[float, float]:
    """Tokscale 上报的 cost 与币种 → (cost_usd, cost_cny)。默认 cost 为 USD。"""
    raw = max(float(cost or 0.0), 0.0)
    c = (currency or "USD").strip().upper()
    if c in ("CNY", "RMB"):
        cny = round(raw, 4)
        usd = round(cny / usd_to_cny, 6) if usd_to_cny else 0.0
        return usd, cny
    usd = round(raw, 6)
    cny = round(usd * usd_to_cny, 4)
    return usd, cny
