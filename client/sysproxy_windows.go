//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
)

const inetRegPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
const envRegPath = `HKCU\Environment`

// EnableSystemProxy sets the WinINet system proxy for the current user.
func EnableSystemProxy(proxyAddr, bypass string) error {
	cmds := []struct {
		args []string
		desc string
	}{
		{[]string{"reg", "add", inetRegPath, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"}, "enable proxy"},
		{[]string{"reg", "add", inetRegPath, "/v", "ProxyServer", "/t", "REG_SZ", "/d", proxyAddr, "/f"}, "set proxy server"},
		{[]string{"reg", "add", inetRegPath, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", bypass, "/f"}, "set bypass list"},
	}
	for _, c := range cmds {
		if err := exec.Command(c.args[0], c.args[1:]...).Run(); err != nil {
			return fmt.Errorf("%s: %w", c.desc, err)
		}
	}
	log.Printf("[proxy] system proxy set: %s", proxyAddr)
	return nil
}

// DisableSystemProxy removes the WinINet system proxy setting.
func DisableSystemProxy() {
	exec.Command("reg", "add", inetRegPath, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f").Run()
	log.Println("[proxy] system proxy disabled")
}

// SetEnvProxy sets HTTP_PROXY, HTTPS_PROXY, and AI SDK base URL env vars persistently.
func SetEnvProxy(vars map[string]string) error {
	for k, v := range vars {
		if err := exec.Command("setx", k, v).Run(); err != nil {
			return fmt.Errorf("setx %s: %w", k, err)
		}
	}
	log.Println("[proxy] environment variables set")
	return nil
}

// ClearEnvProxy removes all proxy-related environment variables.
func ClearEnvProxy(keys []string) {
	for _, k := range keys {
		exec.Command("reg", "delete", envRegPath, "/v", k, "/f").Run()
	}
	log.Println("[proxy] environment variables cleared")
}

// ReadCurrentAutoConfigURL reads the current AutoConfigURL from the WinINet registry.
// Returns "" if not set or on error.
func ReadCurrentAutoConfigURL() string {
	out, err := exec.Command("reg", "query", inetRegPath, "/v", "AutoConfigURL").CombinedOutput()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "AutoConfigURL") {
			parts := strings.SplitN(line, "REG_SZ", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

// EnableSystemProxyPAC sets the AutoConfigURL registry value so WinINet resolves
// proxies via a PAC file. Manual proxy (ProxyEnable / ProxyServer) is disabled.
func EnableSystemProxyPAC(pacURL string) error {
	cmds := []struct {
		args []string
		desc string
	}{
		{[]string{"reg", "add", inetRegPath, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", pacURL, "/f"}, "set AutoConfigURL"},
		{[]string{"reg", "add", inetRegPath, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"}, "disable manual proxy"},
	}
	for _, c := range cmds {
		if err := exec.Command(c.args[0], c.args[1:]...).Run(); err != nil {
			return fmt.Errorf("%s: %w", c.desc, err)
		}
	}
	// Clean up stale manual proxy keys (ignore errors if they don't exist)
	exec.Command("reg", "delete", inetRegPath, "/v", "ProxyServer", "/f").Run()
	exec.Command("reg", "delete", inetRegPath, "/v", "ProxyOverride", "/f").Run()
	log.Printf("[proxy] PAC proxy set: %s", pacURL)
	return nil
}

// DisableSystemProxyPAC removes the AutoConfigURL registry value.
func DisableSystemProxyPAC() {
	exec.Command("reg", "delete", inetRegPath, "/v", "AutoConfigURL", "/f").Run()
	log.Println("[proxy] PAC proxy cleared")
}
