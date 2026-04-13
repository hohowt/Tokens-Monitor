---
name: "追踪 AI 采集链路"
description: "追踪为什么 Copilot、Continue、Cline、Roo、Cursor 或其他 AI 请求没有进入监控链路。"
argument-hint: "描述现象、来源应用、时间段、是否已重载窗口"
agent: "agent"
---
Investigate why the reported AI activity did not appear in the monitoring pipeline.

Work end to end:
- identify the expected source app and request path
- inspect the relevant capture layer in the workspace
- verify canonicalization, collection, and dashboard rollup paths
- distinguish ingest failure from display failure

Return the result in this format:
- Findings
- Most likely breakpoint
- Suggested fix
- How to verify
