package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// InstallState records what ai-monitor changed during --install so that
// --uninstall or clean shutdown can restore the previous configuration.
type InstallState struct {
	SystemProxySet       bool   `json:"system_proxy_set"`
	PreviousProxyAddr    string `json:"previous_proxy_addr"`
	PreviousProxyEnabled bool   `json:"previous_proxy_enabled"`
	IDESettingsPatched   bool   `json:"ide_settings_patched"`
	Timestamp            string `json:"timestamp"`
	// PreviousUpstreamProxy is the upstream proxy detected BEFORE install overwrote
	// system proxy / env vars. Used at runtime as a fallback in detectUpstreamProxy
	// so that the proxy chain is not broken after installation.
	PreviousUpstreamProxy string            `json:"previous_upstream_proxy,omitempty"`
	PreviousEnvVars       map[string]string `json:"previous_env_vars,omitempty"`
	// PAC-based proxy (v2.2+). When PACFileSet is true, system proxy is
	// configured via AutoConfigURL pointing to a local PAC file with DIRECT
	// fallback, instead of a hardcoded ProxyServer.
	PACFileSet            bool   `json:"pac_file_set,omitempty"`
	PACFilePath           string `json:"pac_file_path,omitempty"`
	PreviousAutoConfigURL string `json:"previous_auto_config_url,omitempty"`
}

func installStatePath() string {
	return filepath.Join(os.Getenv("APPDATA"), "ai-monitor", "install_state.json")
}

func saveInstallState(state *InstallState) error {
	if state.Timestamp == "" {
		state.Timestamp = time.Now().Format(time.RFC3339)
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	p := installStatePath()
	os.MkdirAll(filepath.Dir(p), 0755)
	return os.WriteFile(p, data, 0644)
}

func loadInstallState() *InstallState {
	data, err := os.ReadFile(installStatePath())
	if err != nil {
		return nil
	}
	var state InstallState
	if json.Unmarshal(data, &state) != nil {
		return nil
	}
	return &state
}

func clearInstallState() {
	os.Remove(installStatePath())
}
