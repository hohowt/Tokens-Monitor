package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

const maxQueueSize = 10000

// 上报重试次数（瞬时网络抖动、服务端短暂重启）
const reportMaxAttempts = 4

// UsageRecord is a single token usage event to be reported to the server.
type UsageRecord struct {
	ClientID         string  `json:"client_id"`
	UserName         string  `json:"user_name"`
	UserID           string  `json:"user_id"`
	Department       string  `json:"department"`
	RequestID        string  `json:"request_id,omitempty"`
	SourceApp        string  `json:"source_app,omitempty"`
	Vendor           string  `json:"vendor"`
	Model            string  `json:"model"`
	Endpoint         string  `json:"endpoint"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	CostMultiplier   float64 `json:"cost_multiplier,omitempty"`
	RequestTime      string  `json:"request_time"`
	// Source 上报来源：client 为 JSON 解析；client-mitm-estimate 为 gRPC/二进制体积估算。
	Source string `json:"source,omitempty"`
}

// ReporterStats tracks cumulative reporting statistics.
type ReporterStats struct {
	TotalReported atomic.Int64
	TotalTokens   atomic.Int64
	TotalFailed   atomic.Int64
}

// Reporter batches usage records and periodically sends them to the central server.
type Reporter struct {
	cfg         *Config
	clientID    string
	sourceApp   string
	queue       []UsageRecord
	mu          sync.Mutex
	client      *http.Client
	Stats       ReporterStats
	heartbeatOK sync.Once
}

func newHTTPClientForReporter() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy: func(*http.Request) (*url.URL, error) { return nil, nil },
			// 生产环境：连接池与超时，避免长时间运行后连接僵死
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

func NewReporter(cfg *Config) *Reporter {
	hostname, _ := os.Hostname()
	clientID := cfg.UserID + "@" + hostname

	return &Reporter{
		cfg:      cfg,
		clientID: clientID,
		client:   newHTTPClientForReporter(),
	}
}

// PingServer 启动时探测上报服务是否可达（GET /health）。
func (r *Reporter) PingServer(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.cfg.ServerURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// Add enqueues a usage record for reporting.
func (r *Reporter) Add(record UsageRecord) {
	record.ClientID = r.clientID
	record.UserName = r.cfg.UserName
	record.UserID = r.cfg.UserID
	record.Department = r.cfg.Department
	if record.SourceApp == "" {
		record.SourceApp = r.sourceApp
	}
	record.RequestTime = time.Now().Format(time.RFC3339)
	if record.RequestID == "" {
		record.RequestID = newRequestID()
	}

	r.mu.Lock()
	if len(r.queue) >= maxQueueSize {
		r.queue = r.queue[1:]
		log.Printf("[警告] 队列已满(%d)，丢弃最早的记录", maxQueueSize)
	}
	r.queue = append(r.queue, record)
	r.mu.Unlock()

	if record.Source == "client-mitm-estimate" {
		log.Printf("[记录·估算] %s | %s | 输入:%d 输出:%d 总计:%d（响应非 JSON，按体积粗算，非官方计费）",
			record.Vendor, record.Model,
			record.PromptTokens, record.CompletionTokens, record.TotalTokens)
	} else {
		log.Printf("[记录] %s | %s | 输入:%d 输出:%d 总计:%d",
			record.Vendor, record.Model,
			record.PromptTokens, record.CompletionTokens, record.TotalTokens)
	}
}

func newRequestID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err == nil {
		return hex.EncodeToString(buf)
	}
	return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
}

// Start begins the periodic reporting loop. Should be called in a goroutine.
// Exits when ctx is cancelled, performing a final Flush.
func (r *Reporter) Start(ctx context.Context) {
	r.sendHeartbeatWithRetry()

	flushTicker := time.NewTicker(30 * time.Second)
	heartbeatTicker := time.NewTicker(30 * time.Second)
	defer flushTicker.Stop()
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.Flush()
			return
		case <-flushTicker.C:
			r.Flush()
		case <-heartbeatTicker.C:
			r.sendHeartbeatWithRetry()
		}
	}
}

// postJSONRetry POST JSON 并在失败时指数退避重试。
func (r *Reporter) postJSONRetry(path string, body []byte) (*http.Response, error) {
	full := r.cfg.ServerURL + path
	var lastErr error
	for attempt := 0; attempt < reportMaxAttempts; attempt++ {
		if attempt > 0 {
			d := time.Duration(400*(1<<uint(attempt-1))) * time.Millisecond
			if d > 3*time.Second {
				d = 3 * time.Second
			}
			time.Sleep(d)
		}
		req, err := http.NewRequest(http.MethodPost, full, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		if r.cfg.APIKey != "" {
			req.Header.Set("X-API-Key", r.cfg.APIKey)
		}
		resp, err := r.client.Do(req)
		if err != nil {
			lastErr = err
			log.Printf("[网络] POST %s 第 %d/%d 次失败: %v", path, attempt+1, reportMaxAttempts, err)
			continue
		}
		if resp.StatusCode == http.StatusOK {
			return resp, nil
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
		log.Printf("[网络] POST %s 第 %d/%d 次 HTTP %d", path, attempt+1, reportMaxAttempts, resp.StatusCode)
	}
	return nil, lastErr
}

// Flush sends all queued records to the server.
func (r *Reporter) Flush() {
	r.mu.Lock()
	if len(r.queue) == 0 {
		r.mu.Unlock()
		return
	}
	records := r.queue
	r.queue = nil
	r.mu.Unlock()

	data, err := json.Marshal(records)
	if err != nil {
		log.Printf("[上报] 序列化失败: %v", err)
		r.requeue(records)
		return
	}

	resp, err := r.postJSONRetry("/api/collect", data)
	if err != nil {
		log.Printf("[上报] 最终失败: %v (将重试)", err)
		r.Stats.TotalFailed.Add(int64(len(records)))
		r.requeue(records)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	r.Stats.TotalReported.Add(int64(len(records)))
	for _, rec := range records {
		r.Stats.TotalTokens.Add(int64(rec.TotalTokens))
	}
	log.Printf("[上报] 成功 %d 条 → %s (累计: %d 条, %d tokens)",
		len(records), r.cfg.ServerURL, r.Stats.TotalReported.Load(), r.Stats.TotalTokens.Load())
}

func (r *Reporter) requeue(records []UsageRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := len(records) + len(r.queue)
	if total > maxQueueSize {
		overflow := total - maxQueueSize
		if overflow < len(records) {
			records = records[overflow:]
		} else {
			records = nil
		}
	}
	r.queue = append(records, r.queue...)
}

func (r *Reporter) sendHeartbeatWithRetry() {
	hostname, _ := os.Hostname()
	data, err := json.Marshal(map[string]interface{}{
		"client_id":  r.clientID,
		"user_name":  r.cfg.UserName,
		"user_id":    r.cfg.UserID,
		"department": r.cfg.Department,
		"hostname":   hostname,
		"version":    Version,
	})
	if err != nil {
		return
	}

	resp, err := r.postJSONRetry("/api/clients/heartbeat", data)
	if err != nil {
		log.Printf("[心跳] 发送失败: %v", err)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	r.heartbeatOK.Do(func() {
		log.Printf("[心跳] 已连接上报服务器 %s（此后每 30s 静默心跳）", r.cfg.ServerURL)
	})
}
