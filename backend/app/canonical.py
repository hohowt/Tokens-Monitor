"""
采集与大屏共用的「应用 / 供应商」规范化键，避免同一产品因别名分裂成多条统计。

Cursor、GitHub Copilot、Kiro 等必须在 source_app / provider 上与客户端常见上报值对齐。
"""

from __future__ import annotations

from sqlalchemy import case, func

# ── source_app：别名（小写）→ 标准键 ───────────────────────────────
# copilot 默认归并为 github-copilot（与多数网关/客户端一致）。
SOURCE_APP_ALIASES: dict[str, str] = {
    "github-copilot": "github-copilot",
    "github_copilot": "github-copilot",
    "githubcopilot": "github-copilot",
    "vscode-github-copilot": "github-copilot",
    "vscode_github_copilot": "github-copilot",
    "copilot": "github-copilot",
    "ms-copilot": "github-copilot",
    "microsoft-copilot": "github-copilot",
    "cursor": "cursor",
    "kiro": "kiro",
    "aws-kiro": "kiro",
    "aws_kiro": "kiro",
    "kiro-ide": "kiro",
    "kiro_ide": "kiro",
    "aws-kiro-ide": "kiro",
}

SOURCE_APP_LABELS: dict[str, str] = {
    "github-copilot": "GitHub Copilot",
    "cursor": "Cursor",
    "kiro": "Kiro",
    "vscode": "VS Code",
    "vscode-insiders": "VS Code Insiders",
    "claude": "Claude Code",
    "opencode": "OpenCode",
    "openclaw": "OpenClaw",
    "codex": "Codex CLI",
    "gemini": "Gemini CLI",
    "amp": "Amp",
    "droid": "Droid",
    "hermes": "Hermes Agent",
    "pi": "Pi",
    "kimi": "Kimi CLI",
    "qwen": "Qwen CLI",
    "roocode": "Roo Code",
    "kilocode": "Kilo Code",
    "kilo": "Kilo CLI",
    "mux": "Mux",
    "crush": "Crush",
    "synthetic": "Synthetic",
    "powershell": "PowerShell",
    "cmd": "CMD",
    "gateway-sync": "网关同步",
    "unknown-app": "未标记应用",
}


def matching_source_app_values_for_delete(submitted: set[str]) -> set[str]:
    """
    Tokscale 同步删除旧行时：上报的 client 名与库里已归一化后的值可能不一致，
    合并别名与标准键，避免删不掉旧数据。
    """
    out: set[str] = set()
    for s in submitted:
        s = (s or "").strip()
        if not s:
            continue
        out.add(s)
        canon = canonical_source_app_key(s) or s
        out.add(canon)
        for alias, c in SOURCE_APP_ALIASES.items():
            if c == canon:
                out.add(alias)
    return out


def canonical_source_app_key(raw: str | None) -> str | None:
    """将客户端上报的 source_app / Tokscale client 归并为标准键；空则 None。"""
    s = (raw or "").strip()
    if not s:
        return None
    key = s.lower().replace("_", "-")
    if key in SOURCE_APP_ALIASES:
        return SOURCE_APP_ALIASES[key]
    low = s.lower()
    if low in SOURCE_APP_ALIASES:
        return SOURCE_APP_ALIASES[low]
    return key


def source_app_display_name(source_app: str | None) -> str:
    """大屏与身份检查用的展示名。"""
    normalized = (source_app or "").strip()
    if not normalized:
        return "未标记应用"
    canon = canonical_source_app_key(normalized) or normalized
    return SOURCE_APP_LABELS.get(canon, SOURCE_APP_LABELS.get(normalized.lower(), normalized))


# ── provider：厂商名归并（供应商占比）────────────────────────────
PROVIDER_ALIASES: dict[str, str] = {
    "github-copilot": "github-copilot",
    "github_copilot": "github-copilot",
    "githubcopilot": "github-copilot",
    "copilot": "github-copilot",
    "cursor": "cursor",
}

PROVIDER_LABELS: dict[str, str] = {
    "github-copilot": "GitHub Copilot",
    "cursor": "Cursor",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "deepseek": "DeepSeek",
    "azure-openai": "Azure OpenAI",
}


def canonical_provider_key(raw: str | None) -> str:
    """写入 token_usage_logs.provider 的标准键（小写）。"""
    s = (raw or "").strip()
    if not s:
        return "unknown"
    k = s.lower().replace("_", "-")
    return PROVIDER_ALIASES.get(k, k)


def provider_display_name(provider_key: str | None) -> str:
    k = (provider_key or "").strip() or "unknown"
    return PROVIDER_LABELS.get(k, k)


def source_app_key_sql_case(source_app_col, source_col_for_gateway):
    """大屏按应用聚合：与 canonical_source_app_key 一致。"""
    t = func.trim(source_app_col)
    lo = func.lower(t)
    buckets: dict[str, list[str]] = {}
    for alias, canon in SOURCE_APP_ALIASES.items():
        buckets.setdefault(canon, []).append(alias)
    inner = lo
    for canon in ("github-copilot", "cursor", "kiro"):
        aliases = sorted(set(buckets.get(canon, [])))
        if aliases:
            inner = case((lo.in_(aliases), canon), else_=inner)
    return case(
        (
            (source_app_col.is_(None)) | (t == ""),
            case((source_col_for_gateway == "gateway", "gateway-sync"), else_="unknown-app"),
        ),
        else_=inner,
    )


def provider_key_sql_case(provider_col):
    """大屏按供应商聚合：与 canonical_provider_key 一致。"""
    lo = func.lower(func.trim(provider_col))
    buckets: dict[str, list[str]] = {}
    for alias, canon in PROVIDER_ALIASES.items():
        buckets.setdefault(canon, []).append(alias)
    inner = lo
    for canon in ("github-copilot", "cursor"):
        aliases = sorted(set(buckets.get(canon, [])))
        if aliases:
            inner = case((lo.in_(aliases), canon), else_=inner)
    return inner
