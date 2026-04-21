package main

import (
	"encoding/json"
	"log"
	"net/url"
	"os"
	"strings"
)

// detectUpstreamProxy discovers the user's existing proxy before ai-monitor sets itself up.
// Priority: explicit config > Windows system proxy registry > environment variables > install_state saved proxy.
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

	// 4. Fallback: install_state.json saved the upstream before install overwrote everything.
	// This handles the case where system proxy + env vars now all point to ai-monitor.
	if state := loadInstallState(); state != nil && state.PreviousUpstreamProxy != "" {
		if !isSelfProxy(state.PreviousUpstreamProxy) {
			log.Printf("[upstream] recovered from install_state: %s", state.PreviousUpstreamProxy)
			return state.PreviousUpstreamProxy
		}
	}

	return ""
}

// snapshotProxyEnvVars captures the current proxy-related environment variables
// BEFORE installation overwrites them. Used for restoration on uninstall.
func snapshotProxyEnvVars() map[string]string {
	snapshot := make(map[string]string)
	for _, key := range []string{
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "no_proxy",
		"ALL_PROXY", "all_proxy",
		"NODE_EXTRA_CA_CERTS",
	} {
		if v := os.Getenv(key); v != "" && !isSelfProxy(v) {
			snapshot[key] = v
		}
	}
	return snapshot
}

// patchConfigUpstreamProxy reads config.json, sets upstream_proxy, and writes it back.
// Preserves all other fields and formatting.
func patchConfigUpstreamProxy(configPath, upstream string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	raw["upstream_proxy"] = upstream
	out, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, out, 0600)
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
	return true
}
