# Project Guidelines

## Architecture
- This repository is a multi-part AI monitoring system: backend is FastAPI, frontend is React + Vite, vscode-extension is the VS Code capture and dashboard extension, and client is the desktop proxy and launcher written in Go.
- Keep collection, aggregation, and presentation responsibilities separated. Backend owns APIs, persistence, canonicalization, and aggregation. The VS Code extension and desktop client own local capture, local proxying, and transport.

## Build And Test
- Backend: cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload
- Frontend: cd frontend && pnpm install && pnpm dev
- VS Code extension: cd vscode-extension && npm install && npm run compile && npm test
- Desktop client: cd client && go test ./...

## Conventions
- Do not enable transparentMode by default for new installs. Proxy takeover must remain opt-in because it can conflict with existing desktop or system proxy settings.
- When debugging VS Code extension behavior, verify the workspace source, the built extension output, and the actually running extension instance before concluding which implementation is active.
- Do not treat backend counters or dashboard updates as proof that the intended reporting path worked. Match behavior to the exact source, request path, and running instance.
- For dashboard and employee views, prefer current-user or my-stats semantics over global aggregates when the feature is user-scoped.
- Keep provider and source_app canonicalization aligned across backend, extension, and client whenever model or vendor handling changes.