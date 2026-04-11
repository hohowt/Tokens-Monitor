package main

import (
	"encoding/json"
	"strings"
)

// 仅对“看起来像真实模型推理”的 opaque 流量做估算，尽量排除 Cursor 内部服务、CDN、实验配置等噪音。
var opaqueEndpointDenylist = []string{
	"ReportAgentSnapshot",
	"ReportClientNumericMetrics",
	"OnlineMetricsService",
	"analytics",
	"telemetry",
	"feature",
	"experiment",
	"statsig",
	"blame",
	"permission",
	"optimizer",
	"usageevents",
	"teammemberusage",
	"spend",
	"cdn",
	"download",
}

var opaqueEndpointAllowlist = []string{
	"/chat",
	"streamchat",
	"unifiedchat",
	"/messages",
	"/responses",
	"/completions",
	"/generate",
	"/invoke",
	"aiservice",
	"cmdkservice",
	"composerservice",
}

var opaqueModelHintDenyKeywords = []string{
	"permission",
	"permissions",
	"optimizer",
	"blame",
	"llamaindex",
	"cursor",
	"cdn",
	"telemetry",
	"analytics",
	"statsig",
	"experiment",
	"feature",
	"judge",
	"summarizer",
	"orientation",
	"feasibility",
	"planmodel",
	"classifier",
	"rerank",
	"embedding",
}

const (
	opaqueSourceEstimate = "client-mitm-estimate"
	opaqueModelSuffix    = "·opaque(估算)"
)

// shouldOpaqueEstimate 是否对无法解析的响应做体积估算上报。
// 规则：非 JSON + 命中推理接口白名单 + 命中真实模型名 + 不命中内部服务黑名单。
func shouldOpaqueEstimate(endpoint, modelHint string, body []byte) bool {
	if len(body) < 16 {
		return false
	}
	// 合法 JSON 已由 ExtractUsage 处理；未取得 usage 时不再用体积估算，避免与「无 usage 字段」的 JSON 双计。
	if json.Valid(body) {
		return false
	}
	ep := strings.ToLower(endpoint)
	for _, s := range opaqueEndpointDenylist {
		if strings.Contains(ep, strings.ToLower(s)) {
			return false
		}
	}
	allowed := false
	for _, s := range opaqueEndpointAllowlist {
		if strings.Contains(ep, strings.ToLower(s)) {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}
	return looksLikeBillableOpaqueModelHint(modelHint)
}

// opaqueTokenSplit 按响应字节数粗算 token（约 4 字节≈1 token），并按端点类型拆分输入/输出比例；非官方口径。
func opaqueTokenSplit(body []byte, endpoint string) (prompt, completion, total int) {
	n := len(body)
	if n < 16 {
		return 0, 0, 0
	}
	total = n / 4
	if total < 1 {
		total = 1
	}
	const maxTok = 500000
	if total > maxTok {
		total = maxTok
	}
	// 按端点类型调整拆分比例：
	// - chat/completion 类：响应以生成内容为主，completion 占比高
	// - edit/composer 类：输入输出更均衡
	promptPct := 30 // 默认 30% prompt / 70% completion
	ep := strings.ToLower(endpoint)
	if strings.Contains(ep, "edit") || strings.Contains(ep, "composer") || strings.Contains(ep, "apply") {
		promptPct = 45
	}
	prompt = total * promptPct / 100
	completion = total - prompt
	return prompt, completion, total
}

func opaqueModelLabel(vendor string) string {
	v := strings.TrimSpace(vendor)
	if v == "" {
		v = "unknown"
	}
	return v + opaqueModelSuffix
}

func opaqueModelLabelWithHint(vendor, modelHint string) string {
	m := strings.TrimSpace(modelHint)
	if m != "" {
		if strings.Contains(m, opaqueModelSuffix) {
			return m
		}
		return m + opaqueModelSuffix
	}
	return opaqueModelLabel(vendor)
}

func looksLikeBillableOpaqueModelHint(model string) bool {
	model = strings.ToLower(normalizeModelHint(model))
	if model == "" {
		return false
	}
	for _, keyword := range opaqueModelHintDenyKeywords {
		if strings.Contains(model, keyword) {
			return false
		}
	}
	if strings.Contains(model, ".com") || strings.Contains(model, ".ai") || strings.Contains(model, ".cn") || strings.Contains(model, ".sh") {
		return false
	}
	for _, prefix := range knownModelPrefixes {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return false
}
