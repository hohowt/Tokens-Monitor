//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ideSettingsPaths lists User settings.json locations for Electron-based IDEs.
var ideSettingsPaths = []struct {
	name    string
	relPath string // relative to APPDATA
}{
	{"VS Code", `Code\User\settings.json`},
	{"VS Code Insiders", `Code - Insiders\User\settings.json`},
	{"Cursor", `Cursor\User\settings.json`},
	{"Kiro", `Kiro\User\settings.json`},
	{"Windsurf", `Windsurf\User\settings.json`},
}

// proxySettings are the key-value pairs we inject into IDE settings.
type proxyKV struct {
	key, value string // value is the raw JSON value including quotes
}

func buildProxySettings(proxyURL string) []proxyKV {
	return []proxyKV{
		{`"http.proxy"`, fmt.Sprintf(`"%s"`, proxyURL)},
		{`"http.proxyStrictSSL"`, `false`},
		{`"http.proxySupport"`, `"on"`},
	}
}

// configureIDEProxy patches all detected IDE settings.json files.
// Returns the number of IDEs configured.
func configureIDEProxy(proxyURL, caCertPath string) int {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return 0
	}

	settings := buildProxySettings(proxyURL)
	count := 0
	for _, ide := range ideSettingsPaths {
		p := filepath.Join(appData, ide.relPath)
		if err := patchIDESettings(p, settings); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("    ⚠ %s: %v", ide.name, err)
			}
			continue
		}
		fmt.Printf("    ✓ %s: %s\n", ide.name, p)
		count++
	}
	return count
}

// removeIDEProxy removes proxy settings from all detected IDE settings.json files.
func removeIDEProxy() {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return
	}
	removeKeys := []string{`"http.proxy"`, `"http.proxyStrictSSL"`, `"http.proxySupport"`}
	for _, ide := range ideSettingsPaths {
		p := filepath.Join(appData, ide.relPath)
		if err := unpatchIDESettings(p, removeKeys); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("    ⚠ %s: %v", ide.name, err)
			}
		}
	}
}

// patchIDESettings uses regex to update or insert proxy settings in a JSONC file.
// This preserves comments, formatting, and all other settings.
func patchIDESettings(path string, kvs []proxyKV) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(data)

	for _, kv := range kvs {
		// Try to find and replace existing setting
		// Match: "key": <any value> with optional trailing comma
		pattern := regexp.MustCompile(
			`(?m)([ \t]*)` + regexp.QuoteMeta(kv.key) + `\s*:\s*("(?:[^"\\]|\\.)*"|\S+?)(\s*,?\s*)$`,
		)
		if pattern.MatchString(content) {
			content = pattern.ReplaceAllString(content,
				`${1}`+kv.key+`: `+kv.value+`${3}`,
			)
		} else {
			// Insert before the last closing brace
			idx := strings.LastIndex(content, "}")
			if idx < 0 {
				continue
			}
			// Find indent of existing settings (typically 4 spaces)
			indent := "    "
			// Add comma after previous last property if needed
			beforeClose := strings.TrimRight(content[:idx], " \t\n\r")
			needComma := ""
			if len(beforeClose) > 0 && beforeClose[len(beforeClose)-1] != ',' &&
				beforeClose[len(beforeClose)-1] != '{' {
				needComma = ","
			}
			insertion := needComma + "\n" + indent + kv.key + ": " + kv.value + "\n"
			content = beforeClose + insertion + content[idx:]
		}
	}

	return os.WriteFile(path, []byte(content), 0644)
}

// unpatchIDESettings removes specified keys from an IDE settings.json.
func unpatchIDESettings(path string, keys []string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(data)
	changed := false

	for _, key := range keys {
		// Match the entire line with the key, including trailing comma and newline
		pattern := regexp.MustCompile(
			`(?m)^[ \t]*` + regexp.QuoteMeta(key) + `\s*:\s*("(?:[^"\\]|\\.)*"|\S+?)\s*,?\s*\n`,
		)
		if pattern.MatchString(content) {
			content = pattern.ReplaceAllString(content, "")
			changed = true
		}
	}

	if !changed {
		return nil
	}
	return os.WriteFile(path, []byte(content), 0644)
}
