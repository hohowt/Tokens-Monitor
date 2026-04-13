---
description: "在编辑 VS Code 扩展里的采集链路、面板、代理接管、证书处理或 Token 上报逻辑时使用。"
name: "VS Code 扩展规范"
applyTo: "vscode-extension/src/**/*.ts"
---
# VS Code Extension Guidelines

- New installs must remain safe by default. Do not auto-enable transparent proxy takeover.
- Certificate installation and proxy takeover must fail closed. If trust or certificate setup fails, do not continue with MITM routing.
- Current-user dashboard state must stay isolated by effective identity and server target; avoid leaking or mixing cached data across users.
- When debugging capture failures, verify whether the active VS Code window has been reloaded and whether the running extension bundle matches the edited source.
- If a change affects capture, collectors, tracker state, or dashboard stats, run the extension test suite instead of relying on manual reasoning alone.
