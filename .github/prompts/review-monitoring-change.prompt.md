---
name: "评审监控相关改动"
description: "评审当前仓库中影响 Token 采集、定价、聚合、代理行为或面板指标的改动。"
argument-hint: "要评审的改动范围或问题描述"
agent: "agent"
---
Review the relevant change with a code-review mindset.

Focus on:
- capture regressions
- provider or source_app normalization drift
- cost calculation mistakes
- user-scoping and cache isolation issues
- proxy and certificate safety regressions
- missing tests for changed behavior

Return findings first, ordered by severity, with concrete file references.
