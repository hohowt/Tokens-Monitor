import json
import re
import sys


DESTRUCTIVE_PATTERNS = [
    r"git\s+reset\s+--hard",
    r"git\s+checkout\s+--",
    r"rm\s+-rf",
    r"remove-item\b.*-recurse\b.*-force",
    r"del\s+/f\s+/q",
    r"truncate\s+table",
    r"drop\s+table",
    r"docker\s+system\s+prune\b.*-a",
]

SENSITIVE_FILES = (
    ".github/hooks/",
    ".vscode/mcp.json",
)


def _load_payload() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _emit(data: dict) -> None:
    sys.stdout.write(json.dumps(data, ensure_ascii=True))


def _session_start() -> None:
    _emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": (
                    "Repository context: backend=FastAPI, frontend=React/Vite, "
                    "vscode-extension=VS Code capture/dashboard, client=Go desktop proxy. "
                    "Treat transparent proxy takeover as opt-in, verify the running extension instance, "
                    "and do not use dashboard counters alone as proof of end-to-end capture."
                ),
            }
        }
    )


def _iter_candidate_paths(tool_input: object) -> list[str]:
    if not isinstance(tool_input, dict):
        return []

    paths: list[str] = []
    for key in ("filePath", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            paths.append(value.replace("\\", "/"))

    files = tool_input.get("files")
    if isinstance(files, list):
        for item in files:
            if isinstance(item, str):
                paths.append(item.replace("\\", "/"))
            elif isinstance(item, dict):
                for key in ("filePath", "path"):
                    value = item.get(key)
                    if isinstance(value, str):
                        paths.append(value.replace("\\", "/"))

    return paths


def _contains_sensitive_path(tool_input: object) -> bool:
    for path in _iter_candidate_paths(tool_input):
        lower_path = path.lower()
        if any(marker in lower_path for marker in SENSITIVE_FILES):
            return True
    return False


def _extract_command(tool_input: object) -> str:
    if not isinstance(tool_input, dict):
        return ""
    for key in ("command", "text", "input"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return ""


def _pre_tool_use(payload: dict) -> None:
    tool_name = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input", {})
    command = _extract_command(tool_input)
    normalized = command.lower()

    if command and any(re.search(pattern, normalized) for pattern in DESTRUCTIVE_PATTERNS):
        _emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "Potentially destructive terminal command detected; require confirmation.",
                    "additionalContext": "Check whether the command would delete files, reset git state, or destroy data before proceeding.",
                }
            }
        )
        return

    if _contains_sensitive_path(tool_input):
        _emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "Editing Copilot customization or MCP configuration files requires explicit confirmation.",
                    "additionalContext": "Review the change carefully because it affects agent behavior, hooks, prompts, or MCP tools.",
                }
            }
        )
        return

    if tool_name in {"run_in_terminal", "execute"} and command:
        _emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "additionalContext": "Terminal command reviewed by repository guard.",
                }
            }
        )
        return

    _emit({"continue": True})


def main() -> int:
    payload = _load_payload()
    event_name = payload.get("hookEventName")

    if event_name == "SessionStart":
        _session_start()
        return 0

    if event_name == "PreToolUse":
        _pre_tool_use(payload)
        return 0

    _emit({"continue": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())