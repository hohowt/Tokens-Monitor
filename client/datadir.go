package main

import (
	"os"
	"path/filepath"
	"runtime"
)

// appDataDir returns the platform-appropriate directory for storing
// ai-monitor's persistent data (CA cert, instance.json, install_state.json, etc.).
//
//	Windows: %APPDATA%\ai-monitor
//	macOS:   ~/.config/ai-monitor
//	Linux:   $XDG_DATA_HOME/ai-monitor  (fallback: ~/.local/share/ai-monitor)
func appDataDir() string {
	switch runtime.GOOS {
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "ai-monitor")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".config", "ai-monitor")
		}
	default:
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			return filepath.Join(xdg, "ai-monitor")
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".local", "share", "ai-monitor")
		}
	}
	return "ai-monitor"
}
