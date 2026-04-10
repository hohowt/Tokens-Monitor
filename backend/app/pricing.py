"""模型定价：按目录价计算 USD 成本（每 1K token）。"""

import logging

logger = logging.getLogger(__name__)


def calc_cost_usd(
    pricing: dict[str, tuple[float, float]],
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> float:
    """按目录价计算 USD。优先精确匹配模型名；否则取「最长前缀」匹配，减少误配。"""
    model = (model or "").strip()
    if not model:
        return 0.0

    price = pricing.get(model)
    if price:
        cost = (input_tokens / 1000 * price[0]) + (output_tokens / 1000 * price[1])
        return round(cost, 6)

    best_len = -1
    best_price: tuple[float, float] | None = None
    for name, p in pricing.items():
        if model.startswith(name) and len(name) > best_len:
            best_len = len(name)
            best_price = p
        elif name.startswith(model) and len(name) > best_len:
            best_len = len(name)
            best_price = p

    if not best_price:
        logger.debug("pricing miss: model=%r has no catalog entry", model)
        return 0.0

    cost = (input_tokens / 1000 * best_price[0]) + (output_tokens / 1000 * best_price[1])
    return round(cost, 6)


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
