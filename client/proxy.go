package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
)

// aiDomains maps AI API hostnames to their vendor short name.
// 场景说明：Cursor（*.cursor.sh）；GitHub Copilot（VS Code / Visual Studio 等）；Claude Code（api.anthropic.com 等）；
// OpenCode 上游通常直连各厂商 API（本仓库已列 OpenAI/Anthropic/Google/Bedrock 等），本地 opencode serve 默认 127.0.0.1 为直连、不经 MITM。
var aiDomains = map[string]string{
	// ── OpenAI ──
	"api.openai.com": "openai",

	// ── ChatGPT Web (网页版，无标准 usage 字段，走体积估算) ──
	"chatgpt.com":     "chatgpt",
	"ab.chatgpt.com":  "chatgpt",
	"chat.openai.com": "chatgpt",

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
	hostname = normalizeProxyHostname(hostname)
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

func normalizeProxyHostname(hostname string) string {
	hostname = strings.TrimSpace(strings.ToLower(hostname))
	hostname = strings.TrimSuffix(hostname, ".")
	return hostname
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
	cfg              *Config
	configPath       string // path to config.json (for runtime wizard updates)
	reporter         *Reporter
	certMgr          *CertManager
	transport        *http.Transport
	upstreamProxy    *url.URL  // parsed upstream proxy; nil = direct
	listenPort       int       // actual bound port (set after listen)
	startedAt        time.Time // when process started
	copilotMu        sync.RWMutex
	copilotDiscounts map[string]float64
}

func NewProxyServer(cfg *Config, reporter *Reporter, certMgr *CertManager, configPath string) *ProxyServer {
	// Auto-detect upstream proxy (config > system proxy > env vars)
	upstreamAddr := detectUpstreamProxy(cfg)
	proxyFunc := func(*http.Request) (*url.URL, error) { return nil, nil }
	var upstreamURL *url.URL
	if upstreamAddr != "" {
		proxyURL, err := url.Parse(upstreamAddr)
		if err != nil {
			log.Printf("[proxy] invalid upstream proxy %q: %v (fall back direct)", upstreamAddr, err)
		} else {
			proxyFunc = http.ProxyURL(proxyURL)
			upstreamURL = proxyURL
			log.Printf("[proxy] upstream proxy: %s", proxyURL.Redacted())
		}
	} else {
		log.Printf("[proxy] no upstream proxy detected, using direct connection")
	}
	return &ProxyServer{
		cfg:              cfg,
		configPath:       configPath,
		reporter:         reporter,
		certMgr:          certMgr,
		upstreamProxy:    upstreamURL,
		startedAt:        time.Now(),
		copilotDiscounts: map[string]float64{},
		transport: &http.Transport{
			// 默认直连，避免外连 AI 再次进本机代理形成环路；仅在显式配置或自动检测到 upstream_proxy 时走上游代理。
			Proxy:               proxyFunc,
			TLSHandshakeTimeout: 15 * time.Second,
			MaxIdleConns:        200,
			IdleConnTimeout:     90 * time.Second,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
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

	// Wizard management page (accessible while monitoring is running)
	if (r.URL.Host == "" || r.URL.Host == r.Host) && strings.HasPrefix(r.URL.Path, "/wizard") {
		s.serveWizard(w, r)
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
	hostname := normalizeProxyHostname(host[:strings.LastIndex(host, ":")])

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
		go safeGo("mitm "+hostname, func() { s.mitmConnection(clientConn, host, hostname, vendor) })
	} else if isAI {
		log.Printf("[CONNECT] tunnel → %s (%s, no cert manager)", hostname, vendor)
		go safeGo("tunnel "+hostname, func() { s.tunnelConnection(clientConn, host) })
	} else {
		log.Printf("[CONNECT] tunnel → %s", hostname)
		go safeGo("tunnel "+hostname, func() { s.tunnelConnection(clientConn, host) })
	}
}

// safeGo runs fn with panic recovery so a single malformed request can't crash
// the entire proxy process — which, on a user's machine with system proxy /
// PAC pointing at us, would make every HTTPS site fall back to DIRECT and
// leave HTTP_PROXY env vars pointing at a dead port.
func safeGo(label string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[panic] %s: %v", label, r)
		}
	}()
	fn()
}

func (s *ProxyServer) tunnelConnection(clientConn net.Conn, host string) {
	defer clientConn.Close()

	var serverConn net.Conn
	var err error

	if s.upstreamProxy != nil {
		serverConn, err = s.dialViaUpstreamProxy(host)
	} else {
		serverConn, err = net.DialTimeout("tcp", host, 15*time.Second)
	}
	if err != nil {
		log.Printf("[tunnel] dial %s: %v", host, err)
		return
	}
	defer serverConn.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(serverConn, clientConn); done <- struct{}{} }()
	go func() { io.Copy(clientConn, serverConn); done <- struct{}{} }()
	<-done
}

