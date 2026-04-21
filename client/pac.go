package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// pacFilePath returns the standard PAC file location under the ai-monitor data directory.
func pacFilePath() string {
	return filepath.Join(appDataDir(), "proxy.pac")
}

// pacFileURL converts the PAC file path to a file:/// URL suitable for the
// Windows AutoConfigURL registry value (forward slashes, percent-encoded).
// 对路径中的空格、中文、% 等特殊字符做百分号编码，避免 WinINet 因
// 未编码的 AutoConfigURL 拒绝加载 PAC。
func pacFileURL() string {
	raw := filepath.ToSlash(pacFilePath())
	// 逐段编码，保留 "/" 和 ":" (盘符)
	parts := strings.Split(raw, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	encoded := strings.Join(parts, "/")
	// url.PathEscape 把盘符 ':' 编码为 %3A（如 C: → C%3A），需还原第一个以保留盘符
	encoded = strings.Replace(encoded, "%3A", ":", 1)
	return "file:///" + encoded
}

// writePACFile generates a PAC file for the given listen port and writes it to disk.
// Returns the file:/// URL for use in the AutoConfigURL registry key.
//
// v2.3+: Uses whitelist mode — only AI domains (from monitorHostsForPAC) are routed
// through the local MITM. All other traffic either goes through the user's original
// PAC (if chainedPACBody is non-empty) or DIRECT.
//
// chainedPACBody: the JavaScript body of the user's original PAC file. If non-empty,
// it will be embedded and used as fallback for non-AI traffic. Pass "" to skip chaining.
func writePACFile(listenPort int, cfg *Config, chainedPACBody string) (string, error) {
	monitorHosts := monitorHostsForPAC(cfg)

	var upstream string
	if cfg != nil {
		upstream = cfg.UpstreamProxy
	}

	content := generatePACContent(listenPort, monitorHosts, upstream, chainedPACBody)
	path := pacFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", fmt.Errorf("create PAC directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("write PAC file: %w", err)
	}
	return pacFileURL(), nil
}

// removePACFile deletes the PAC file if it exists.
func removePACFile() {
	os.Remove(pacFilePath())
}

