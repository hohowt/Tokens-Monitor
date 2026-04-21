package main

import (
	"bufio"
	"bytes"
	"net/http"
	"testing"
)

func TestIsWebSocketUpgrade(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://chatgpt.com/backend-api/codex", nil)
	req.Header.Set("Connection", "keep-alive, Upgrade")
	req.Header.Set("Upgrade", "websocket")

	if !isWebSocketUpgrade(req) {
		t.Fatal("expected websocket upgrade to be detected")
	}
}

func TestMitmClientALPNForChatGPTForcesHTTP1(t *testing.T) {
	got := mitmClientALPN("chatgpt")
	if len(got) != 1 || got[0] != "http/1.1" {
		t.Fatalf("expected chatgpt ALPN to force http/1.1, got %#v", got)
	}

	got = mitmClientALPN("github-copilot")
	if len(got) != 2 || got[0] != "h2" || got[1] != "http/1.1" {
		t.Fatalf("expected non-chatgpt ALPN to keep h2 preference, got %#v", got)
	}
}

func TestCopyWebSocketServerToClientRecordsResponsesUsage(t *testing.T) {
	payload := []byte(`{"type":"response.completed","response":{"model":"gpt-5.4-codex","usage":{"input_tokens":12,"output_tokens":34,"total_tokens":46}}}`)
	rawFrame := buildServerWebSocketFrame(0x1, payload)

	cfg := &Config{
		ServerURL:  "http://127.0.0.1:1",
		UserName:   "tester",
		UserID:     "tester",
		Department: "dev",
	}
	reporter := NewReporter(cfg)
	proxy := &ProxyServer{cfg: cfg, reporter: reporter}

	var forwarded bytes.Buffer
	err := copyWebSocketServerToClient(&forwarded, bufio.NewReader(bytes.NewReader(rawFrame)), func(msg []byte) {
		proxy.processResponseData("openai", "/v1/responses", "gpt-5.4-codex", "codex", msg)
	})
	if err == nil {
		t.Fatal("expected EOF after single frame")
	}
	if !bytes.Equal(forwarded.Bytes(), rawFrame) {
		t.Fatal("websocket frame was not forwarded unchanged")
	}

	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if len(reporter.queue) != 1 {
		t.Fatalf("queue len = %d, want 1", len(reporter.queue))
	}
	rec := reporter.queue[0]
	if rec.TotalTokens != 46 || rec.PromptTokens != 12 || rec.CompletionTokens != 34 {
		t.Fatalf("usage not recorded: %+v", rec)
	}
	if rec.Model != "gpt-5.4-codex" || rec.SourceApp != "codex" {
		t.Fatalf("metadata not recorded: %+v", rec)
	}
}

func TestCopyWebSocketServerToClientReassemblesFragments(t *testing.T) {
	part1 := buildServerWebSocketFrameWithFin(false, 0x1, []byte(`{"usage":`))
	part2 := buildServerWebSocketFrameWithFin(true, 0x0, []byte(`{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`))

	var got [][]byte
	var forwarded bytes.Buffer
	err := copyWebSocketServerToClient(&forwarded, bufio.NewReader(bytes.NewReader(append(part1, part2...))), func(msg []byte) {
		got = append(got, append([]byte(nil), msg...))
	})
	if err == nil {
		t.Fatal("expected EOF after fragmented message")
	}
	if len(got) != 1 {
		t.Fatalf("messages = %d, want 1", len(got))
	}
	if string(got[0]) != `{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}` {
		t.Fatalf("reassembled payload = %q", string(got[0]))
	}
}

func buildServerWebSocketFrame(opcode byte, payload []byte) []byte {
	return buildServerWebSocketFrameWithFin(true, opcode, payload)
}

func buildServerWebSocketFrameWithFin(fin bool, opcode byte, payload []byte) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	frame := []byte{first}
	switch {
	case len(payload) < 126:
		frame = append(frame, byte(len(payload)))
	case len(payload) <= 0xffff:
		frame = append(frame, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		frame = append(frame, 127,
			byte(uint64(len(payload))>>56),
			byte(uint64(len(payload))>>48),
			byte(uint64(len(payload))>>40),
			byte(uint64(len(payload))>>32),
			byte(uint64(len(payload))>>24),
			byte(uint64(len(payload))>>16),
			byte(uint64(len(payload))>>8),
			byte(uint64(len(payload))),
		)
	}
	return append(frame, payload...)
}
