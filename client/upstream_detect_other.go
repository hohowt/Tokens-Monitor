//go:build !windows

package main

// readCurrentSystemProxy is a no-op on non-Windows platforms.
// On macOS/Linux the system proxy is typically configured via environment variables,
// which detectUpstreamProxy() already handles.
func readCurrentSystemProxy() string {
	return ""
}