// dialViaUpstreamProxy establishes a TCP tunnel through the upstream HTTP proxy
// by sending a CONNECT request. This ensures non-AI HTTPS traffic also chains
// through the user's corporate/VPN proxy.
func (s *ProxyServer) dialViaUpstreamProxy(targetHost string) (net.Conn, error) {
	proxyAddr := s.upstreamProxy.Host
	if !strings.Contains(proxyAddr, ":") {
		port := s.upstreamProxy.Port()
		if port == "" {
			if s.upstreamProxy.Scheme == "https" {
				port = "443"
			} else {
				port = "80"
			}
		}
		proxyAddr = net.JoinHostPort(s.upstreamProxy.Hostname(), port)
	}

	proxyConn, err := net.DialTimeout("tcp", proxyAddr, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect upstream proxy %s: %w", proxyAddr, err)
	}

	connectReq := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", targetHost, targetHost)
	if s.upstreamProxy.User != nil {
		// Basic auth for upstream proxy
		password, _ := s.upstreamProxy.User.Password()
		auth := s.upstreamProxy.User.Username() + ":" + password
		encoded := base64.StdEncoding.EncodeToString([]byte(auth))
		connectReq += "Proxy-Authorization: Basic " + encoded + "\r\n"
	}
	connectReq += "\r\n"

	if _, err := proxyConn.Write([]byte(connectReq)); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("write CONNECT to upstream: %w", err)
	}

	br := bufio.NewReader(proxyConn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("read CONNECT response from upstream: %w", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		proxyConn.Close()
		return nil, fmt.Errorf("upstream proxy CONNECT returned %d", resp.StatusCode)
	}

	return proxyConn, nil
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
		NextProtos: mitmClientALPN(vendor),
		MinVersion: tls.VersionTLS12,
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
		sourceApp := inferSourceAppFromHeaders(req.Header)
		req.Header.Del("Accept-Encoding")
		endpoint := req.URL.Path

		if isWebSocketUpgrade(req) {
			s.handleWebSocketMITM(tlsConn, req, host, hostname, vendor, endpoint, requestModel, sourceApp)
			return
		}

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
					s.processResponseData(vendor, endpoint, requestModel, sourceApp, data)
				},
			}
		}

		if err := resp.Write(tlsConn); err != nil {
			return
		}
	}
}

