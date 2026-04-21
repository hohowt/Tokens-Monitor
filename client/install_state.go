package main

import (
	"encoding/json"
	"fmt"
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
	// PreviousAutoConfigURLBody stores the full text of the user's original PAC
	// so we can chain it inside our generated PAC (whitelist mode).
	PreviousAutoConfigURLBody string `json:"previous_auto_config_url_body,omitempty"`
	// PreviousProxyOverride stores the original ProxyOverride registry value
	// (semicolon-separated bypass list) so uninstall/heal can restore it exactly.
	PreviousProxyOverride string `json:"previous_proxy_override,omitempty"`
	// PreviousAutoDetect stores the original HKCU AutoDetect (WPAD) flag.
	PreviousAutoDetect uint32 `json:"previous_auto_detect,omitempty"`
	// PreviousAutoDetectPresent indicates whether PreviousAutoDetect was
	// actually captured from the registry (true) vs defaulted because
	// the key was absent or unreadable (false).
	PreviousAutoDetectPresent bool `json:"previous_auto_detect_present,omitempty"`
	// PortAtInstall records the MITM port used at install time for heal fallback.
	PortAtInstall int `json:"port_at_install,omitempty"`
	// Version tracks the install_state schema version for upgrade migration.
	Version int `json:"version,omitempty"`
}

func installStatePath() string {
	return filepath.Join(appDataDir(), "install_state.json")
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
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return fmt.Errorf("create install_state dir: %w", err)
	}
	return os.WriteFile(p, data, 0600)
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
