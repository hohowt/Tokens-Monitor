package main

import (
	"fmt"
	"net/url"
	"strings"
)

// validateServerURL 校验上报地址可用于 HTTP 客户端（生产环境避免静默失败）。
func validateServerURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("server_url 不能为空")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("server_url 解析失败: %w", err)
	}
	switch u.Scheme {
	case "http", "https":
	default:
		return fmt.Errorf("server_url 须为 http 或 https，当前为 %q", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("server_url 缺少主机名")
	}
	return nil
}

// validateUpstreamProxyURL 校验可选上游代理地址。
func validateUpstreamProxyURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("upstream_proxy 解析失败: %w", err)
	}
	switch u.Scheme {
	case "http", "https", "socks5":
	default:
		return fmt.Errorf("upstream_proxy 须为 http、https 或 socks5，当前为 %q", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("upstream_proxy 缺少主机名")
	}
	return nil
}
