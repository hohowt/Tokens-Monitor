//go:build !windows

package main

import (
	"os/exec"
	"runtime"
	"strings"
)

// readCurrentSystemProxy reads the first enabled macOS web/secure web proxy.
// Linux remains env-var only.
func readCurrentSystemProxy() string {
	if runtime.GOOS == "darwin" {
		services, err := macNetworkServices()
		if err != nil {
			return ""
		}
		for _, svc := range services {
			for _, kind := range []string{"-getsecurewebproxy", "-getwebproxy"} {
				out, err := exec.Command("networksetup", kind, svc).CombinedOutput()
				if err != nil {
					continue
				}
				if proxy := parseMacProxy(string(out)); proxy != "" {
					return proxy
				}
			}
		}
	}
	return ""
}

func readCurrentProxyOverride() string {
	return ""
}

func readCurrentAutoDetect() (uint32, bool) {
	return 0, false
}

func readMachinePolicyProxy() (bool, string) {
	return false, ""
}

func fetchPACBody(pacURL string) (string, error) {
	return "", nil
}

func RestoreAutoDetect(value uint32, present bool) {}

func parseMacProxy(output string) string {
	lines := strings.Split(output, "\n")
	enabled := false
	server := ""
	port := ""
	for _, line := range lines {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		_, value, _ := strings.Cut(line, ":")
		value = strings.TrimSpace(value)
		switch {
		case strings.HasPrefix(lower, "enabled:"):
			enabled = strings.EqualFold(value, "yes") || value == "1"
		case strings.HasPrefix(lower, "server:"):
			server = value
		case strings.HasPrefix(lower, "port:"):
			port = value
		}
	}
	if !enabled || server == "" || port == "" || server == "0.0.0.0" {
		return ""
	}
	return "http://" + server + ":" + port
}
