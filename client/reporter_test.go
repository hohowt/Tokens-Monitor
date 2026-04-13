package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// TestReporterFlushRecordedByServer 验证：客户端上报 HTTP 直连模拟 135 服务端时，用量 JSON 能被服务端收到。
func TestReporterFlushRecordedByServer(t *testing.T) {
	var mu sync.Mutex
	var gotCollect []byte
	var gotHeartbeat int

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/collect":
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			gotCollect = b
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok","inserted":1}`))
		case "/api/clients/heartbeat":
			mu.Lock()
			gotHeartbeat++
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL:  ts.URL,
		UserName:   "测试用户",
		UserID:     "test-user",
		Department: "测试部",
		Port:       18090,
	}

	rp := NewReporter(cfg)
	rp.sendHeartbeatWithRetry()

	mu.Lock()
	h := gotHeartbeat
	mu.Unlock()
	if h != 1 {
		t.Fatalf("heartbeat 次数 = %d, want 1", h)
	}

	rp.Add(UsageRecord{
		Vendor:           "openai",
		Model:            "gpt-4o-mini",
		Endpoint:         "/v1/chat/completions",
		PromptTokens:     100,
		CompletionTokens: 50,
		TotalTokens:      150,
	})
	rp.Flush()

	mu.Lock()
	raw := gotCollect
	mu.Unlock()
	if len(raw) == 0 {
		t.Fatal("服务端未收到 /api/collect 请求体")
	}

	var records []UsageRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("JSON: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("记录条数 = %d, want 1", len(records))
	}
	rec := records[0]
	if rec.TotalTokens != 150 || rec.Model != "gpt-4o-mini" || rec.Vendor != "openai" {
		t.Fatalf("记录内容 %+v 不符合预期", rec)
	}
	if rec.UserName != "测试用户" || rec.UserID != "test-user" {
		t.Fatalf("用户信息未填充: %+v", rec)
	}
	if rec.RequestID == "" {
		t.Fatal("expected request_id to be populated for idempotent retries")
	}
	if rp.Stats.TotalReported.Load() != 1 {
		t.Fatalf("Stats.TotalReported = %d", rp.Stats.TotalReported.Load())
	}
}
