package main

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"testing"
)

func TestProcessRequestBodyInfersModelFromBinaryPayload(t *testing.T) {
	body := append([]byte{0x00, 0x08, 0x10}, []byte("cursor grpc gpt-5.4 stream")...)
	r := &http.Request{
		Method:        http.MethodPost,
		URL:           &url.URL{Scheme: "https", Host: "api2.cursor.sh", Path: "/aiserver.v1.AiService/Chat"},
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}

	got := (&ProxyServer{}).processRequestBody(r)
	if got != "gpt-5.4" {
		t.Fatalf("got %q", got)
	}

	restored, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read restored body: %v", err)
	}
	if !bytes.Equal(restored, body) {
		t.Fatalf("body changed: got %q want %q", restored, body)
	}
}