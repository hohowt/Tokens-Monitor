package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/http2"
)

// aiDomains maps AI API hostnames to their vendor short name.
// 场景说明：Cursor（*.cursor.sh）；GitHub Copilot（VS Code / Visual Studio 等）；Claude Code（api.anthropic.com 等）；
// OpenCode 上游通常直连各厂商 API（本仓库已列 OpenAI/Anthropic/Google/Bedrock 等），本地 opencode serve 默认 127.0.0.1 为直连、不经 MITM。
var aiDomains = map[string]string{
	// ── OpenAI ──
	"api.openai.com": "openai",

	// ── GitHub Copilot (VS Code, Visual Studio, Kiro 等) ──
	"copilot-proxy.githubusercontent.com": "github-copilot",
	"api.githubcopilot.com":               "github-copilot",
	"api.individual.githubcopilot.com":    "github-copilot",
	"api.business.githubcopilot.com":      "github-copilot",
	"api.enterprise.githubcopilot.com":    "github-copilot",

	// ── GitHub Models ──
	"models.inference.ai.azure.com": "github-models",

	// ── Cursor（IDE 及遥测；通配见 aiWildcardDomains *.cursor.sh）──
	"api2.cursor.sh":    "cursor",
	"api3.cursor.sh":    "cursor",
	"api.cursor.com":    "cursor",
	"metrics.cursor.sh": "cursor",

	// ── Anthropic / Claude Code（CLI 默认 api.anthropic.com；Bedrock 见通配）──
	"api.anthropic.com": "anthropic",

	// ── Google ──
	"generativelanguage.googleapis.com": "google",
	"aiplatform.googleapis.com":         "google-vertex",

	// ── Mistral / Codestral ──
	"api.mistral.ai":       "mistral",
	"codestral.mistral.ai": "mistral",

	// ── Cohere ──
	"api.cohere.com": "cohere",

	// ── xAI (Grok) ──
	"api.x.ai": "xai",

	// ── Perplexity ──
	"api.perplexity.ai": "perplexity",

	// ── Together ──
	"api.together.xyz": "together",
	"api.together.ai":  "together",

	// ── Groq ──
	"api.groq.com": "groq",

	// ── Replicate ──
	"api.replicate.com": "replicate",

	// ── Hugging Face ──
	"api-inference.huggingface.co": "huggingface",
	"router.huggingface.co":        "huggingface",

	// ── Fireworks ──
	"api.fireworks.ai": "fireworks",

	// ── OpenRouter（Continue、LibreChat、自建客户端等常用聚合端点）──
	"openrouter.ai":     "openrouter",
	"api.openrouter.ai": "openrouter",

	// ── Tabnine ──
	"api.tabnine.com": "tabnine",

	// ── Codeium / Windsurf Cascade（文档中 Cascade 与 Codeium 共用 server.codeium.com）──
	"api.codeium.com":    "codeium",
	"server.codeium.com": "codeium",

	// ── JetBrains AI Assistant ──
	"api.jetbrains.ai":     "jetbrains-ai",
	"llm.api.jetbrains.ai": "jetbrains-ai",

	// ── Sourcegraph Cody Gateway ──
	"cody-gateway.sourcegraph.com": "sourcegraph-cody",

	// ── Augment Code ──
	"api.augmentcode.com":     "augment",
	"dialapi.augmentcode.com": "augment",

	// ── fal.ai（部分工作流 / 插件）──
	"fal.run":    "fal",
	"api.fal.ai": "fal",

	// ── China ──
	"api.deepseek.com":            "deepseek",
	"api.moonshot.cn":             "moonshot",
	"open.bigmodel.cn":            "zhipu",
	"aip.baidubce.com":            "baidu",
	"api.minimax.chat":            "minimax",
	"dashscope.aliyuncs.com":      "qwen",
	"api.lingyiwanwu.com":         "yi",
	"ark.cn-beijing.volces.com":   "doubao",
	"api.baichuan-ai.com":         "baichuan",
	"hunyuan.tencentcloudapi.com": "hunyuan",
	"spark-api-open.xf-yun.com":   "spark",
	"api.sensenova.cn":            "sensetime",
	"api.stepfun.com":             "stepfun",
	"api.tiangong.cn":             "skywork",
	"api.siliconflow.cn":          "siliconflow",
}

