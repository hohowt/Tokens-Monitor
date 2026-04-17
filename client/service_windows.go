//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const taskName = "AIMonitorAutoStart"

// startupShortcutPath returns the path to the startup folder shortcut.
func startupShortcutPath() string {
	appData := os.Getenv("APPDATA")
	return filepath.Join(appData, `Microsoft\Windows\Start Menu\Programs\Startup`, "ai-monitor.lnk")
}

// installAutoStart registers ai-monitor to run at user logon.
// Strategy: try schtasks first (works on most systems); if "Access is denied",
// fall back to creating a shortcut in the user's Startup folder (no admin needed).
func installAutoStart(configPath string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	exePath, _ = filepath.Abs(exePath)
	absConfig, _ := filepath.Abs(configPath)

	args := fmt.Sprintf(`--config "%s"`, absConfig)

	// Try schtasks first
	cmd := exec.Command("schtasks", "/Create",
		"/TN", taskName,
		"/TR", fmt.Sprintf(`"%s" %s`, exePath, args),
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	)
	output, err := cmd.CombinedOutput()
	if err == nil {
		log.Printf("[service] 已注册开机自启任务 %q (schtasks)", taskName)
		removeStartupShortcut() // clean up shortcut if exists from previous fallback
		return nil
	}

	outStr := strings.TrimSpace(string(output))
	if !strings.Contains(strings.ToLower(outStr), "access") &&
		!strings.Contains(outStr, "拒绝") {
		return fmt.Errorf("创建计划任务失败: %w\n%s", err, outStr)
	}

	// Fallback: create shortcut in Startup folder (no admin needed)
	log.Printf("[service] schtasks 权限不足，改用启动文件夹快捷方式")
	return createStartupShortcut(exePath, absConfig)
}

// createStartupShortcut creates a .lnk shortcut in the user's Startup folder
// using a VBScript one-liner (no external dependencies).
func createStartupShortcut(exePath, configPath string) error {
	lnkPath := startupShortcutPath()
	workDir := filepath.Dir(exePath)

	// Use PowerShell to create the shortcut — more reliable than VBScript
	script := fmt.Sprintf(
		`$ws = New-Object -ComObject WScript.Shell; `+
			`$s = $ws.CreateShortcut('%s'); `+
			`$s.TargetPath = '%s'; `+
			`$s.Arguments = '--config "%s"'; `+
			`$s.WorkingDirectory = '%s'; `+
			`$s.WindowStyle = 7; `+
			`$s.Save()`,
		lnkPath, exePath, configPath, workDir,
	)

	cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("创建启动快捷方式失败: %w\n%s", err, string(output))
	}
	log.Printf("[service] 已创建启动快捷方式: %s", lnkPath)
	return nil
}

// removeStartupShortcut removes the Startup folder shortcut if it exists.
func removeStartupShortcut() {
	lnkPath := startupShortcutPath()
	if _, err := os.Stat(lnkPath); err == nil {
		os.Remove(lnkPath)
		log.Printf("[service] 已移除启动快捷方式: %s", lnkPath)
	}
}

// uninstallWatchdogTask removes the watchdog scheduled task left by pre-PAC installs.
func uninstallWatchdogTask() error {
	const watchdogTaskName = "AIMonitorWatchdog"
	cmd := exec.Command("schtasks", "/Delete", "/TN", watchdogTaskName, "/F")
	output, err := cmd.CombinedOutput()
	if err != nil {
		outStr := strings.TrimSpace(string(output))
		if strings.Contains(outStr, "ERROR: The system cannot find") ||
			strings.Contains(outStr, "错误: 系统找不到") {
			return nil
		}
		return fmt.Errorf("删除看门狗计划任务失败: %w\n%s", err, outStr)
	}
	log.Printf("[service] 已移除网络看门狗任务 %q", watchdogTaskName)
	return nil
}

// uninstallAutoStart removes both the scheduled task and Startup shortcut.
func uninstallAutoStart() error {
	// Remove scheduled task
	cmd := exec.Command("schtasks", "/Delete", "/TN", taskName, "/F")
	output, err := cmd.CombinedOutput()
	if err != nil {
		outStr := strings.TrimSpace(string(output))
		if !strings.Contains(outStr, "ERROR: The system cannot find") &&
			!strings.Contains(outStr, "错误: 系统找不到") {
			log.Printf("[service] 删除计划任务失败: %s", outStr)
		}
	} else {
		log.Printf("[service] 已移除开机自启任务 %q", taskName)
	}

	// Remove Startup shortcut
	removeStartupShortcut()

	return nil
}

// isAutoStartInstalled checks if auto-start is configured (either schtasks or shortcut).
func isAutoStartInstalled() bool {
	cmd := exec.Command("schtasks", "/Query", "/TN", taskName)
	if cmd.Run() == nil {
		return true
	}
	if _, err := os.Stat(startupShortcutPath()); err == nil {
		return true
	}
	return false
}

// startBackgroundInstance starts ai-monitor detached from the current console.
func startBackgroundInstance(configPath string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	exePath, _ = filepath.Abs(exePath)
	absConfig, _ := filepath.Abs(configPath)

	cmd := exec.Command("cmd", "/C", "start", "/b", "",
		exePath, "--config", absConfig)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	return cmd.Start()
}
