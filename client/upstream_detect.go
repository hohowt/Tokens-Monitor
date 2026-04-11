package main

import (
	"log"
	"net/url"
	"os"
	"strings"
)

// detectUpstreamProxy discovers the user's existing proxy before ai-monitor sets itself up.
// Priority: explicit config > Windows system proxy registry > environment variables.
// Returns "" if no upstream proxy is found or all candidates are self-referential.
func detectUpstreamProxy(cfg *Config) string {
	// 1. Explicit config takes highest priority (already validated by LoadConfig)
	if cfg != nil && strings.TrimSpace(cfg.UpstreamProxy) != "" {
		return cfg.UpstreamProxy
	}

	// 2. OS-specific system proxy read (Windows registry; no-op on other platforms)
	if sysProxy := readCurrentSystemProxy(); sysProxy != "" {
		if !isSelfProxy(sysProxy) {
			log.Printf("[upstream] auto-detected system proxy: %s", sysProxy)
			return sysProxy
		}
		log.Printf("[upstream] ignoring system proxy %s (points to self)", sysProxy)
	}

	// 3. Standard proxy environment variables
	for _, key := range []string{
		"HTTPS_PROXY", "https_proxy",
		"HTTP_PROXY", "http_proxy",
		"ALL_PROXY", "all_proxy",
	} {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			continue
		}
		if isSelfProxy(v) {
			log.Printf("[upstream] ignoring env %s=%s (points to self)", key, v)
			continue
		}
		log.Printf("[upstream] auto-detected env %s: %s", key, v)
		return v
	}

	return ""
}

// isSelfProxy returns true if the proxy URL points to ai-monitor's own listening range.
func isSelfProxy(proxy string) bool {
	raw := strings.TrimSpace(proxy)
	if raw == "" {
		return false
	}
	// Ensure the value is parseable as a URL; bare host:port needs a scheme.
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	portStr := u.Port()
	if portStr == "" {
		return false
	}
	port := 0
	for _, c := range portStr {
		if c < '0' || c > '9' {
			return false
		}
		port = port*10 + int(c-'0')
	}
	// ai-monitor uses port range 18090 – 18090+63(=18153)
	return port >= 18090 && port <= 18090+mitmPortMaxFallback
}
