package main

import (
	"testing"
)

func TestShouldOpaqueEstimate(t *testing.T) {
	if shouldOpaqueEstimate("/foo/ReportAgentSnapshot", "gpt-4.1", []byte("not json at all xxx")) {
		t.Fatal("denylist should skip")
	}
	if shouldOpaqueEstimate("/chat/Stream", "gpt-4.1", []byte(`{"model":"x"}`)) {
		t.Fatal("valid JSON should not opaque (handled by JSON path)")
	}
	body := make([]byte, 32)
	for i := range body {
		body[i] = byte(0x80 + i%10)
	}
	if !shouldOpaqueEstimate("/aiserver.v1.AiService/Chat", "gpt-5-high", body) {
		t.Fatal("billable opaque inference should estimate")
	}
	if shouldOpaqueEstimate("/internal/feature-config", "gpt-5-high", body) {
		t.Fatal("non-inference endpoint should skip")
	}
	if shouldOpaqueEstimate("/aiserver.v1.AiService/Chat", "cursor-blame", body) {
		t.Fatal("internal service model should skip")
	}
	if shouldOpaqueEstimate("/aiserver.v1.AiService/Chat", "llamaindex.ai", body) {
		t.Fatal("domain-like hint should skip")
	}
	if shouldOpaqueEstimate("/aiserver.v1.AiService/Chat", "", body) {
		t.Fatal("missing model hint should skip to stay conservative")
	}
}

func TestShouldOpaqueEstimateForChatGPTWeb(t *testing.T) {
	body := []byte(`data: {"message":{"author":{"role":"assistant"},"content":{"parts":["hello"]}}}`)
	if !shouldOpaqueEstimateForVendor("chatgpt", "/backend-api/conversation", "", body) {
		t.Fatal("chatgpt web conversation stream should estimate without usage")
	}
	if shouldOpaqueEstimateForVendor("openai", "/backend-api/conversation", "", body) {
		t.Fatal("non-chatgpt vendor should keep conservative opaque rules")
	}
}

func TestOpaqueTokenSplit(t *testing.T) {
	body := bytesRepeat(100)
	pt, ct, tt := opaqueTokenSplit(body, "/v1/chat/completions")
	if tt <= 0 || pt+ct != tt {
		t.Fatalf("pt=%d ct=%d tt=%d", pt, ct, tt)
	}
}

func TestOpaqueModelLabelWithHint(t *testing.T) {
	if got := opaqueModelLabelWithHint("cursor", "gpt-4.1"); got != "gpt-4.1·opaque(估算)" {
		t.Fatalf("got %q", got)
	}
	if got := opaqueModelLabelWithHint("cursor", ""); got != "cursor·opaque(估算)" {
		t.Fatalf("got %q", got)
	}
	if got := opaqueModelLabelWithHint("cursor", "gpt-4.1·opaque(估算)"); got != "gpt-4.1·opaque(估算)" {
		t.Fatalf("got %q", got)
	}
}

func bytesRepeat(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = 0x41
	}
	return b
}
