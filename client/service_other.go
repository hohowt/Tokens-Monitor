//go:build !windows

package main

import "fmt"

func installAutoStart(_ string) error {
	return fmt.Errorf("开机自启仅支持 Windows")
}

func uninstallAutoStart() error {
	return fmt.Errorf("开机自启仅支持 Windows")
}

func isAutoStartInstalled() bool {
	return false
}

func startBackgroundInstance(_ string) error {
	return fmt.Errorf("后台启动仅支持 Windows")
}

func uninstallWatchdogTask() error {
	return nil
}

