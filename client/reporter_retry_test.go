package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// TestReporterFlushRetriesUntilOK 模拟服务端前两次 503、第三次 200，验证重试后仍能入库。
func TestReporterFlushRetriesUntilOK(t *testing.T) {
	var attempts int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/collect" {
			http.NotFound(w, r)
			return
		}
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL: ts.URL,
		UserName:  "t", UserID: "u", Port: 18090,
	}
	rp := NewReporter(cfg)
	rp.Add(UsageRecord{Vendor: "x", Model: "m", TotalTokens: 10})
	rp.Flush()

	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("attempts=%d want 3", attempts)
	}
	if rp.Stats.TotalReported != 1 {
		t.Fatalf("TotalReported=%d", rp.Stats.TotalReported)
	}
}
