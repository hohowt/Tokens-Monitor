package main

import (
	"net"
	"testing"
)

func TestTryListenMitmPort_ReusesPreferredWhenFree(t *testing.T) {
	ln0, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	freePort := ln0.Addr().(*net.TCPAddr).Port
	ln0.Close()

	ln, got, err := tryListenMitmPort(freePort)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if got != freePort {
		t.Fatalf("got %d want %d", got, freePort)
	}
}

func TestTryListenMitmPort_FallbackWhenBusy(t *testing.T) {
	block, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer block.Close()
	busyPort := block.Addr().(*net.TCPAddr).Port

	ln, got, err := tryListenMitmPort(busyPort)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if got != busyPort+1 {
		t.Fatalf("got port %d, want %d (next after busy)", got, busyPort+1)
	}
}
