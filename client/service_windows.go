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

// installAutoStart registers a Windows Task Scheduler task that runs ai-monitor
// at user logon. Runs under the current user's context (no admin required for
// HKCU-level scheduled tasks).
func installAutoStart(configPath string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	exePath, _ = filepath.Abs(exePath)

	absConfig, _ := filepath.Abs(configPath)

	args := fmt.Sprintf(`--config "%s"`, absConfig)

	// schtasks /Create: run at logon, under current user, no forced window
	cmd := exec.Command("schtasks", "/Create",
		"/TN", taskName,
		"/TR", fmt.Sprintf(`"%s" %s`, exePath, args),
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F", // overwrite if exists
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("创建计划任务失败: %w\n%s", err, string(output))
	}
	log.Printf("[service] 已注册开机自启任务 %q", taskName)
	return nil
}

// uninstallWatchdogTask removes the watchdog scheduled task left by pre-PAC installs.
// Kept for backward compatibility: new installs no longer create a watchdog task.
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

// uninstallAutoStart removes the scheduled task.
func uninstallAutoStart() error {
	cmd := exec.Command("schtasks", "/Delete", "/TN", taskName, "/F")
	output, err := cmd.CombinedOutput()
	if err != nil {
		outStr := strings.TrimSpace(string(output))
		if strings.Contains(outStr, "ERROR: The system cannot find") ||
			strings.Contains(outStr, "错误: 系统找不到") {
			return nil
		}
		return fmt.Errorf("删除计划任务失败: %w\n%s", err, outStr)
	}
	log.Printf("[service] 已移除开机自启任务 %q", taskName)
	return nil
}

// isAutoStartInstalled checks if the scheduled task exists.
func isAutoStartInstalled() bool {
	cmd := exec.Command("schtasks", "/Query", "/TN", taskName)
	err := cmd.Run()
	return err == nil
}

// startBackgroundInstance starts ai-monitor detached from the current console.
// Uses "start /b" via cmd.exe so the caller can exit immediately.
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
