//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	modkernel32            = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess        = modkernel32.NewProc("OpenProcess")
	procCloseHandle        = modkernel32.NewProc("CloseHandle")
	procGetExitCodeProcess = modkernel32.NewProc("GetExitCodeProcess")
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// isProcessAlive checks whether a process with the given PID is still running on Windows.
func isProcessAlive(pid int) bool {
	handle, _, err := procOpenProcess.Call(
		uintptr(processQueryLimitedInformation),
		0, // bInheritHandle = false
		uintptr(pid),
	)
	if handle == 0 {
		_ = err
		return false
	}
	defer procCloseHandle.Call(handle)

	var exitCode uint32
	ret, _, _ := procGetExitCodeProcess.Call(handle, uintptr(unsafe.Pointer(&exitCode)))
	if ret == 0 {
		return false
	}
	return exitCode == stillActive
}
