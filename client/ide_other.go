//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type proxyKV struct {
	key, value string
}

type idePath struct {
	name string
	path string
}

func buildProxySettings(proxyURL string) []proxyKV {
	return []proxyKV{
		{`"http.proxy"`, fmt.Sprintf(`"%s"`, proxyURL)},
		{`"http.proxyStrictSSL"`, `false`},
		{`"http.proxySupport"`, `"on"`},
	}
}

func configureIDEProxy(proxyURL, caCertPath string) int {
	_ = caCertPath
	settings := buildProxySettings(proxyURL)
	count := 0
	for _, ide := range nonWindowsIDESettingsPaths() {
		if err := patchIDESettings(ide.path, settings); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("    ⚠ %s: %v", ide.name, err)
			}
			continue
		}
		fmt.Printf("    ✓ %s: %s\n", ide.name, ide.path)
		count++
	}
	return count
}

func removeIDEProxy() {
	removeKeys := []string{`"http.proxy"`, `"http.proxyStrictSSL"`, `"http.proxySupport"`}
	for _, ide := range nonWindowsIDESettingsPaths() {
		if err := unpatchIDESettings(ide.path, removeKeys); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("    ⚠ %s: %v", ide.name, err)
			}
		}
	}
}

func nonWindowsIDESettingsPaths() []idePath {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return nil
	}

	var base string
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support")
	default:
		base = filepath.Join(home, ".config")
	}

	return []idePath{
		{name: "VS Code", path: filepath.Join(base, "Code", "User", "settings.json")},
		{name: "VS Code Insiders", path: filepath.Join(base, "Code - Insiders", "User", "settings.json")},
		{name: "Cursor", path: filepath.Join(base, "Cursor", "User", "settings.json")},
		{name: "Kiro", path: filepath.Join(base, "Kiro", "User", "settings.json")},
		{name: "Windsurf", path: filepath.Join(base, "Windsurf", "User", "settings.json")},
		{name: "VS Codium", path: filepath.Join(base, "VSCodium", "User", "settings.json")},
		{name: "Trae", path: filepath.Join(base, "Trae", "User", "settings.json")},
	}
}

func patchIDESettings(path string, kvs []proxyKV) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(data)

	for _, kv := range kvs {
		pattern := regexp.MustCompile(
			`(?m)([ \t]*)` + regexp.QuoteMeta(kv.key) + `\s*:\s*("(?:[^"\\]|\\.)*"|\S+?)(\s*,?\s*)$`,
		)
		if pattern.MatchString(content) {
			content = pattern.ReplaceAllString(content, `${1}`+kv.key+`: `+kv.value+`${3}`)
		} else {
			idx := strings.LastIndex(content, "}")
			if idx < 0 {
				continue
			}
			indent := "    "
			beforeClose := strings.TrimRight(content[:idx], " \t\n\r")
			needComma := ""
			if len(beforeClose) > 0 && beforeClose[len(beforeClose)-1] != ',' && beforeClose[len(beforeClose)-1] != '{' {
				needComma = ","
			}
			insertion := needComma + "\n" + indent + kv.key + ": " + kv.value + "\n"
			content = beforeClose + insertion + content[idx:]
		}
	}

	return os.WriteFile(path, []byte(content), 0644)
}

func unpatchIDESettings(path string, keys []string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(data)
	changed := false

	for _, key := range keys {
		pattern := regexp.MustCompile(`(?m)^[ \t]*` + regexp.QuoteMeta(key) + `\s*:\s*("(?:[^"\\]|\\.)*"|\S+?)\s*,?\s*\n`)
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