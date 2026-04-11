package main

import (
	"net/http"
	"testing"
)

func TestInferSourceAppFromHeaders(t *testing.T) {
	tests := []struct {
		name   string
		header http.Header
		want   string
	}{
		{
			name:   "empty headers",
			header: http.Header{},
			want:   "",
		},
		{
			name: "Cursor via User-Agent",
			header: http.Header{
				"User-Agent": {"Cursor/0.50.4"},
			},
			want: "cursor",
		},
		{
			name: "VS Code via User-Agent",
			header: http.Header{
				"User-Agent": {"vscode/1.96.0"},
			},
			want: "vscode",
		},
		{
			name: "Copilot in Cursor via editor-version",
			header: http.Header{
				"User-Agent":     {"GithubCopilot/1.0"},
				"Editor-Version": {"cursor/0.50.4"},
			},
			want: "cursor",
		},
		{
			name: "Copilot in VS Code via editor-version",
			header: http.Header{
				"User-Agent":     {"GithubCopilot/1.0"},
				"Editor-Version": {"vscode/1.96.0"},
			},
			want: "vscode",
		},
		{
			name: "Windsurf via User-Agent",
			header: http.Header{
				"User-Agent": {"windsurf/1.2.3"},
			},
			want: "windsurf",
		},
		{
			name: "Kiro via User-Agent",
			header: http.Header{
				"User-Agent": {"kiro/0.1.0"},
			},
			want: "kiro",
		},
		{
			name: "VS Codium",
			header: http.Header{
				"User-Agent": {"Codium/1.96.0"},
			},
			want: "vscodium",
		},
		{
			name: "VS Codium alternate",
			header: http.Header{
				"User-Agent": {"vscodium/1.96.0"},
			},
			want: "vscodium",
		},
		{
			name: "Claude Code",
			header: http.Header{
				"User-Agent": {"claude-code/1.0.0"},
			},
			want: "claude",
		},
		{
			name: "Codex CLI",
			header: http.Header{
				"User-Agent": {"codex/0.1.0"},
			},
			want: "codex",
		},
		{
			name: "JetBrains AI",
			header: http.Header{
				"User-Agent": {"JetBrains/2024.1 IntelliJ IDEA"},
			},
			want: "jetbrains",
		},
		{
			name: "Trae via User-Agent",
			header: http.Header{
				"User-Agent": {"trae/1.0.0"},
			},
			want: "trae",
		},
		{
			name: "editor-version takes priority over User-Agent",
			header: http.Header{
				"User-Agent":     {"vscode/1.96.0"},
				"Editor-Version": {"cursor/0.50.4"},
			},
			want: "cursor",
		},
		{
			name: "unknown User-Agent",
			header: http.Header{
				"User-Agent": {"Mozilla/5.0 (Windows NT 10.0)"},
			},
			want: "",
		},
		{
			name: "OpenCode",
			header: http.Header{
				"User-Agent": {"opencode/0.5.0"},
			},
			want: "opencode",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := inferSourceAppFromHeaders(tt.header)
			if got != tt.want {
				t.Errorf("inferSourceAppFromHeaders() = %q, want %q", got, tt.want)
			}
		})
	}
}
