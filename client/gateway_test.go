package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDetectVendorFromExplicitHeader(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.Header.Set("X-Target-Provider", "deepseek")
	got := detectVendorFromRequest(r)
	if got != "deepseek" {
		t.Errorf("expected deepseek, got %s", got)
	}
	// Header should be removed after detection
	if r.Header.Get("X-Target-Provider") != "" {
		t.Error("X-Target-Provider should be removed after detection")
	}
}

func TestDetectVendorFromAnthropicHeaders(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.Header.Set("Anthropic-Version", "2023-06-01")
	got := detectVendorFromRequest(r)
	if got != "anthropic" {
		t.Errorf("expected anthropic, got %s", got)
	}
}

func TestDetectVendorFromPath(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/messages", nil)
	got := detectVendorFromRequest(r)
	if got != "anthropic" {
		t.Errorf("expected anthropic, got %s", got)
	}
}

func TestDetectVendorFromAPIKey(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.Header.Set("Authorization", "Bearer sk-ant-api03-abcdef")
	got := detectVendorFromRequest(r)
	if got != "anthropic" {
		t.Errorf("expected anthropic, got %s", got)
	}
}

func TestDetectVendorFromModelField(t *testing.T) {
	tests := []struct {
		model  string
		vendor string
	}{
		{"gpt-4o", "openai"},
		{"gpt-4o-mini", "openai"},
		{"o1-preview", "openai"},
		{"o3-mini", "openai"},
		{"claude-3-opus-20240229", "anthropic"},
		{"claude-3.5-sonnet", "anthropic"},
		{"gemini-1.5-pro", "google"},
		{"deepseek-chat", "deepseek"},
		{"deepseek-coder", "deepseek"},
		{"qwen-turbo", "qwen"},
		{"glm-4", "zhipu"},
		{"mistral-large-latest", "mistral"},
		{"command-r-plus", "cohere"},
		{"grok-2", "xai"},
		{"moonshot-v1-8k", "moonshot"},
		{"doubao-pro-4k", "doubao"},
	}
	for _, tt := range tests {
		body := `{"model":"` + tt.model + `","messages":[{"role":"user","content":"hi"}]}`
		r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
		got := detectVendorFromRequest(r)
		if got != tt.vendor {
			t.Errorf("model=%s: expected %s, got %s", tt.model, tt.vendor, got)
		}
		// Verify body was restored
		if r.Body == nil {
			t.Errorf("model=%s: body was not restored", tt.model)
		}
	}
}

func TestDetectVendorDefault(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	got := detectVendorFromRequest(r)
	if got != "openai" {
		t.Errorf("expected default=openai, got %s", got)
	}
}

func TestHandleGatewayRouteIntegration(t *testing.T) {
	// Create a mock upstream server
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"chatcmpl-123","model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}`))
	}))
	defer upstream.Close()

	// Override legacyRoutes for test
	originalRoutes := legacyRoutes["openai"]
	legacyRoutes["openai"] = upstream.URL
	defer func() { legacyRoutes["openai"] = originalRoutes }()

	reporter := &Reporter{cfg: &Config{ServerURL: "http://localhost:9999"}}
	proxy := &ProxyServer{
		cfg:      &Config{},
		reporter: reporter,
		transport: &http.Transport{
			TLSHandshakeTimeout: 5,
		},
	}

	body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	proxy.handleGatewayRoute(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}
