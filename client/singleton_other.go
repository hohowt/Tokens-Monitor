//go:build !windows

package main

import (
	"os"
	"syscall"
)

// isProcessAlive checks whether a process with the given PID is still running on Unix.
func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// Sending signal 0 checks existence without actually signaling.
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