// aiWildcardDomains matches AI hostnames by suffix (and optional prefix).
// Checked when exact aiDomains lookup misses.
var aiWildcardDomains = []struct {
	suffix, prefix, vendor string
}{
	// Azure OpenAI: *.openai.azure.com
	{suffix: ".openai.azure.com", vendor: "azure"},
	// AWS Bedrock: bedrock-runtime.*.amazonaws.com
	{suffix: ".amazonaws.com", prefix: "bedrock-runtime.", vendor: "aws-bedrock"},
	{suffix: ".amazonaws.com", prefix: "bedrock.", vendor: "aws-bedrock"},
	// Google Vertex AI: *-aiplatform.googleapis.com
	{suffix: "-aiplatform.googleapis.com", vendor: "google-vertex"},
	// AWS SageMaker: *.sagemaker.aws
	{suffix: ".sagemaker.aws", vendor: "aws-sagemaker"},
	// Amazon CodeWhisperer：codewhisperer.<region>.amazonaws.com
	{suffix: ".amazonaws.com", prefix: "codewhisperer.", vendor: "aws-codewhisperer"},
	// Amazon Q Developer API：q.<region>.amazonaws.com
	{suffix: ".amazonaws.com", prefix: "q.", vendor: "aws-q"},
	// Azure AI Inference / Foundry 等：*.inference.azure.com
	{suffix: ".inference.azure.com", vendor: "azure-inference"},
	// Cursor 新增子域（如未来 api*.cursor.sh）
	{suffix: ".cursor.sh", vendor: "cursor"},
	// GitHub Copilot 新增子域
	{suffix: ".githubcopilot.com", vendor: "github-copilot"},
}

// matchAIDomain 判断主机名是否应走 MITM，并返回供应商标签（内置表 + config 扩展）。
func (s *ProxyServer) matchAIDomain(hostname string) (string, bool) {
	if vendor, ok := aiDomains[hostname]; ok {
		return vendor, true
	}
	if s.cfg != nil && len(s.cfg.ExtraMonitorHosts) > 0 {
		if v, ok := s.cfg.ExtraMonitorHosts[hostname]; ok {
			v = strings.TrimSpace(v)
			if v != "" {
				return v, true
			}
		}
	}
	for _, w := range aiWildcardDomains {
		if strings.HasSuffix(hostname, w.suffix) {
			if w.prefix == "" || strings.HasPrefix(hostname, w.prefix) {
				return w.vendor, true
			}
		}
	}
	if s.cfg != nil {
		for _, e := range s.cfg.ExtraMonitorSuffixes {
			suf := strings.TrimSpace(e.Suffix)
			vend := strings.TrimSpace(e.Vendor)
			if suf == "" || vend == "" {
				continue
			}
			if strings.HasSuffix(hostname, suf) {
				return vend, true
			}
		}
	}
	return "", false
}

// legacyRoutes maps vendor short names to upstream API base URLs.
var legacyRoutes = map[string]string{
	"openai":      "https://api.openai.com",
	"anthropic":   "https://api.anthropic.com",
	"google":      "https://generativelanguage.googleapis.com",
	"azure":       "",
	"mistral":     "https://api.mistral.ai",
	"cohere":      "https://api.cohere.com",
	"xai":         "https://api.x.ai",
	"perplexity":  "https://api.perplexity.ai",
	"together":    "https://api.together.xyz",
	"groq":        "https://api.groq.com",
	"amazon":      "",
	"deepseek":    "https://api.deepseek.com",
	"moonshot":    "https://api.moonshot.cn",
	"zhipu":       "https://open.bigmodel.cn",
	"baidu":       "https://aip.baidubce.com",
	"minimax":     "https://api.minimax.chat",
	"qwen":        "https://dashscope.aliyuncs.com",
	"yi":          "https://api.lingyiwanwu.com",
	"doubao":      "https://ark.cn-beijing.volces.com",
	"baichuan":    "https://api.baichuan-ai.com",
	"hunyuan":     "https://hunyuan.tencentcloudapi.com",
	"spark":       "https://spark-api-open.xf-yun.com",
	"sensetime":   "https://api.sensenova.cn",
	"stepfun":     "https://api.stepfun.com",
	"skywork":     "https://api.tiangong.cn",
	"siliconflow": "https://api.siliconflow.cn",
}

