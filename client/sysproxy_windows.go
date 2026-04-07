//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
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
