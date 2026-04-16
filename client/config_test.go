package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEffectiveInstallSystemProxy(t *testing.T) {
	truePtr := func(b bool) *bool { return &b }
	cases := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"omit field defaults non-invasive", &Config{}, false},
		{"explicit true", &Config{InstallSystemProxy: truePtr(true)}, true},
		{"explicit false", &Config{InstallSystemProxy: truePtr(false)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var c *Config
			if tc.cfg != nil {
				c = tc.cfg
			}
			if got := c.EffectiveInstallSystemProxy(); got != tc.want {
				t.Fatalf("EffectiveInstallSystemProxy() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEffectiveInstallIDEProxy(t *testing.T) {
	truePtr := func(b bool) *bool { return &b }
	cases := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"omit field", &Config{}, false},
		{"explicit false", &Config{InstallIDEProxy: truePtr(false)}, false},
		{"explicit true", &Config{InstallIDEProxy: truePtr(true)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var c *Config
			if tc.cfg != nil {
				c = tc.cfg
			}
			if got := c.EffectiveInstallIDEProxy(); got != tc.want {
				t.Fatalf("EffectiveInstallIDEProxy() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestLoadConfig_JSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	raw := `{
  "server_url": "https://otw.tech:59889",
  "port": 18090,
  "install_system_proxy": true
}`
	if err := os.WriteFile(path, []byte(raw), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://otw.tech:59889" {
		t.Fatalf("ServerURL = %q", cfg.ServerURL)
	}
	if cfg.Port != 18090 {
		t.Fatalf("Port = %d", cfg.Port)
	}
	if cfg.InstallSystemProxy == nil || !*cfg.InstallSystemProxy {
		t.Fatal("expected install_system_proxy true")
	}
	if !cfg.EffectiveInstallSystemProxy() {
		t.Fatal("EffectiveInstallSystemProxy should be true")
	}
}

func TestEffectiveReportOpaqueTraffic(t *testing.T) {
	b := func(v bool) *bool { return &v }
	if !(&Config{}).EffectiveReportOpaqueTraffic() {
		t.Fatal("default should be true")
	}
	if (&Config{ReportOpaqueTraffic: b(false)}).EffectiveReportOpaqueTraffic() {
		t.Fatal("explicit false")
	}
	if !(&Config{ReportOpaqueTraffic: b(true)}).EffectiveReportOpaqueTraffic() {
		t.Fatal("explicit true")
	}
}

func TestLoadConfig_MissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nope.json")
	_, err := LoadConfig(path)
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestLoadConfig_OmitInstallSystemProxy_DefaultsFalse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	raw := `{"server_url":"https://otw.tech:59889","port":18090}`
	if err := os.WriteFile(path, []byte(raw), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InstallSystemProxy != nil {
		t.Fatalf("expected omitted field as nil, got %v", cfg.InstallSystemProxy)
	}
	if cfg.EffectiveInstallSystemProxy() {
		t.Fatal("omitted install_system_proxy should default to false (非侵入式安装)")
	}
}

func TestLoadConfig_ValidatesOptionalUpstreamProxy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	raw := `{"server_url":"https://otw.tech:59889","port":18090,"upstream_proxy":"socks5://127.0.0.1:7890"}`
	if err := os.WriteFile(path, []byte(raw), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UpstreamProxy != "socks5://127.0.0.1:7890" {
		t.Fatalf("UpstreamProxy = %q", cfg.UpstreamProxy)
	}
}