// ProxyServer is a forward proxy with selective MITM for AI domains
// and backward-compatible reverse proxy for /vendor/path routes.
type ProxyServer struct {
	cfg       *Config
	reporter  *Reporter
	certMgr   *CertManager
	transport *http.Transport
}

func NewProxyServer(cfg *Config, reporter *Reporter, certMgr *CertManager) *ProxyServer {
	proxyFunc := func(*http.Request) (*url.URL, error) { return nil, nil }
	if cfg != nil && strings.TrimSpace(cfg.UpstreamProxy) != "" {
		proxyURL, err := url.Parse(cfg.UpstreamProxy)
		if err != nil {
			log.Printf("[proxy] invalid upstream_proxy %q: %v (fall back direct)", cfg.UpstreamProxy, err)
		} else {
			proxyFunc = http.ProxyURL(proxyURL)
			log.Printf("[proxy] upstream proxy enabled: %s", proxyURL.Redacted())
		}
	}
	return &ProxyServer{
		cfg:      cfg,
		reporter: reporter,
		certMgr:  certMgr,
		transport: &http.Transport{
			// 默认直连，避免外连 AI 再次进本机代理形成环路；仅在显式配置 upstream_proxy 时走上游代理。
			Proxy:               proxyFunc,
			TLSHandshakeTimeout: 15 * time.Second,
			MaxIdleConns:        200,
			IdleConnTimeout:     90 * time.Second,
		},
	}
}

func (s *ProxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		s.handleConnect(w, r)
		return
	}

	// Status page
	if (r.URL.Host == "" || r.URL.Host == r.Host) && (r.URL.Path == "/" || r.URL.Path == "/status") {
		s.statusPage(w, r)
		return
	}

	// Legacy reverse proxy: /openai/v1/...
	if r.URL.Host == "" || r.URL.Host == r.Host {
		trimmed := strings.TrimPrefix(r.URL.Path, "/")
		parts := strings.SplitN(trimmed, "/", 2)
		vendor := strings.ToLower(parts[0])
		if targetBase, ok := legacyRoutes[vendor]; ok {
			s.handleLegacy(w, r, vendor, targetBase, parts)
			return
		}
	}

	// Gateway auto-detect: /v1/* routes (no vendor prefix needed)
	if r.URL.Host == "" || r.URL.Host == r.Host {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			s.handleGatewayRoute(w, r)
			return
		}
	}

	// HTTP forward proxy (absolute URL)
	if r.URL.IsAbs() {
		s.handleHTTPForward(w, r)
		return
	}

	http.Error(w, "Bad Request", http.StatusBadRequest)
}

// ── CONNECT handler ───────────────────────────────────────────

func (s *ProxyServer) handleConnect(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}
	hostname := host[:strings.LastIndex(host, ":")]

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	vendor, isAI := s.matchAIDomain(hostname)
	if isAI && s.certMgr != nil {
		log.Printf("[CONNECT] MITM → %s (%s)", hostname, vendor)
		go s.mitmConnection(clientConn, host, hostname, vendor)
	} else {
		log.Printf("[CONNECT] tunnel → %s", hostname)
		go s.tunnelConnection(clientConn, host)
	}
}

func (s *ProxyServer) tunnelConnection(clientConn net.Conn, host string) {
	defer clientConn.Close()
	serverConn, err := net.DialTimeout("tcp", host, 15*time.Second)
	if err != nil {
		return
	}
	defer serverConn.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(serverConn, clientConn); done <- struct{}{} }()
	go func() { io.Copy(clientConn, serverConn); done <- struct{}{} }()
	<-done
}

