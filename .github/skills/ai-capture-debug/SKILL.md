---
name: ai-capture-debug
description: '排查这个仓库里 Copilot、Continue、Cline、Roo、Cursor 等 AI Token 采集缺失、错误归因、错误厂商映射、面板不一致或代理路由问题。'
argument-hint: '描述哪个来源、哪种异常、你已经观察到的现象'
user-invocable: true
---

# AI 采集排障

## When To Use
- A Copilot or other AI request was made but no token record appeared
- The request appeared under the wrong vendor, model, or source app
- The backend received traffic but the dashboard view is wrong
- A proxy, certificate, or reload step likely broke the capture chain

## Procedure
1. Confirm the symptom precisely: missing capture, wrong attribution, wrong cost, or wrong dashboard view.
2. Identify the producing side first: VS Code extension, desktop client, or backend-side API import.
3. Check whether the current running instance matches the code being inspected, especially for the VS Code extension.
4. Trace provider and source canonicalization before changing pricing or aggregation logic.
5. Separate ingest problems from presentation problems. A dashboard mismatch is not automatically a collection failure.
6. End with one root cause, one minimal fix, and one verification path.

## Project-Specific Checks
- Transparent proxy takeover should remain opt-in for safety and compatibility.
- Current-user stats must stay isolated by effective identity and server target.
- Backend counters alone are insufficient evidence for end-to-end capture.
