package main

import "testing"

func TestMatchAIDomainBuiltinDevTools(t *testing.T) {
	s := NewProxyServer(&Config{}, nil, nil)
	cases := []struct {
		host, wantVendor string
	}{
		{"api.openrouter.ai", "openrouter"},
		{"api.tabnine.com", "tabnine"},
		{"server.codeium.com", "codeium"},
		{"api.jetbrains.ai", "jetbrains-ai"},
		{"cody-gateway.sourcegraph.com", "sourcegraph-cody"},
		{"codewhisperer.us-east-1.amazonaws.com", "aws-codewhisperer"},
		{"q.us-west-2.amazonaws.com", "aws-q"},
		{"my-model.inference.azure.com", "azure-inference"},
		// Cursor / Copilot / Claude Code 相关
		{"metrics.cursor.sh", "cursor"},
		{"new.api.cursor.sh", "cursor"},
		{"api.enterprise.githubcopilot.com", "github-copilot"},
		{"foo.githubcopilot.com", "github-copilot"},
	}
	for _, tc := range cases {
		v, ok := s.matchAIDomain(tc.host)
		if !ok || v != tc.wantVendor {
			t.Fatalf("%s: got %q ok=%v want %q", tc.host, v, ok, tc.wantVendor)
		}
	}
}

func TestMatchAIDomainExtraConfig(t *testing.T) {
	cfg := &Config{
		ExtraMonitorHosts: map[string]string{
			"custom.api.example.com": "my-vendor",
		},
		ExtraMonitorSuffixes: []MonitoredSuffix{
			{Suffix: ".corp.llm", Vendor: "corp-llm"},
		},
	}
	s := NewProxyServer(cfg, nil, nil)

	v, ok := s.matchAIDomain("custom.api.example.com")
	if !ok || v != "my-vendor" {
		t.Fatalf("exact extra: got %q %v", v, ok)
	}
	v, ok = s.matchAIDomain("svc-east.corp.llm")
	if !ok || v != "corp-llm" {
		t.Fatalf("suffix extra: got %q %v", v, ok)
	}
	_, ok = s.matchAIDomain("unknown.example.com")
	if ok {
		t.Fatal("expected no match")
	}
}