// mitmConnection intercepts TLS traffic for AI domains.
func (s *ProxyServer) mitmConnection(clientConn net.Conn, host, hostname, vendor string) {
	defer clientConn.Close()

	cert, err := s.certMgr.GetCert(hostname)
	if err != nil {
		log.Printf("[MITM] cert error %s: %v", hostname, err)
		return
	}

	tlsConn := tls.Server(clientConn, &tls.Config{
		Certificates: []tls.Certificate{*cert},
		// 与上游一致：Copilot / 多数云 API 默认 HTTP/2（ALPN h2）；仅 http/1.1 时客户端无法对话。
		NextProtos: []string{"h2", "http/1.1"},
	})
	if err := tlsConn.Handshake(); err != nil {
		log.Printf("[MITM] handshake error %s: %v", hostname, err)
		return
	}
	defer tlsConn.Close()

	if tlsConn.ConnectionState().NegotiatedProtocol == "h2" {
		s.serveMitmHTTP2(tlsConn, hostname, vendor)
		return
	}

	reader := bufio.NewReader(tlsConn)

	for {
		req, err := http.ReadRequest(reader)
		if err != nil {
			// Check if client tried HTTP/2
			if reader.Buffered() > 0 {
				peek, _ := reader.Peek(reader.Buffered())
				log.Printf("[MITM] read error %s: %v (buffered=%d, prefix=%q)", hostname, err, len(peek), string(peek[:min(len(peek), 24)]))
			} else if err.Error() != "EOF" {
				log.Printf("[MITM] read error %s: %v", hostname, err)
			}
			return
		}

		req.URL.Scheme = "https"
		req.URL.Host = hostname
		req.RequestURI = ""

		requestModel := s.processRequestBody(req)
		req.Header.Del("Accept-Encoding")
		endpoint := req.URL.Path

		resp, err := s.transport.RoundTrip(req)
		if err != nil {
			log.Printf("[MITM] forward error %s%s: %v", hostname, endpoint, err)
			errResp := &http.Response{
				StatusCode: http.StatusBadGateway,
				Proto:      "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
				Header:        http.Header{"Content-Type": {"application/json"}, "Connection": {"close"}},
				Body:          io.NopCloser(strings.NewReader(fmt.Sprintf(`{"error":"proxy: %v"}`, err))),
				ContentLength: -1,
			}
			errResp.Write(tlsConn)
			return
		}

		log.Printf("[MITM] %s %s%s → %d", req.Method, hostname, endpoint, resp.StatusCode)

		if resp.StatusCode < 400 {
			var buf bytes.Buffer
			resp.Body = &recordingBody{
				ReadCloser: resp.Body,
				buf:        &buf,
				onClose: func(data []byte) {
					s.processResponseData(vendor, endpoint, requestModel, data)
				},
			}
		}

		if err := resp.Write(tlsConn); err != nil {
			return
		}
	}
}