func mitmClientALPN(vendor string) []string {
	if strings.EqualFold(vendor, "chatgpt") {
		return []string{"http/1.1"}
	}
	return []string{"h2", "http/1.1"}
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
			sourceApp := inferSourceAppFromHeaders(r.Header)
			r.Header.Del("Accept-Encoding")
			endpoint := r.URL.Path

			// 调试：仅截取前 4KB 用于日志；必须转发完整请求体（Copilot 等 POST 常远大于 4KB，
			// 截断会导致上游 Content-Length 与实际 body 不一致并触发 net/http ContentLength 错误）。
			var reqBodyDump []byte
			if r.Body != nil {
				fullBody, readErr := io.ReadAll(r.Body)
				if readErr != nil {
					log.Printf("[MITM/h2] read request body %s%s: %v", hostname, endpoint, readErr)
					http.Error(w, readErr.Error(), http.StatusBadRequest)
					return
				}
				if len(fullBody) > 4096 {
					reqBodyDump = append([]byte(nil), fullBody[:4096]...)
				} else {
					reqBodyDump = fullBody
				}
				r.Body = io.NopCloser(bytes.NewReader(fullBody))
				r.ContentLength = int64(len(fullBody))
			}

			resp, err := s.transport.RoundTrip(r)
			if err != nil {
				log.Printf("[MITM/h2] forward error %s%s: %v", hostname, endpoint, err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"proxy: %v"}`, err)))
				return
			}

			log.Printf("[MITM/h2] %s %s%s → %d", r.Method, hostname, endpoint, resp.StatusCode)

			if resp.StatusCode >= 400 && resp.StatusCode < 500 {
				// 临时调试：打印 4xx 响应体片段；转发给客户端的头部必须与截断后的 body 一致。
				peek, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
				resp.Body.Close()
				log.Printf("[MITM/h2 debug] %s%s req=%q resp=%q", hostname, endpoint, string(reqBodyDump), string(peek))
				resp.Body = io.NopCloser(bytes.NewReader(peek))
				resp.ContentLength = int64(len(peek))
				resp.Header.Del("Transfer-Encoding")
				resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(peek)))
			} else if resp.StatusCode < 400 {
				var buf bytes.Buffer
				resp.Body = &recordingBody{
					ReadCloser: resp.Body,
					buf:        &buf,
					onClose: func(data []byte) {
						s.processResponseData(vendor, endpoint, requestModel, sourceApp, data)
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
				if isStreamingResponse(resp.Header) {
					streamCopy(w, resp.Body)
				} else {
					io.Copy(w, resp.Body)
				}
			}
		}),
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	if r == nil {
		return false
	}
	return headerHasToken(r.Header, "Connection", "upgrade") &&
		strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

func headerHasToken(h http.Header, key, token string) bool {
	token = strings.ToLower(strings.TrimSpace(token))
	for _, value := range h.Values(key) {
		for _, part := range strings.Split(value, ",") {
			if strings.ToLower(strings.TrimSpace(part)) == token {
				return true
			}
		}
	}
	return false
}

func (s *ProxyServer) handleWebSocketMITM(clientConn net.Conn, req *http.Request, host, hostname, vendor, endpoint, requestModel, sourceApp string) {
	upstreamConn, err := s.dialTLSUpstream(hostname, host)
	if err != nil {
		log.Printf("[MITM/ws] dial %s%s: %v", hostname, endpoint, err)
		writeHTTPErrorToConn(clientConn, http.StatusBadGateway, fmt.Sprintf("proxy websocket dial: %v", err))
		return
	}
	defer upstreamConn.Close()

	req.Header.Del("Proxy-Connection")
	req.Header.Del("Accept-Encoding")
	req.RequestURI = ""
	req.URL.Scheme = "https"
	req.URL.Host = hostname

	if err := req.Write(upstreamConn); err != nil {
		log.Printf("[MITM/ws] write request %s%s: %v", hostname, endpoint, err)
		return
	}

	upstreamReader := bufio.NewReader(upstreamConn)
	resp, err := http.ReadResponse(upstreamReader, req)
	if err != nil {
		log.Printf("[MITM/ws] read response %s%s: %v", hostname, endpoint, err)
		writeHTTPErrorToConn(clientConn, http.StatusBadGateway, fmt.Sprintf("proxy websocket response: %v", err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		peek, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		log.Printf("[MITM/ws] %s %s%s → %d body=%q", req.Method, hostname, endpoint, resp.StatusCode, string(peek))
		resp.Body = io.NopCloser(bytes.NewReader(peek))
		resp.ContentLength = int64(len(peek))
		resp.Header.Del("Transfer-Encoding")
		resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(peek)))
		if err := resp.Write(clientConn); err != nil {
			return
		}
		return
	}

	log.Printf("[MITM/ws] %s %s%s → %d", req.Method, hostname, endpoint, resp.StatusCode)
	if err := resp.Write(clientConn); err != nil {
		return
	}

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstreamConn, clientConn)
		done <- struct{}{}
	}()
	go func() {
		_ = copyWebSocketServerToClient(clientConn, upstreamReader, func(payload []byte) {
			s.processResponseData(vendor, endpoint, requestModel, sourceApp, payload)
		})
		done <- struct{}{}
	}()
	<-done
}

func (s *ProxyServer) dialTLSUpstream(hostname, host string) (*tls.Conn, error) {
	var rawConn net.Conn
	var err error
	if s.upstreamProxy != nil {
		rawConn, err = s.dialViaUpstreamProxy(host)
	} else {
		rawConn, err = net.DialTimeout("tcp", host, 15*time.Second)
	}
	if err != nil {
		return nil, err
	}
	tlsConn := tls.Client(rawConn, &tls.Config{
		ServerName: hostname,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	})
	if err := tlsConn.Handshake(); err != nil {
		rawConn.Close()
		return nil, err
	}
	return tlsConn, nil
}

func writeHTTPErrorToConn(conn net.Conn, status int, msg string) {
	resp := &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": {"text/plain; charset=utf-8"}, "Connection": {"close"}},
		Body:          io.NopCloser(strings.NewReader(msg)),
		ContentLength: int64(len(msg)),
	}
	_ = resp.Write(conn)
}

func copyWebSocketServerToClient(dst io.Writer, src *bufio.Reader, onMessage func([]byte)) error {
	var acc websocketMessageAccumulator
	for {
		frame, err := readWebSocketFrame(src)
		if err != nil {
			return err
		}
		if _, err := dst.Write(frame.raw); err != nil {
			return err
		}
		acc.observe(frame, onMessage)
	}
}

type websocketFrame struct {
	raw     []byte
	opcode  byte
	fin     bool
	masked  bool
	maskKey [4]byte
	payload []byte
}

func readWebSocketFrame(r *bufio.Reader) (websocketFrame, error) {
	var f websocketFrame
	header := make([]byte, 2)
	if _, err := io.ReadFull(r, header); err != nil {
		return f, err
	}
	f.raw = append(f.raw, header...)
	f.fin = header[0]&0x80 != 0
	f.opcode = header[0] & 0x0f
	f.masked = header[1]&0x80 != 0
	payloadLen := uint64(header[1] & 0x7f)

	switch payloadLen {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(r, ext); err != nil {
			return f, err
		}
		f.raw = append(f.raw, ext...)
		payloadLen = uint64(ext[0])<<8 | uint64(ext[1])
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(r, ext); err != nil {
			return f, err
		}
		f.raw = append(f.raw, ext...)
		payloadLen = 0
		for _, b := range ext {
			payloadLen = payloadLen<<8 | uint64(b)
		}
	}

	if payloadLen > recordingBodyMaxBytes {
		return f, fmt.Errorf("websocket frame too large: %d bytes", payloadLen)
	}
	if f.masked {
		if _, err := io.ReadFull(r, f.maskKey[:]); err != nil {
			return f, err
		}
		f.raw = append(f.raw, f.maskKey[:]...)
	}
	f.payload = make([]byte, int(payloadLen))
	if _, err := io.ReadFull(r, f.payload); err != nil {
		return f, err
	}
	f.raw = append(f.raw, f.payload...)
	return f, nil
}

type websocketMessageAccumulator struct {
	active bool
	opcode byte
	buf    bytes.Buffer
}

func (a *websocketMessageAccumulator) observe(frame websocketFrame, onMessage func([]byte)) {
	if onMessage == nil {
		return
	}
	payload := framePayloadForInspect(frame)
	switch frame.opcode {
	case 0x1, 0x2:
		if frame.fin {
			onMessage(payload)
			return
		}
		a.active = true
		a.opcode = frame.opcode
		a.buf.Reset()
		a.write(payload)
	case 0x0:
		if !a.active {
			return
		}
		a.write(payload)
		if frame.fin {
			msg := make([]byte, a.buf.Len())
			copy(msg, a.buf.Bytes())
			a.active = false
			a.buf.Reset()
			onMessage(msg)
		}
	}
}

func (a *websocketMessageAccumulator) write(payload []byte) {
	if len(payload) == 0 {
		return
	}
	if a.buf.Len()+len(payload) > recordingBodyMaxBytes {
		a.active = false
		a.buf.Reset()
		return
	}
	a.buf.Write(payload)
}

func framePayloadForInspect(frame websocketFrame) []byte {
	if !frame.masked {
		return frame.payload
	}
	payload := make([]byte, len(frame.payload))
	for i, b := range frame.payload {
		payload[i] = b ^ frame.maskKey[i%4]
	}
	return payload
}

// ── HTTP forward proxy ────────────────────────────────────────

func (s *ProxyServer) handleHTTPForward(w http.ResponseWriter, r *http.Request) {
	hostname := r.URL.Hostname()
	vendor, isAI := s.matchAIDomain(hostname)

	requestModel := ""
	sourceApp := ""
	if isAI {
		requestModel = s.processRequestBody(r)
		sourceApp = inferSourceAppFromHeaders(r.Header)
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
		if isStreamingResponse(resp.Header) {
			streamCopy(w, tee)
		} else {
			io.Copy(w, tee)
		}
		go s.processResponseData(vendor, r.URL.Path, requestModel, sourceApp, buf.Bytes())
	} else {
		if isStreamingResponse(resp.Header) {
			streamCopy(w, resp.Body)
		} else {
			io.Copy(w, resp.Body)
		}
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
	sourceApp := inferSourceAppFromHeaders(r.Header)

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
					onClose: func(data []byte) { s.processResponseData(vendor, remaining, requestModel, sourceApp, data) },
				}
				return nil
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				return err
			}
			s.processResponseData(vendor, remaining, requestModel, sourceApp, body)
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

// patchGitHubCopilotClaudeMessages 修正 Copilot 网关 /v1/messages 请求体：
// - 网关会拒绝 enabled、以及 adaptive 下的 budget_tokens 等冗余字段；
// - 但若 body 含 context_management…clear_thinking_20251015，又要求 thinking.type 为 enabled 或 adaptive。
// 因此统一改为仅含 {"type":"adaptive"} 的最小 thinking；若仅有 clear_thinking 而无 thinking 则注入该对象。
func patchGitHubCopilotClaudeMessages(r *http.Request, reqData map[string]interface{}) bool {
	host := strings.ToLower(r.URL.Hostname())
	path := strings.ToLower(r.URL.Path)
	if !strings.Contains(host, "githubcopilot.com") {
		return false
	}
	if !strings.Contains(path, "/v1/messages") {
		return false
	}

	need := false
	if _, ok := reqData["thinking"]; ok {
		need = true
	}
	if !need && copilotHasClearThinkingStrategy(reqData) {
		need = true
	}
	if !need {
		return false
	}

	reqData["thinking"] = map[string]interface{}{
		"type": "adaptive",
	}
	return true
}

func copilotHasClearThinkingStrategy(reqData map[string]interface{}) bool {
	cm, ok := reqData["context_management"].(map[string]interface{})
	if !ok {
		return false
	}
	edits, ok := cm["edits"].([]interface{})
	if !ok {
		return false
	}
	for _, e := range edits {
		edit, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := edit["type"].(string); t == "clear_thinking_20251015" {
			return true
		}
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

	if patchGitHubCopilotClaudeMessages(r, reqData) {
		if modified, err := json.Marshal(reqData); err == nil {
			bodyBytes = modified
		}
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

func (s *ProxyServer) processResponseData(vendor, endpoint, requestModel, sourceApp string, data []byte) {
	if vendor == "github-copilot" {
		s.updateGitHubCopilotDiscounts(data)
	}

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
			CostMultiplier:   s.githubCopilotDiscountMultiplier(model),
			Source:           "client",
			SourceApp:        sourceApp,
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
	if !shouldOpaqueEstimateForVendor(vendor, endpoint, modelHint, data) {
		return
	}
	pt, ct, tt := opaqueTokenSplit(data, endpoint)
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
		SourceApp:        sourceApp,
	})
}

func (s *ProxyServer) statusPage(w http.ResponseWriter, r *http.Request) {
	upstreamLabel := "(direct)"
	if s.upstreamProxy != nil {
		upstreamLabel = s.upstreamProxy.Redacted()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":                 "running",
		"version":                Version,
		"mode":                   "transparent-mitm",
		"pid":                    os.Getpid(),
		"port":                   s.listenPort,
		"wizard_url":             fmt.Sprintf("http://127.0.0.1:%d/wizard", s.listenPort),
		"uptime_seconds":         int(time.Since(s.startedAt).Seconds()),
		"upstream_proxy":         upstreamLabel,
		"user":                   s.cfg.UserName,
		"department":             s.cfg.Department,
		"source_app":             s.reporter.sourceApp,
		"server":                 s.cfg.ServerURL,
		"ai_domains":             len(aiDomains),
		"ai_wildcard_patterns":   len(aiWildcardDomains),
		"extra_monitor_hosts":    len(s.cfg.ExtraMonitorHosts),
		"extra_monitor_suffixes": len(s.cfg.ExtraMonitorSuffixes),
		"stats": map[string]interface{}{
			"total_reported": s.reporter.Stats.TotalReported.Load(),
			"total_tokens":   s.reporter.Stats.TotalTokens.Load(),
		},
	})
}

// recordingBody wraps an io.ReadCloser, recording all bytes read.
// 为防止超长流式响应（如 Claude Opus 的 reasoning）撑爆内存，
// buf 设置上限；超出后只保留尾部，仍能从最后一段提取 usage 信息。
const recordingBodyMaxBytes = 4 * 1024 * 1024 // 4MB

type recordingBody struct {
	io.ReadCloser
	buf     *bytes.Buffer
	onClose func([]byte)
	dropped bool
}

func (r *recordingBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		if r.buf.Len()+n > recordingBodyMaxBytes {
			// 只保留尾段：丢弃 buf 头部，腾出空间。usage 通常在最后一帧。
			over := r.buf.Len() + n - recordingBodyMaxBytes
			if over >= r.buf.Len() {
				r.buf.Reset()
			} else {
				keep := r.buf.Bytes()[over:]
				cp := make([]byte, len(keep))
				copy(cp, keep)
				r.buf.Reset()
				r.buf.Write(cp)
			}
			r.dropped = true
		}
		r.buf.Write(p[:n])
	}
	return n, err
}

func (r *recordingBody) Close() error {
	err := r.ReadCloser.Close()
	if r.onClose != nil {
		data := make([]byte, r.buf.Len())
		copy(data, r.buf.Bytes())
		go safeGo("recordingBody.onClose", func() { r.onClose(data) })
	}
	return err
}

// streamCopy 将 src 拷到 dst，适用于 SSE / chunked 等需要实时下发的响应。
// 每读到一个 chunk 立刻 Flush，否则 Copilot/Claude 的流式输出会被缓冲到连接关闭
// 才统一下发，表现为「回复为空 / 永远转圈」。
func streamCopy(dst http.ResponseWriter, src io.Reader) {
	flusher, _ := dst.(http.Flusher)
	buf := make([]byte, 16*1024)
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

// isStreamingResponse 判断响应是否属于需要即时下发的类型。
func isStreamingResponse(h http.Header) bool {
	ct := h.Get("Content-Type")
	if strings.Contains(ct, "text/event-stream") {
		return true
	}
	// chunked 且不是二进制/json整体响应：也采取实时下发。
	if h.Get("Transfer-Encoding") == "chunked" || h.Get("Content-Length") == "" {
		return true
	}
	return false
}
