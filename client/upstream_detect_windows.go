//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// readCurrentSystemProxy reads the WinINet system proxy from the Windows registry.
// Returns the proxy address (e.g. "http://proxy.corp:8080") if enabled, or "" otherwise.
func readCurrentSystemProxy() string {
	// Check if proxy is enabled (ProxyEnable == 0x1)
	enableOut, err := exec.Command("reg", "query",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
		"/v", "ProxyEnable",
	).Output()
	if err != nil {
		return ""
	}
	enableStr := strings.TrimSpace(string(enableOut))
	// Registry output contains "0x1" for enabled
	if !strings.Contains(enableStr, "0x1") {
		return ""
	}

	// Read ProxyServer value
	serverOut, err := exec.Command("reg", "query",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
		"/v", "ProxyServer",
	).Output()
	if err != nil {
		return ""
	}

	// Parse the REG_SZ value from output like:
	//     ProxyServer    REG_SZ    proxy.corp:8080
	lines := strings.Split(string(serverOut), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ProxyServer") {
			parts := strings.SplitN(line, "REG_SZ", 2)
			if len(parts) == 2 {
				addr := strings.TrimSpace(parts[1])
				if addr != "" {
					// WinINet ProxyServer may or may not have a scheme; normalize.
					if !strings.Contains(addr, "://") {
						addr = fmt.Sprintf("http://%s", addr)
					}
					return addr
				}
			}
		}
	}

	return ""
}