// serveMitmHTTP2 在已协商 ALPN=h2 的 TLS 连接上处理 HTTP/2 请求（与 GitHub Copilot 等客户端一致）。
func (s *ProxyServer) serveMitmHTTP2(tlsConn *tls.Conn, hostname, vendor string) {
	h2s := &http2.Server{}
	h2s.ServeConn(tlsConn, &http2.ServeConnOpts{
		Context: context.Background(),
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.URL.Scheme = "https"
			if r.URL.Host == "" {
				r.URL.Host = hostname
			}
			r.RequestURI = ""

			requestModel := s.processRequestBody(r)
			r.Header.Del("Accept-Encoding")
			endpoint := r.URL.Path

			resp, err := s.transport.RoundTrip(r)
			if err != nil {
				log.Printf("[MITM/h2] forward error %s%s: %v", hostname, endpoint, err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"proxy: %v"}`, err)))
				return
			}

			log.Printf("[MITM/h2] %s %s%s → %d", r.Method, hostname, endpoint, resp.StatusCode)

			if resp.StatusCode < 400 {
				var buf bytes.Buffer
				resp.Body = &recordingBody{
					ReadCloser: resp.Body,
					buf:        &buf,
					onClose: func(data []byte) {
						s.processResponseData(vendor, endpoint, requestModel, data)
					},
				}
			}
			defer resp.Body.Close()

			for k, vs := range resp.Header {
				for _, v := range vs {
					w.Header().Add(k, v)
				}
			}
			w.WriteHeader(resp.StatusCode)
			if resp.Body != nil {
				io.Copy(w, resp.Body)
			}
		}),
	})
}

// ── HTTP forward proxy ────────────────────────────────────────

func (s *ProxyServer) handleHTTPForward(w http.ResponseWriter, r *http.Request) {
	hostname := r.URL.Hostname()
	vendor, isAI := s.matchAIDomain(hostname)

	requestModel := ""
	if isAI {
		requestModel = s.processRequestBody(r)
		r.Header.Del("Accept-Encoding")
	}

	resp, err := s.transport.RoundTrip(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	if isAI && resp.StatusCode < 400 {
		var buf bytes.Buffer
		tee := io.TeeReader(resp.Body, &buf)
		io.Copy(w, tee)
		go s.processResponseData(vendor, r.URL.Path, requestModel, buf.Bytes())
	} else {
		io.Copy(w, resp.Body)
	}
}

// ── Legacy reverse proxy (/vendor/path) ───────────────────────

func (s *ProxyServer) handleLegacy(w http.ResponseWriter, r *http.Request, vendor, targetBase string, parts []string) {
	remaining := "/"
	if len(parts) > 1 {
		remaining = "/" + parts[1]
	}

	if vendor == "azure" || vendor == "amazon" {
		if ep := r.Header.Get("X-Azure-Endpoint"); ep != "" {
			targetBase = ep
			r.Header.Del("X-Azure-Endpoint")
		} else if ep := r.Header.Get("X-Endpoint"); ep != "" {
			targetBase = ep
			r.Header.Del("X-Endpoint")
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": vendor + " 需要设置 X-Endpoint 请求头"})
			return
		}
	}

	if targetBase == "" {
		http.Error(w, "unknown vendor", http.StatusBadRequest)
		return
	}

	requestModel := s.processRequestBody(r)

	target, err := url.Parse(targetBase)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.URL.Path = remaining
			req.URL.RawQuery = r.URL.RawQuery
			req.Host = target.Host
			req.Header.Del("Accept-Encoding")
		},
		ModifyResponse: func(resp *http.Response) error {
			if resp.StatusCode >= 400 {
				return nil
			}
			if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
				var buf bytes.Buffer
				resp.Body = &recordingBody{
					ReadCloser: resp.Body, buf: &buf,
					onClose: func(data []byte) { s.processResponseData(vendor, remaining, requestModel, data) },
				}
				return nil
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				return err
			}
			s.processResponseData(vendor, remaining, requestModel, body)
			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			return nil
		},
		FlushInterval: -1,
		Transport:     s.transport,
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("[legacy] forward error %s: %v", targetBase+remaining, err)
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(rw).Encode(map[string]string{"error": err.Error()})
		},
	}

	log.Printf("[legacy] %s %s → %s%s", r.Method, vendor, targetBase, remaining)
	proxy.ServeHTTP(w, r)
}

// ── Shared helpers ────────────────────────────────────────────

// shouldInjectOpenAIStreamOptions 判断是否可注入 OpenAI 专有的 stream_options。
// Anthropic Messages API、Copilot→Claude 等请求若带上该字段会 400（Extra inputs are not permitted）。
func shouldInjectOpenAIStreamOptions(r *http.Request, reqData map[string]interface{}) bool {
	if _, ok := reqData["anthropic_version"]; ok {
		return false
	}
	host := strings.ToLower(r.URL.Hostname())
	path := strings.ToLower(r.URL.Path)
	if strings.Contains(host, "anthropic.com") {
		return false
	}
	// Copilot 网关（含 Claude）；勿注入 OpenAI 专有字段
	if strings.Contains(host, "githubcopilot.com") ||
		strings.Contains(host, "copilot-proxy.githubusercontent.com") {
		return false
	}
	if strings.Contains(host, "api.openai.com") || strings.Contains(host, "openai.azure.com") {
		return true
	}
	// 标准 OpenAI Chat Completions 路径（多数兼容网关）
	if strings.Contains(path, "/v1/chat/completions") {
		return true
	}
	return false
}

func (s *ProxyServer) processRequestBody(r *http.Request) string {
	if r.Body == nil || r.ContentLength == 0 {
		return ""
	}
	bodyBytes, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil || len(bodyBytes) == 0 {
		return ""
	}

	var reqData map[string]interface{}
	if json.Unmarshal(bodyBytes, &reqData) != nil {
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		r.ContentLength = int64(len(bodyBytes))
		return inferModelHint(bodyBytes)
	}

	model, _ := reqData["model"].(string)
	if model == "" {
		model = deepFindModel(reqData)
	}

	// 仅对 OpenAI Chat Completions 类 API 注入 stream_options（含 include_usage）。
	// Anthropic、GitHub Copilot（含 Claude 后端）等会拒绝未知字段，报 invalid_request_error。
	if stream, ok := reqData["stream"].(bool); ok && stream {
		if _, has := reqData["stream_options"]; !has && shouldInjectOpenAIStreamOptions(r, reqData) {
			reqData["stream_options"] = map[string]interface{}{"include_usage": true}
			if modified, err := json.Marshal(reqData); err == nil {
				bodyBytes = modified
			}
		}
	}

	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	r.ContentLength = int64(len(bodyBytes))
	if model == "" {
		model = inferModelHint(bodyBytes)
	}
	return model
}

func (s *ProxyServer) processResponseData(vendor, endpoint, requestModel string, data []byte) {
	usage := ExtractUsage(vendor, data)
	if usage != nil && usage.TotalTokens > 0 {
		model := usage.Model
		if model == "" {
			model = requestModel
		}
		if model == "" {
			model = inferModelHint(data)
		}
		if model == "" {
			model = "unknown"
		}
		s.reporter.Add(UsageRecord{
			Vendor:           vendor,
			Model:            model,
			Endpoint:         endpoint,
			PromptTokens:     usage.PromptTokens,
			CompletionTokens: usage.CompletionTokens,
			TotalTokens:      usage.TotalTokens,
			Source:           "client",
		})
		return
	}

	// gRPC/Protobuf 等：响应体非 JSON 或不含 usage，按配置做体积粗算，使 135 可见（非官方计费）。
	if s.cfg == nil || !s.cfg.EffectiveReportOpaqueTraffic() {
		return
	}
	modelHint := requestModel
	if modelHint == "" {
		modelHint = inferModelHint(data)
	}
	if !shouldOpaqueEstimate(endpoint, modelHint, data) {
		return
	}
	pt, ct, tt := opaqueTokenSplit(data)
	if tt <= 0 {
		return
	}
	s.reporter.Add(UsageRecord{
		Vendor:           vendor,
		Model:            opaqueModelLabelWithHint(vendor, modelHint),
		Endpoint:         endpoint,
		PromptTokens:     pt,
		CompletionTokens: ct,
		TotalTokens:      tt,
		Source:           opaqueSourceEstimate,
	})
}

func (s *ProxyServer) statusPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":                 "running",
		"version":                Version,
		"mode":                   "transparent-mitm",
		"user":                   s.cfg.UserName,
		"department":             s.cfg.Department,
		"source_app":             s.reporter.sourceApp,
		"server":                 s.cfg.ServerURL,
		"ai_domains":             len(aiDomains),
		"ai_wildcard_patterns":   len(aiWildcardDomains),
		"extra_monitor_hosts":    len(s.cfg.ExtraMonitorHosts),
		"extra_monitor_suffixes": len(s.cfg.ExtraMonitorSuffixes),
		"stats": map[string]interface{}{
			"total_reported": s.reporter.Stats.TotalReported,
			"total_tokens":   s.reporter.Stats.TotalTokens,
		},
	})
}

// recordingBody wraps an io.ReadCloser, recording all bytes read.
type recordingBody struct {
	io.ReadCloser
	buf     *bytes.Buffer
	onClose func([]byte)
}

func (r *recordingBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.buf.Write(p[:n])
	}
	return n, err
}

func (r *recordingBody) Close() error {
	err := r.ReadCloser.Close()
	if r.onClose != nil {
		data := make([]byte, r.buf.Len())
		copy(data, r.buf.Bytes())
		go r.onClose(data)
	}
	return err
}
