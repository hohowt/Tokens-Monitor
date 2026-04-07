package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
)

// ── Gateway auto-detect routing ───────────────────────────────
//
// 当工具直接调用 /v1/chat/completions、/v1/messages 等（没有 /vendor/ 前缀）时，
// 自动检测目标供应商并转发。适用于不能自定义 base URL 前缀的工具。
//
// 检测优先级：
//   1. X-Target-Provider 请求头（显式覆盖）
//   2. Anthropic 特征头（anthropic-version / x-api-key）
//   3. 路径特征（/v1/messages → anthropic）
//   4. API Key 前缀（sk-ant- → anthropic）
//   5. 请求体 model 字段前缀
//   6. 兜底 → openai（最通用格式）

// gatewayModelPrefixes maps model name prefixes to vendor short names.
var gatewayModelPrefixes = []struct {
	prefix string
	vendor string
}{
	{"gpt-", "openai"},
	{"o1", "openai"},
	{"o3", "openai"},
	{"o4", "openai"},
	{"chatgpt", "openai"},
	{"dall-e", "openai"},
	{"claude", "anthropic"},
	{"gemini", "google"},
	{"models/gemini", "google"},
	{"mistral", "mistral"},
	{"codestral", "mistral"},
	{"command", "cohere"},
	{"deepseek", "deepseek"},
	{"qwen", "qwen"},
	{"glm", "zhipu"},
	{"chatglm", "zhipu"},
	{"moonshot", "moonshot"},
	{"doubao", "doubao"},
	{"yi-", "yi"},
	{"ernie", "baidu"},
	{"spark", "spark"},
	{"minimax", "minimax"},
	{"baichuan", "baichuan"},
	{"hunyuan", "hunyuan"},
	{"step", "stepfun"},
	{"grok", "xai"},
	{"llama", "together"},
	{"mixtral", "together"},
}

// detectVendorFromRequest examines headers, path, and body to determine the target vendor.
// It does NOT consume the request body; if read, it restores it via NopCloser.
func detectVendorFromRequest(r *http.Request) string {
	// 1. Explicit header override
	if v := r.Header.Get("X-Target-Provider"); v != "" {
		r.Header.Del("X-Target-Provider")
		return strings.ToLower(strings.TrimSpace(v))
	}

	// 2. Anthropic-specific headers
	if r.Header.Get("Anthropic-Version") != "" {
		return "anthropic"
	}

	// 3. Path-based detection: /v1/messages is Anthropic-specific
	path := r.URL.Path
	if strings.HasPrefix(path, "/v1/messages") {
		return "anthropic"
	}

	// 4. API key prefix (best-effort; many providers use sk- so only match Anthropic-specific)
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer sk-ant-") {
		return "anthropic"
	}

	// 5. Peek at request body model field
	if r.Body != nil && r.ContentLength != 0 {
		bodyBytes, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err == nil && len(bodyBytes) > 0 {
			// Restore body for downstream processing
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			r.ContentLength = int64(len(bodyBytes))

			var req map[string]interface{}
			if json.Unmarshal(bodyBytes, &req) == nil {
				if model, ok := req["model"].(string); ok {
					model = strings.ToLower(model)
					for _, mp := range gatewayModelPrefixes {
						if strings.HasPrefix(model, mp.prefix) {
							return mp.vendor
						}
					}
				}
			}
		}
	}

	// 6. Default to OpenAI (most common compatible format)
	return "openai"
}

// handleGatewayRoute handles /v1/* requests by auto-detecting vendor and delegating
// to the existing handleLegacy reverse proxy pipeline. This enables tools to call
// http://localhost:PORT/v1/chat/completions directly without a /vendor/ prefix.
func (s *ProxyServer) handleGatewayRoute(w http.ResponseWriter, r *http.Request) {
	vendor := detectVendorFromRequest(r)
	targetBase, ok := legacyRoutes[vendor]
	if !ok || targetBase == "" {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"unable to detect target provider; set X-Target-Provider header"}`, http.StatusBadRequest)
		return
	}
	log.Printf("[gateway] %s %s → auto-detected vendor=%s → %s", r.Method, r.URL.Path, vendor, targetBase)
	parts := []string{vendor, strings.TrimPrefix(r.URL.Path, "/")}
	s.handleLegacy(w, r, vendor, targetBase, parts)
}

// newGatewayOnlyHandler wraps ProxyServer to serve only legacy (/vendor/*) and gateway (/v1/*) routes.
// No CONNECT / MITM — safe to run on a plain HTTP port without CA cert trust.
func newGatewayOnlyHandler(proxy *ProxyServer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Status page
		if r.URL.Path == "/" || r.URL.Path == "/status" {
			proxy.statusPage(w, r)
			return
		}
		// Legacy reverse proxy: /openai/v1/...  /anthropic/v1/messages ...
		trimmed := strings.TrimPrefix(r.URL.Path, "/")
		parts := strings.SplitN(trimmed, "/", 2)
		vendor := strings.ToLower(parts[0])
		if targetBase, ok := legacyRoutes[vendor]; ok {
			proxy.handleLegacy(w, r, vendor, targetBase, parts)
			return
		}
		// Gateway auto-detect: /v1/*
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			proxy.handleGatewayRoute(w, r)
			return
		}
		http.Error(w, `{"error":"not found; use /v1/* or /vendor/*"}`, http.StatusNotFound)
	})
}
