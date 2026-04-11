package main

import (
	"net/url"
	"strings"
)

// bypassDomains 是系统代理 / NO_PROXY 共用的直连域名列表。
// 保留内网直连的同时，让 VS Code 扩展市场、CDN、更新等走直连，
// 避免未启动 MITM 或 MITM 仅处理 AI 域名时编辑器无法联网。
var bypassDomains = []string{
	"localhost",
	"127.0.0.1",
	"10.*",
	"192.168.*",
	"172.16.*",
	"*.local",
	// VS Code / Marketplace / 更新（见官方网络文档常见域名）
	"*.vscode-cdn.net",
	"*.gallery.vsassets.io",
	"marketplace.visualstudio.com",
	"*.vsassets.io",
	"vscodeexperiments.azureedge.net",
	"az764295.vo.msecnd.net",
	"*.vo.msecnd.net",
	"*.vscode-unpkg.net",
	"vscode.blob.core.windows.net",
	"default.exp-tas.com",
	// Microsoft 账户 / 部分 Azure 边缘节点（登录与实验配置）
	"login.microsoftonline.com",
	"*.microsoftonline.com",
	// GitHub 网站本身走直连，但 Copilot API 域名（*.githubcopilot.com / copilot-proxy.githubusercontent.com）不绕过，经 MITM 监控
	"github.com",
	"*.github.com",
}

// buildProxyBypass 返回 Windows「Internet 代理」的例外列表 (ProxyOverride，分号分隔)。
func buildProxyBypass() string {
	parts := make([]string, 0, len(bypassDomains)+1)
	parts = append(parts, bypassDomains...)
	parts = append(parts, "<local>")
	return strings.Join(parts, ";")
}

// buildNoProxyEnv 返回 NO_PROXY（逗号分隔），须与 buildProxyBypass 的「直连」域名一致。
func buildNoProxyEnv() string {
	return strings.Join(bypassDomains, ",")
}

// buildNoProxyEnvWithConfig is like buildNoProxyEnv but also includes the
// reporting server hostname so that heartbeat/collect traffic doesn't loop
// through ai-monitor itself.
func buildNoProxyEnvWithConfig(cfg *Config) string {
	domains := make([]string, len(bypassDomains))
	copy(domains, bypassDomains)
	if cfg != nil && cfg.ServerURL != "" {
		if u, err := url.Parse(cfg.ServerURL); err == nil && u.Hostname() != "" {
			domains = append(domains, u.Hostname())
		}
	}
	return strings.Join(domains, ",")
}
