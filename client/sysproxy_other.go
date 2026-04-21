//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func EnableSystemProxy(proxyAddr, bypass string) error {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			return err
		}
		if len(services) == 0 {
			return fmt.Errorf("未找到可配置的 macOS 网络服务")
		}
		host, port, ok := strings.Cut(proxyAddr, ":")
		if !ok || host == "" || port == "" {
			return fmt.Errorf("代理地址格式无效: %s", proxyAddr)
		}
		for _, svc := range services {
			if err := exec.Command("networksetup", "-setwebproxy", svc, host, port).Run(); err != nil {
				return fmt.Errorf("networksetup -setwebproxy %s: %w", svc, err)
			}
			if err := exec.Command("networksetup", "-setsecurewebproxy", svc, host, port).Run(); err != nil {
				return fmt.Errorf("networksetup -setsecurewebproxy %s: %w", svc, err)
			}
			if bypass != "" {
				exceptions := macProxyExceptions(bypass)
				if len(exceptions) > 0 {
					args := append([]string{"-setproxybypassdomains", svc}, exceptions...)
					if err := exec.Command("networksetup", args...).Run(); err != nil {
						return fmt.Errorf("networksetup -setproxybypassdomains %s: %w", svc, err)
					}
				}
			}
		}
		log.Printf("[proxy] macOS system proxy set: %s (%d services)", proxyAddr, len(services))
		return nil
	}
	return fmt.Errorf("automatic system proxy configuration is not implemented on %s yet; use --launch or configure your application proxy manually (proxy=%s, bypass=%s)", runtime.GOOS, proxyAddr, bypass)
}

func DisableSystemProxy() {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			log.Printf("[proxy] macOS service lookup failed: %v", err)
			return
		}
		for _, svc := range services {
			_ = exec.Command("networksetup", "-setwebproxystate", svc, "off").Run()
			_ = exec.Command("networksetup", "-setsecurewebproxystate", svc, "off").Run()
			_ = exec.Command("networksetup", "-setautoproxystate", svc, "off").Run()
		}
		log.Printf("[proxy] macOS system proxy disabled (%d services)", len(services))
		return
	}
	log.Printf("[proxy] system proxy cleanup skipped on %s", runtime.GOOS)
}

// SetEnvProxy writes proxy environment variables to ~/.zshrc (macOS) or logs a hint on Linux.
// Each managed block is wrapped with sentinel comments so re-runs are idempotent.
func SetEnvProxy(vars map[string]string) error {
	if runtime.GOOS != "darwin" {
		_ = vars
		return fmt.Errorf("persistent environment proxy configuration is not implemented on %s yet; use --launch for per-process injection", runtime.GOOS)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("获取用户目录失败: %w", err)
	}
	zshrc := filepath.Join(home, ".zshrc")

	// Read existing content
	existing := ""
	if data, err := os.ReadFile(zshrc); err == nil {
		existing = string(data)
	}

	const beginMark = "# >>> ai-monitor proxy begin <<<"
	const endMark = "# >>> ai-monitor proxy end <<<"

	// Build new block
	var lines []string
	lines = append(lines, beginMark)
	// Preserve a defined order for readability
	order := []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
		"SSL_CERT_FILE", "CODEX_CA_CERTIFICATE",
		"OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL"}
	written := map[string]bool{}
	for _, k := range order {
		if v, ok := vars[k]; ok {
			lines = append(lines, fmt.Sprintf("export %s=%q", k, v))
			written[k] = true
		}
	}
	// Any remaining keys not in the ordered list
	for k, v := range vars {
		if !written[k] {
			lines = append(lines, fmt.Sprintf("export %s=%q", k, v))
		}
	}
	lines = append(lines, endMark)
	newBlock := strings.Join(lines, "\n") + "\n"

	// Remove old block if present
	if start := strings.Index(existing, beginMark); start != -1 {
		end := strings.Index(existing, endMark)
		if end != -1 {
			existing = existing[:start] + existing[end+len(endMark)+1:]
		}
	}

	// Append new block
	content := strings.TrimRight(existing, "\n") + "\n\n" + newBlock

	if err := os.WriteFile(zshrc, []byte(content), 0644); err != nil {
		return fmt.Errorf("写入 ~/.zshrc 失败: %w", err)
	}
	log.Printf("[proxy] 已写入 ~/.zshrc，重新打开终端后生效")
	return nil
}

