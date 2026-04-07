package main

import (
	"net/http"
	"net/url"
	"testing"
)

func TestShouldInjectOpenAIStreamOptions(t *testing.T) {
	cases := []struct {
		name string
		host string
		path string
		data map[string]interface{}
		want bool
	}{
		{"openai official", "api.openai.com", "/v1/chat/completions", map[string]interface{}{"stream": true}, true},
		{"azure openai", "my.openai.azure.com", "/openai/deployments/x/chat/completions", map[string]interface{}{"stream": true}, true},
		{"chat completions path", "api.deepseek.com", "/v1/chat/completions", map[string]interface{}{"stream": true}, true},
		{"anthropic host", "api.anthropic.com", "/v1/messages", map[string]interface{}{"stream": true}, false},
		{"anthropic_version body", "example.com", "/v1/chat/completions", map[string]interface{}{"stream": true, "anthropic_version": "2023-06-01"}, false},
		{"github copilot", "api.githubcopilot.com", "/anything", map[string]interface{}{"stream": true}, false},
		{"copilot proxy", "copilot-proxy.githubusercontent.com", "/v1/chat/completions", map[string]interface{}{"stream": true}, false},
		{"unrelated host path", "example.com", "/other", map[string]interface{}{"stream": true}, false},
	}
	for _, tc := range cases {
		u := &url.URL{Scheme: "https", Host: tc.host, Path: tc.path}
		r := &http.Request{URL: u, Host: tc.host}
		got := shouldInjectOpenAIStreamOptions(r, tc.data)
		if got != tc.want {
			t.Fatalf("%s: got %v want %v (host=%s path=%s)", tc.name, got, tc.want, tc.host, tc.path)
		}
	}
}
