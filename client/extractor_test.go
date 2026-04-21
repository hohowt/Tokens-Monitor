package main

import "testing"

// Cursor（api2.cursor.sh）多数请求为 gRPC/Protobuf，响应体不是 JSON，当前 ExtractUsage 无法解析 → 通常无法计入 token。
// 仅当某条路径返回 OpenAI 兼容 JSON（含 usage）时，vendor=cursor 与 openai 使用相同解析逻辑，可被记录。

func TestDeepExtractUsageNested(t *testing.T) {
	const j = `{"choices":[{"index":0,"message":{}}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30},"model":"gpt-4o-mini"}`
	u := ExtractUsage("github-copilot", []byte(j))
	if u == nil || u.TotalTokens != 30 {
		t.Fatalf("got %+v", u)
	}
}

func TestDeepExtractUsageInChoices(t *testing.T) {
	const j = `{"choices":[{"finish_reason":"stop","usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}]}`
	u := ExtractUsage("openai", []byte(j))
	if u == nil || u.TotalTokens != 12 {
		t.Fatalf("got %+v", u)
	}
}

func TestDeepExtractUsageResponsesTokens(t *testing.T) {
	const j = `{"type":"response.completed","response":{"model":"gpt-5.4-codex","usage":{"input_tokens":11,"output_tokens":13,"total_tokens":24}}}`
	u := ExtractUsage("openai", []byte(j))
	if u == nil || u.TotalTokens != 24 || u.PromptTokens != 11 || u.CompletionTokens != 13 || u.Model != "gpt-5.4-codex" {
		t.Fatalf("got %+v", u)
	}
}

func TestCursorVendorOpenAICompatibleJSON(t *testing.T) {
	const j = `{"model":"cursor-small","usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300}}`
	u := ExtractUsage("cursor", []byte(j))
	if u == nil || u.TotalTokens != 300 || u.Model != "cursor-small" {
		t.Fatalf("got %+v", u)
	}
}

func TestCursorVendorSSEWithUsage(t *testing.T) {
	const sse = "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\n"
	u := ExtractUsage("cursor", []byte(sse))
	if u == nil || u.TotalTokens != 3 {
		t.Fatalf("got %+v", u)
	}
}

func TestCursorNonJSONBodyNotRecorded(t *testing.T) {
	// 模拟 gRPC/protobuf 前几个字节，非 JSON → 无法解析
	u := ExtractUsage("cursor", []byte{0x00, 0x01, 0x02, 0x03})
	if u != nil {
		t.Fatalf("expected nil for binary body, got %+v", u)
	}
}

func TestDeepExtractUsageModelFromNestedMetadata(t *testing.T) {
	const j = `{"meta":{"model_name":"claude-3-7-sonnet"},"choices":[{"usage":{"prompt_tokens":11,"completion_tokens":13,"total_tokens":24}}]}`
	u := ExtractUsage("github-copilot", []byte(j))
	if u == nil || u.TotalTokens != 24 || u.Model != "claude-3-7-sonnet" {
		t.Fatalf("got %+v", u)
	}
}

func TestSSEUsageAndModelSplitAcrossEvents(t *testing.T) {
	const sse = "data: {\"model\":\"gpt-4o\",\"type\":\"response.started\"}\n\n" +
		"data: {\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":9,\"total_tokens\":17}}\n\n" +
		"data: [DONE]\n"
	u := ExtractUsage("openai", []byte(sse))
	if u == nil || u.TotalTokens != 17 || u.Model != "gpt-4o" {
		t.Fatalf("got %+v", u)
	}
}

func TestSSEResponsesUsageAndModelSplitAcrossEvents(t *testing.T) {
	const sse = "data: {\"response\":{\"model\":\"gpt-5.4-codex\"},\"type\":\"response.started\"}\n\n" +
		"data: {\"response\":{\"usage\":{\"input_tokens\":8,\"output_tokens\":9,\"total_tokens\":17}}}\n\n" +
		"data: [DONE]\n"
	u := ExtractUsage("openai", []byte(sse))
	if u == nil || u.TotalTokens != 17 || u.PromptTokens != 8 || u.CompletionTokens != 9 || u.Model != "gpt-5.4-codex" {
		t.Fatalf("got %+v", u)
	}
}

func TestInferModelHintFromBinaryPayload(t *testing.T) {
	payload := append([]byte{0x00, 0x02, 0xff, 0x10}, []byte("grpc-bin gpt-5.4 candidate")...)
	if got := inferModelHint(payload); got != "gpt-5.4" {
		t.Fatalf("got %q", got)
	}
}

func TestInferModelHintFromKeyValuePayload(t *testing.T) {
	const payload = "\x00meta model_name:\"claude-3-7-sonnet\"\x01"
	if got := inferModelHint([]byte(payload)); got != "claude-3-7-sonnet" {
		t.Fatalf("got %q", got)
	}
}

func TestInferModelHintFromExpandedFamilies(t *testing.T) {
	cases := map[string]string{
		"glm-5 binary payload": "glm-5",
		"gemma-3 metadata":     "gemma-3",
		"internlm-3 trace":     "internlm-3",
		"baichuan-3 request":   "baichuan-3",
		"phi-3-mini response":  "phi-3-mini",
		"mixtral-8x22b chunk":  "mixtral-8x22b",
		"falcon-180b body":     "falcon-180b",
		"skywork-pro":          "skywork-pro",
		"chatglm3-32k":         "chatglm3-32k",
		"pplx-70b-online":      "pplx-70b-online",
		"replit-code-v1":       "replit-code-v1",
		"command-r-plus":       "command-r-plus",
		"kimi-k2.5":            "kimi-k2.5",
	}
	for payload, want := range cases {
		if got := inferModelHint([]byte(payload)); got != want {
			t.Fatalf("payload %q: got %q want %q", payload, got, want)
		}
	}
}
