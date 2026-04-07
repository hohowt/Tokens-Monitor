package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestResolveLaunchCommand_ExplicitCommand(t *testing.T) {
	args, preset, err := resolveLaunchCommand([]string{"code.cmd", "--reuse-window"}, "", func(cmd string) (string, error) {
		return "", fmt.Errorf("should not call lookPath for explicit command: %s", cmd)
	})
	if err != nil {
		t.Fatal(err)
	}
	if preset != nil {
		t.Fatal("expected nil preset for explicit command")
	}
	if len(args) != 2 || args[0] != "code.cmd" || args[1] != "--reuse-window" {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestResolveLaunchCommand_Preset(t *testing.T) {
	args, preset, err := resolveLaunchCommand([]string{"--new-window"}, "vscode", func(cmd string) (string, error) {
		if cmd == "code.cmd" {
			return `C:\Tools\code.cmd`, nil
		}
		return "", fmt.Errorf("not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if preset == nil || preset.Name != "vscode" {
		t.Fatalf("unexpected preset: %#v", preset)
	}
	if len(args) != 2 || args[0] != `C:\Tools\code.cmd` || args[1] != "--new-window" {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestResolveLaunchCommand_UnknownPreset(t *testing.T) {
	_, _, err := resolveLaunchCommand(nil, "unknown-app", func(cmd string) (string, error) {
		return "", fmt.Errorf("not found")
	})
	if err == nil || !strings.Contains(err.Error(), "未知 launch 预设") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResolvePresetBinary_MissingBinary(t *testing.T) {
	preset := launchPreset{
		Name:       "cursor",
		Candidates: []string{"cursor.exe", "cursor.cmd"},
		KnownPaths: []string{`C:\Users\tester\AppData\Local\Programs\Cursor\Cursor.exe`},
	}
	_, tried, err := resolvePresetBinary(preset, func(cmd string) (string, error) {
		return "", fmt.Errorf("not found: %s", cmd)
	}, func(path string) bool {
		return false
	})
	if err == nil {
		t.Fatal("expected error for missing preset binary")
	}
	if len(tried) != 3 {
		t.Fatalf("expected all candidates to be tracked, got %#v", tried)
	}
}

func TestResolvePresetBinary_FallsBackToKnownPaths(t *testing.T) {
	preset := launchPreset{
		Name:       "vscode",
		Candidates: []string{"code.cmd"},
		KnownPaths: []string{`C:\Users\tester\AppData\Local\Programs\Microsoft VS Code\Code.exe`},
	}
	got, tried, err := resolvePresetBinary(preset, func(cmd string) (string, error) {
		return "", fmt.Errorf("not found")
	}, func(path string) bool {
		return path == `C:\Users\tester\AppData\Local\Programs\Microsoft VS Code\Code.exe`
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != `C:\Users\tester\AppData\Local\Programs\Microsoft VS Code\Code.exe` {
		t.Fatalf("unexpected resolved path: %q", got)
	}
	if len(tried) != 2 {
		t.Fatalf("expected 2 tried entries, got %#v", tried)
	}
}

func TestExpandEnvPath(t *testing.T) {
	t.Setenv("LOCALAPPDATA", `C:\Users\tester\AppData\Local`)
	got := expandEnvPath(`%LOCALAPPDATA%\Programs\Cursor\Cursor.exe`)
	want := `C:\Users\tester\AppData\Local\Programs\Cursor\Cursor.exe`
	if got != want {
		t.Fatalf("expandEnvPath()=%q want %q", got, want)
	}
}

func TestInferSourceApp(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		preset  *launchPreset
		wantApp string
	}{
		{name: "preset wins", args: []string{"C:\\Tools\\cursor.exe"}, preset: &launchPreset{Name: "cursor"}, wantApp: "cursor"},
		{name: "vscode command", args: []string{"code.cmd"}, wantApp: "vscode"},
		{name: "powershell exe", args: []string{"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"}, wantApp: "powershell"},
		{name: "custom command", args: []string{"python.exe"}, wantApp: "python"},
		{name: "empty args", args: nil, wantApp: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := inferSourceApp(tc.args, tc.preset); got != tc.wantApp {
				t.Fatalf("inferSourceApp()=%q want %q", got, tc.wantApp)
			}
		})
	}
}

func TestManagedPresetProcessImage(t *testing.T) {
	tests := []struct {
		name        string
		preset      *launchPreset
		wantImage   string
		wantDisplay string
	}{
		{name: "nil", preset: nil},
		{name: "vscode", preset: &launchPreset{Name: "vscode"}, wantImage: "Code.exe", wantDisplay: "VS Code"},
		{name: "cursor", preset: &launchPreset{Name: "cursor"}, wantImage: "Cursor.exe", wantDisplay: "Cursor"},
		{name: "powershell", preset: &launchPreset{Name: "powershell"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotImage, gotDisplay := managedPresetProcessImage(tc.preset)
			if gotImage != tc.wantImage || gotDisplay != tc.wantDisplay {
				t.Fatalf("managedPresetProcessImage()=(%q,%q) want (%q,%q)", gotImage, gotDisplay, tc.wantImage, tc.wantDisplay)
			}
		})
	}
}
