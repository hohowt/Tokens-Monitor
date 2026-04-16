package main

import "testing"

func TestValidateServerURL(t *testing.T) {
	if err := validateServerURL("https://otw.tech:59889"); err != nil {
		t.Fatal(err)
	}
	if err := validateServerURL("https://api.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := validateServerURL(""); err == nil {
		t.Fatal("expect error for empty")
	}
	if err := validateServerURL("ftp://x"); err == nil {
		t.Fatal("expect error for ftp")
	}
	if err := validateServerURL("http://"); err == nil {
		t.Fatal("expect error for no host")
	}
}

func TestValidateUpstreamProxyURL(t *testing.T) {
	for _, raw := range []string{"", "http://127.0.0.1:7890", "https://proxy.example.com", "socks5://127.0.0.1:1080"} {
		if err := validateUpstreamProxyURL(raw); err != nil {
			t.Fatalf("validateUpstreamProxyURL(%q): %v", raw, err)
		}
	}
	for _, raw := range []string{"ftp://proxy.example.com", "http://"} {
		if err := validateUpstreamProxyURL(raw); err == nil {
			t.Fatalf("expected error for %q", raw)
		}
	}
}
