package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

var modelHintKeyPattern = regexp.MustCompile(`(?i)(?:model(?:_name|name|_id|id|version)?|deployment(?:_id|id)?|engine)[^A-Za-z0-9]{0,8}["']?([A-Za-z0-9][A-Za-z0-9._:-]{2,80})["']?`)

// knownModelPrefixes 用于判断一个字符串是否像已知 AI 模型名（共享给 opaque.go）。
var knownModelPrefixes = []string{
	"gpt-", "claude-", "gemini-", "deepseek-", "qwen", "mistral",
	"llama", "grok-", "command-r", "kimi", "moonshot-", "doubao-",
	"yi-", "o1", "o3", "o4", "cursor-", "glm-", "gemma-",
	"ernie-", "baichuan-", "internlm-", "wizard", "zephyr", "phi-",
	"mixtral-", "falcon-", "olmo", "skywork", "chatglm", "minicpm",
	"tinyllama", "aquila", "codegeex", "starcoder", "codet5", "pangu",
	"bloom", "opt-", "flan-t5", "jurassic-", "pplx", "replit",
	"gopher", "chinchilla", "xverse",
}

var modelHintValuePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(gpt-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(claude-[a-z0-9][a-z0-9._-]{0,50})\b`),
	regexp.MustCompile(`(?i)\b(gemini-[a-z0-9][a-z0-9._-]{0,50})\b`),
	regexp.MustCompile(`(?i)\b(glm-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(deepseek-[a-z0-9][a-z0-9._-]{0,50})\b`),
	regexp.MustCompile(`(?i)\b(qwen[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(mistral[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(llama[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(grok-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(command-r(?:[+\-][a-z0-9._-]{1,40})?)\b`),
	regexp.MustCompile(`(?i)\b(kimi(?:-[a-z0-9][a-z0-9._-]{0,40})?)\b`),
	regexp.MustCompile(`(?i)\b(gemma-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(ernie-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(baichuan-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(internlm-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(wizard(?:coder|lm)?[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(zephyr[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(phi-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(mixtral-[a-z0-9][a-z0-9x._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(falcon-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(olmo[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(skywork[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(chatglm[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(minicpm[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(tinyllama[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(aquila[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(codegeex[a-z0-9+._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(starcoder[a-z0-9+._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(codet5\+[a-z0-9._-]{0,40}|codet5[a-z0-9+._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(pangu[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(bloomz?[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(opt-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(flan-t5[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(jurassic-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(pplx[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(replit[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(gopher[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(chinchilla[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(xverse[a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(moonshot-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(doubao-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(yi-[a-z0-9][a-z0-9._-]{0,40})\b`),
	regexp.MustCompile(`(?i)\b(o[134](?:-[a-z0-9][a-z0-9._-]{0,40})?)\b`),
	regexp.MustCompile(`(?i)\b(cursor-[a-z0-9][a-z0-9._-]{0,40})\b`),
}

// UsageInfo holds extracted token usage from an AI API response.
type UsageInfo struct {
	Model            string
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// ExtractUsage extracts token usage information from an AI API response body.
// It handles both regular JSON responses and SSE streaming responses.
func ExtractUsage(vendor string, data []byte) *UsageInfo {
	str := string(data)
	if strings.HasPrefix(str, "data:") || strings.Contains(str, "\ndata:") {
		return extractFromSSE(vendor, data)
	}
	return extractFromJSON(vendor, data)
}

func extractFromJSON(vendor string, data []byte) *UsageInfo {
	var resp map[string]interface{}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil
	}

	info := &UsageInfo{}

	// Extract model name from common fields
	if m, ok := resp["model"].(string); ok {
		info.Model = m
	} else if m, ok := resp["modelVersion"].(string); ok {
		info.Model = m
	}
	if info.Model == "" {
		info.Model = deepFindModel(resp)
	}

	switch vendor {
	case "anthropic":
		if u := extractAnthropic(resp, info); u != nil {
			return u
		}
		return deepExtractUsageOpenAIStyle(resp, info.Model)
	case "google":
		if u := extractGoogle(resp, info); u != nil {
			return u
		}
		return deepExtractUsageOpenAIStyle(resp, info.Model)
	case "cohere":
		if u := extractCohere(resp, info); u != nil {
			return u
		}
		return deepExtractUsageOpenAIStyle(resp, info.Model)
	default:
		// OpenAI-compatible + GitHub Copilot 等：先顶层 usage，再整棵树递归查找嵌套 usage
		if u := extractOpenAI(resp, info); u != nil && u.TotalTokens > 0 {
			return u
		}
		return deepExtractUsageOpenAIStyle(resp, info.Model)
	}
}

// deepExtractUsageOpenAIStyle 在任意嵌套位置查找 OpenAI 形 usage{prompt_tokens,completion_tokens,total_tokens}。
// Copilot / 部分网关会把 usage 放在 choices 内或深层字段。
func deepExtractUsageOpenAIStyle(root map[string]interface{}, modelHint string) *UsageInfo {
	if modelHint == "" {
		modelHint = deepFindModel(root)
	}
	var found *UsageInfo
	var walk func(interface{})
	walk = func(v interface{}) {
		if found != nil {
			return
		}
		switch x := v.(type) {
		case map[string]interface{}:
			if u := x["usage"]; u != nil {
				if um, ok := u.(map[string]interface{}); ok {
					pt := toInt(um["prompt_tokens"])
					ct := toInt(um["completion_tokens"])
					tt := toInt(um["total_tokens"])
					if tt == 0 {
						tt = pt + ct
					}
					if pt > 0 || ct > 0 || tt > 0 {
						m := modelHint
						if mm, ok := x["model"].(string); ok && mm != "" {
							m = mm
						}
						found = &UsageInfo{
							Model: m, PromptTokens: pt, CompletionTokens: ct, TotalTokens: tt,
						}
						return
					}
				}
			}
			for _, child := range x {
				walk(child)
			}
		case []interface{}:
			for _, item := range x {
				walk(item)
			}
		}
	}
	walk(root)
	return found
}

// deepFindModel tries to locate model identifiers in nested payloads.
func deepFindModel(root map[string]interface{}) string {
	keys := []string{"model", "model_name", "modelName", "model_id", "modelId", "modelVersion", "deployment", "deployment_id", "deploymentId", "engine"}

	var found string
	var walk func(interface{})
	walk = func(v interface{}) {
		if found != "" {
			return
		}
		switch x := v.(type) {
		case map[string]interface{}:
			for _, k := range keys {
				if s, ok := x[k].(string); ok {
					s = strings.TrimSpace(s)
					if s != "" {
						found = s
						return
					}
				}
			}
			for _, child := range x {
				walk(child)
			}
		case []interface{}:
			for _, item := range x {
				walk(item)
			}
		}
	}

	walk(root)
	return found
}

func inferModelHint(data []byte) string {
	if len(data) == 0 {
		return ""
	}

	var root map[string]interface{}
	if json.Unmarshal(data, &root) == nil {
		if model := normalizeModelHint(deepFindModel(root)); model != "" {
			return model
		}
	}

	raw := string(data)
	if match := modelHintKeyPattern.FindStringSubmatch(raw); len(match) > 1 {
		if model := normalizeModelHint(match[1]); looksLikeModelHint(model) {
			return model
		}
	}
	for _, re := range modelHintValuePatterns {
		if match := re.FindStringSubmatch(raw); len(match) > 1 {
			if model := normalizeModelHint(match[1]); model != "" {
				return model
			}
		}
	}
	return ""
}

func normalizeModelHint(model string) string {
	model = strings.TrimSpace(model)
	model = strings.Trim(model, "\"'` \t\r\n,;:()[]{}<>")
	model = strings.TrimPrefix(model, "/models/")
	model = strings.TrimPrefix(model, "models/")
	return model
}

func looksLikeModelHint(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if len(model) < 3 {
		return false
	}
	if strings.ContainsAny(model, `/\\`) || strings.HasPrefix(model, "http") {
		return false
	}
	for _, prefix := range knownModelPrefixes {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return strings.ContainsAny(model, "0123456789") && strings.ContainsAny(model, "-._")
}

func extractOpenAI(resp map[string]interface{}, info *UsageInfo) *UsageInfo {
	usage, ok := resp["usage"].(map[string]interface{})
	if !ok {
		return nil
	}
	info.PromptTokens = toInt(usage["prompt_tokens"])
	info.CompletionTokens = toInt(usage["completion_tokens"])
	info.TotalTokens = toInt(usage["total_tokens"])
	if info.TotalTokens == 0 {
		info.TotalTokens = info.PromptTokens + info.CompletionTokens
	}
	return info
}

func extractAnthropic(resp map[string]interface{}, info *UsageInfo) *UsageInfo {
	usage, ok := resp["usage"].(map[string]interface{})
	if !ok {
		return nil
	}
	info.PromptTokens = toInt(usage["input_tokens"])
	info.CompletionTokens = toInt(usage["output_tokens"])
	info.TotalTokens = info.PromptTokens + info.CompletionTokens
	return info
}

func extractGoogle(resp map[string]interface{}, info *UsageInfo) *UsageInfo {
	usage, ok := resp["usageMetadata"].(map[string]interface{})
	if !ok {
		return nil
	}
	info.PromptTokens = toInt(usage["promptTokenCount"])
	info.CompletionTokens = toInt(usage["candidatesTokenCount"])
	info.TotalTokens = toInt(usage["totalTokenCount"])
	if info.TotalTokens == 0 {
		info.TotalTokens = info.PromptTokens + info.CompletionTokens
	}
	return info
}

func extractCohere(resp map[string]interface{}, info *UsageInfo) *UsageInfo {
	// Cohere v2 Chat API uses "usage" like OpenAI
	if usage, ok := resp["usage"].(map[string]interface{}); ok {
		info.PromptTokens = toInt(usage["prompt_tokens"])
		if info.PromptTokens == 0 {
			info.PromptTokens = toInt(usage["input_tokens"])
		}
		info.CompletionTokens = toInt(usage["completion_tokens"])
		if info.CompletionTokens == 0 {
			info.CompletionTokens = toInt(usage["output_tokens"])
		}
		info.TotalTokens = info.PromptTokens + info.CompletionTokens
		return info
	}
	// Cohere v1 uses "meta.tokens"
	if meta, ok := resp["meta"].(map[string]interface{}); ok {
		if tokens, ok := meta["tokens"].(map[string]interface{}); ok {
			info.PromptTokens = toInt(tokens["input_tokens"])
			info.CompletionTokens = toInt(tokens["output_tokens"])
			info.TotalTokens = info.PromptTokens + info.CompletionTokens
			return info
		}
	}
	return nil
}

func extractFromSSE(vendor string, data []byte) *UsageInfo {
	raw := string(data)
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	modelHint := ""

	// 先扫描一次 model 线索（有些流式实现将 model 与 usage 分散在不同 data 事件中）。
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		var payload string
		if strings.HasPrefix(line, "data: ") {
			payload = strings.TrimPrefix(line, "data: ")
		} else if strings.HasPrefix(line, "data:") {
			payload = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		} else {
			continue
		}
		if payload == "[DONE]" || payload == "" {
			continue
		}
		var m map[string]interface{}
		if json.Unmarshal([]byte(payload), &m) == nil {
			if mm := deepFindModel(m); mm != "" {
				modelHint = mm
			}
		}
	}

	// 从后往前找带 usage 的 data 行（兼容 "data: " / "data:"）
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		var payload string
		if strings.HasPrefix(line, "data: ") {
			payload = strings.TrimPrefix(line, "data: ")
		} else if strings.HasPrefix(line, "data:") {
			payload = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		} else {
			continue
		}
		if payload == "[DONE]" || payload == "" {
			continue
		}

		info := extractFromJSON(vendor, []byte(payload))
		if info != nil && info.TotalTokens > 0 {
			if info.Model == "" {
				info.Model = modelHint
			}
			return info
		}
	}

	// 整段作为 JSON 再试一次（少数实现不分行）
	if info := extractFromJSON(vendor, data); info != nil && info.TotalTokens > 0 {
		return info
	}
	return nil
}

func toInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		val, _ := n.Int64()
		return int(val)
	default:
		return 0
	}
}
