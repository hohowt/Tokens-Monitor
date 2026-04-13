---
description: "在编辑后端 Python 文件中的 FastAPI 路由、鉴权、定价、Schema、规范化或聚合逻辑时使用。"
name: "后端 Python 规范"
applyTo: "backend/**/*.py"
---
# Backend Python Guidelines

- Preserve existing API payload shapes unless the task explicitly requires a contract change.
- Keep async database and FastAPI patterns consistent with the current codebase. Prefer small, local fixes over broad refactors.
- Schema-dependent behavior must be paired with SQL changes in backend/migrations when new columns, indexes, or backfills are required.
- When touching pricing or token accounting, verify prompt, completion, and total token handling together instead of patching only one field.
- When touching provider or source normalization, keep backend/app/canonical.py aligned with the values emitted by the extension and the desktop client.