// generatePACContent produces the JavaScript body of a Proxy Auto-Config file.
//
// v2.3+ whitelist mode:
//   - Only monitor_hosts (AI domains) are routed through PROXY 127.0.0.1:<port>.
//   - All other traffic is handled by the user's original PAC (if chained) or DIRECT.
//   - If the MITM is unreachable, WinINet automatically falls through to DIRECT.
//
// This ensures that non-AI traffic (intranet, OA, VPN, etc.) is NEVER affected.
func generatePACContent(listenPort int, monitorHosts []monitorHostEntry, upstreamProxy string, chainedPACBody string) string {
	var b strings.Builder

	// ── If we have a chained PAC, embed it as __OriginalFindProxyForURL ──
	if chainedPACBody != "" {
		renamed := renamePACFunction(chainedPACBody)
		b.WriteString("// === Chained: user's original PAC (renamed) ===\n")
		b.WriteString(renamed)
		b.WriteString("\n\n")
	}

	b.WriteString("function FindProxyForURL(url, host) {\n")
	b.WriteString("    // Plain hostnames (no dots) always go direct\n")
	b.WriteString("    if (isPlainHostName(host)) return \"DIRECT\";\n")
	b.WriteString("\n")

	// ── Emit whitelist conditions: only AI domains go through MITM ──
	// 使用 127.0.0.1 而非 localhost，避免 IPv6 栈上 localhost 先解析到 ::1
	// 而本地 MITM 只监听 IPv4 回环导致客户端偶发失败。
	mitmProxy := fmt.Sprintf("PROXY 127.0.0.1:%d", listenPort)
	// MITM 不可达时的回退：先上游代理、再 DIRECT
	mitmFallback := mitmProxy
	if up := normalizeUpstreamForPAC(upstreamProxy); up != "" {
		mitmFallback += "; " + up
	}
	mitmFallback += "; DIRECT"

	b.WriteString("    // === AI domain whitelist: only these go through MITM ===\n")

	// Deduplicate exact hosts for cleaner output
	exactHosts := make(map[string]bool)
	for _, e := range monitorHosts {
		switch e.Kind {
		case mhExact:
			if !exactHosts[e.Pattern] {
				exactHosts[e.Pattern] = true
				fmt.Fprintf(&b, "    if (host === %q) return %q;\n", e.Pattern, mitmFallback)
			}
		case mhSuffix:
			// e.g. ".openai.azure.com" → dnsDomainIs(host, ".openai.azure.com")
			fmt.Fprintf(&b, "    if (dnsDomainIs(host, %q)) return %q;\n", e.Pattern, mitmFallback)
		case mhPrefixSuffix:
			// e.g. prefix="bedrock-runtime." suffix=".amazonaws.com"
			fmt.Fprintf(&b, "    if (shExpMatch(host, %q)) return %q;\n",
				e.Prefix+"*"+e.Pattern, mitmFallback)
		}
	}

	b.WriteString("\n")
	b.WriteString("    // === Everything else: use original PAC or DIRECT ===\n")

	if chainedPACBody != "" {
		// Delegate to the user's original PAC for all non-AI traffic
		b.WriteString("    if (typeof __OriginalFindProxyForURL === \"function\") {\n")
		b.WriteString("        return __OriginalFindProxyForURL(url, host);\n")
		b.WriteString("    }\n")
	}

	// Final fallback
	if up := normalizeUpstreamForPAC(upstreamProxy); up != "" {
		fmt.Fprintf(&b, "    return %q;\n", up+"; DIRECT")
	} else {
		b.WriteString("    return \"DIRECT\";\n")
	}

	b.WriteString("}\n")

	return b.String()
}

// renamePACFunction takes the body of an existing PAC file and renames its
// FindProxyForURL function to __OriginalFindProxyForURL so it can be called
// from our wrapper without collision.
// Handles the standard `function FindProxyForURL(...)` declaration.
// If the pattern is not found (e.g. `var FindProxyForURL = function(...)`),
// logs a warning — the generated PAC has a typeof guard so it won't crash,
// but the user's original PAC won't be called for non-AI traffic.
var pacFuncRe = regexp.MustCompile(`(?m)\bfunction\s+FindProxyForURL\b`)

func renamePACFunction(pacBody string) string {
	if !pacFuncRe.MatchString(pacBody) {
		log.Println("[pac] ⚠ 无法在现有 PAC 中找到 'function FindProxyForURL' 声明，链式包裹可能无效。非 AI 流量将走 DIRECT/upstream。")
	}
	return pacFuncRe.ReplaceAllString(pacBody, "function __OriginalFindProxyForURL")
}

// normalizeUpstreamForPAC converts an upstream proxy URL (e.g. "http://proxy:8080"
// or "socks5://proxy:1080") into a PAC proxy directive ("PROXY proxy:8080" or
// "SOCKS5 proxy:1080"). Returns "" if the upstream is empty or unparseable.
// Credentials (user:pass@) are stripped — PAC does not support inline auth.
func normalizeUpstreamForPAC(upstream string) string {
	upstream = strings.TrimSpace(upstream)
	if upstream == "" {
		return ""
	}
	u, err := url.Parse(upstream)
	if err != nil {
		return ""
	}
	// Strip credentials — PAC syntax does not support user:pass@host
	host := u.Host
	if host == "" {
		// Might be a bare host:port without scheme.
		host = upstream
	}
	// Remove userinfo from host if present in raw form
	if u.User != nil {
		host = u.Hostname()
		if u.Port() != "" {
			host = host + ":" + u.Port()
		}
	}
	scheme := strings.ToLower(u.Scheme)
	switch {
	case scheme == "socks5" || scheme == "socks":
		return "SOCKS5 " + host
	default:
		return "PROXY " + host
	}
}
