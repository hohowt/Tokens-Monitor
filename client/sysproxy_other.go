//go:build !windows

package main

import (
	"fmt"
	"log"
	"runtime"
)

func EnableSystemProxy(proxyAddr, bypass string) error {
	return fmt.Errorf("automatic system proxy configuration is not implemented on %s yet; use --launch or configure your application proxy manually (proxy=%s, bypass=%s)", runtime.GOOS, proxyAddr, bypass)
}

func DisableSystemProxy() {
	log.Printf("[proxy] system proxy cleanup skipped on %s", runtime.GOOS)
}

func SetEnvProxy(vars map[string]string) error {
	_ = vars
	return fmt.Errorf("persistent environment proxy configuration is not implemented on %s yet; use --launch for per-process injection", runtime.GOOS)
}

func ClearEnvProxy(keys []string) {
	_ = keys
	log.Printf("[proxy] persistent environment cleanup skipped on %s", runtime.GOOS)
}

func ReadCurrentAutoConfigURL() string {
	return ""
}

func EnableSystemProxyPAC(pacURL string) error {
	return fmt.Errorf("PAC proxy configuration is not implemented on %s", runtime.GOOS)
}

func DisableSystemProxyPAC() {
	log.Printf("[proxy] PAC cleanup skipped on %s", runtime.GOOS)
}