// ClearEnvProxy removes the ai-monitor proxy block from ~/.zshrc on macOS.
func ClearEnvProxy(keys []string) {
	if runtime.GOOS != "darwin" {
		_ = keys
		log.Printf("[proxy] persistent environment cleanup skipped on %s", runtime.GOOS)
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	zshrc := filepath.Join(home, ".zshrc")
	data, err := os.ReadFile(zshrc)
	if err != nil {
		return
	}
	content := string(data)
	const beginMark = "# >>> ai-monitor proxy begin <<<"
	const endMark = "# >>> ai-monitor proxy end <<<"
	start := strings.Index(content, beginMark)
	end := strings.Index(content, endMark)
	if start == -1 || end == -1 {
		return
	}
	content = content[:start] + content[end+len(endMark)+1:]
	os.WriteFile(zshrc, []byte(strings.TrimRight(content, "\n")+"\n"), 0644)
	log.Printf("[proxy] 已从 ~/.zshrc 移除代理配置")
}

func ReadCurrentAutoConfigURL() string {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			return ""
		}
		for _, svc := range services {
			out, err := exec.Command("networksetup", "-getautoproxyurl", svc).CombinedOutput()
			if err != nil {
				continue
			}
			if url := parseMacAutoProxyURL(string(out)); url != "" {
				return url
			}
		}
	}
	return ""
}

func EnableSystemProxyPAC(pacURL string) error {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			return err
		}
		if len(services) == 0 {
			return fmt.Errorf("未找到可配置的 macOS 网络服务")
		}
		for _, svc := range services {
			if err := exec.Command("networksetup", "-setautoproxyurl", svc, pacURL).Run(); err != nil {
				return fmt.Errorf("networksetup -setautoproxyurl %s: %w", svc, err)
			}
			_ = exec.Command("networksetup", "-setwebproxystate", svc, "off").Run()
			_ = exec.Command("networksetup", "-setsecurewebproxystate", svc, "off").Run()
		}
		log.Printf("[proxy] macOS PAC proxy set: %s (%d services)", pacURL, len(services))
		return nil
	}
	return fmt.Errorf("PAC proxy configuration is not implemented on %s", runtime.GOOS)
}

func DisableSystemProxyPAC() {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			log.Printf("[proxy] macOS service lookup failed: %v", err)
			return
		}
		for _, svc := range services {
			_ = exec.Command("networksetup", "-setautoproxystate", svc, "off").Run()
		}
		log.Printf("[proxy] macOS PAC proxy cleared (%d services)", len(services))
		return
	}
	log.Printf("[proxy] PAC cleanup skipped on %s", runtime.GOOS)
}

func macNetworkServices() ([]string, error) {
	out, err := exec.Command("networksetup", "-listallnetworkservices").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("networksetup -listallnetworkservices: %s: %w", strings.TrimSpace(string(out)), err)
	}
	var services []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "An asterisk") || strings.HasPrefix(line, "*") {
			continue
		}
		services = append(services, line)
	}
	return services, nil
}

func macProxyExceptions(bypass string) []string {
	parts := strings.FieldsFunc(bypass, func(r rune) bool { return r == ';' || r == ',' })
	out := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "<local>" {
			continue
		}
		p = strings.TrimPrefix(p, "*.")
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func parseMacAutoProxyURL(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToLower(line), "url:") {
			_, url, _ := strings.Cut(line, ":")
			url = strings.TrimSpace(url)
			if url != "" && strings.ToLower(url) != "(null)" {
				return url
			}
		}
	}
	return ""
}
