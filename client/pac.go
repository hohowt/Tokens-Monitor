package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// pacFilePath returns the standard PAC file location under %APPDATA%/ai-monitor/.
func pacFilePath() string {
	return filepath.Join(os.Getenv("APPDATA"), "ai-monitor", "proxy.pac")
}

// pacFileURL converts the PAC file path to a file:/// URL suitable for the
// Windows AutoConfigURL registry value (forward slashes required).
func pacFileURL() string {
	return "file:///" + filepath.ToSlash(pacFilePath())
}

// writePACFile generates a PAC file for the given listen port and writes it to disk.
// Returns the file:/// URL for use in the AutoConfigURL registry key.
func writePACFile(listenPort int, cfg *Config) (string, error) {
	domains := mergeBypassDomains(cfg)

	var upstream string
	if cfg != nil {
		upstream = cfg.UpstreamProxy
	}

	content := generatePACContent(listenPort, domains, upstream)
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
// Bypass domains are translated from the WinINet wildcard syntax used in bypass.go
// into PAC-compatible conditions. RFC 1918 IP prefixes are coalesced into isInNet calls.
//
// The fallback chain is:
//
//	PROXY localhost:<port>; [PROXY <upstream>; ] DIRECT
//
// When the MITM is unreachable, WinINet automatically skips to the next entry,
// ultimately falling through to DIRECT — providing zero-latency crash recovery.
func generatePACContent(listenPort int, bypassDomains []string, upstreamProxy string) string {
	var b strings.Builder

	b.WriteString("function FindProxyForURL(url, host) {\n")
	b.WriteString("    if (isPlainHostName(host)) return \"DIRECT\";\n")

	// ── Emit bypass conditions ──

	// Track which RFC 1918 CIDR blocks we've already emitted so the 16 entries
	// for 172.16.* – 172.31.* coalesce into one isInNet call.
	emittedCIDR := map[string]bool{}

	for _, d := range bypassDomains {
		d = strings.TrimSpace(d)
		if d == "" || d == "<local>" {
			continue
		}

		// IP-prefix wildcards → isInNet
		if cidr, ok := ipPrefixToCIDR(d); ok {
			key := cidr.network + "/" + cidr.mask
			if !emittedCIDR[key] {
				emittedCIDR[key] = true
				fmt.Fprintf(&b, "    if (isInNet(host, %q, %q)) return \"DIRECT\";\n", cidr.network, cidr.mask)
			}
			continue
		}

		// Wildcard domain *.suffix → shExpMatch
		if strings.HasPrefix(d, "*.") {
			fmt.Fprintf(&b, "    if (shExpMatch(host, %q)) return \"DIRECT\";\n", d)
			continue
		}

		// Exact hostname
		fmt.Fprintf(&b, "    if (host === %q) return \"DIRECT\";\n", d)
	}

	// ── Fallback chain ──
	fallback := fmt.Sprintf("PROXY localhost:%d", listenPort)
	if up := normalizeUpstreamForPAC(upstreamProxy); up != "" {
		fallback += "; " + up
	}
	fallback += "; DIRECT"

	fmt.Fprintf(&b, "    return %q;\n", fallback)
	b.WriteString("}\n")

	return b.String()
}

// cidrEntry holds a network address and subnet mask for isInNet().
type cidrEntry struct {
	network string
	mask    string
}

// ipPrefixToCIDR translates WinINet-style IP wildcards (e.g. "10.*", "172.16.*")
// into the corresponding CIDR parameters for the PAC isInNet() function.
func ipPrefixToCIDR(pattern string) (cidrEntry, bool) {
	switch {
	case pattern == "10.*":
		return cidrEntry{"10.0.0.0", "255.0.0.0"}, true
	case pattern == "192.168.*":
		return cidrEntry{"192.168.0.0", "255.255.0.0"}, true
	case pattern == "169.254.*":
		return cidrEntry{"169.254.0.0", "255.255.0.0"}, true
	case strings.HasPrefix(pattern, "172.") && strings.HasSuffix(pattern, ".*"):
		// 172.16.* through 172.31.* all map to 172.16.0.0/12.
		mid := strings.TrimPrefix(pattern, "172.")
		mid = strings.TrimSuffix(mid, ".*")
		if mid >= "16" && mid <= "31" {
			return cidrEntry{"172.16.0.0", "255.240.0.0"}, true
		}
	}
	return cidrEntry{}, false
}

// normalizeUpstreamForPAC converts an upstream proxy URL (e.g. "http://proxy:8080"
// or "socks5://proxy:1080") into a PAC proxy directive ("PROXY proxy:8080" or
// "SOCKS5 proxy:1080"). Returns "" if the upstream is empty or unparseable.
func normalizeUpstreamForPAC(upstream string) string {
	upstream = strings.TrimSpace(upstream)
	if upstream == "" {
		return ""
	}
	u, err := url.Parse(upstream)
	if err != nil {
		return ""
	}
	host := u.Host
	if host == "" {
		// Might be a bare host:port without scheme.
		host = upstream
	}
	scheme := strings.ToLower(u.Scheme)
	switch {
	case scheme == "socks5" || scheme == "socks":
		return "SOCKS5 " + host
	default:
		return "PROXY " + host
	}
}
