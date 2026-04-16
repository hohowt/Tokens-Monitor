package main

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"strings"
)

// DefaultServerURL is the pre-configured server address.
// Change this before compiling to distribute to your team.
const DefaultServerURL = "https://otw.tech:59889"

// MonitoredSuffix 按主机名后缀匹配并打上供应商标签（用于公司自建网关、新厂商域名等）。
type MonitoredSuffix struct {
	Suffix string `json:"suffix"` // 例如 ".internal-ai.company.com"
	Vendor string `json:"vendor"` // 大屏上显示的供应商名，如 "internal-llm"
}

type Config struct {
	ServerURL  string `json:"server_url"`
	UserName   string `json:"user_name"`
	UserID     string `json:"user_id"`
	Department string `json:"department"`
	Port       int    `json:"port"`
	// UpstreamProxy 为本地 MITM 外联时使用的上游代理（可选），用于保留用户原本的公司代理或本地代理链路。
	// 支持 http://、https://、socks5://。
	UpstreamProxy string `json:"upstream_proxy,omitempty"`
	// ExtraMonitorHosts 精确主机名 → 供应商（与内置 aiDomains 合并，适合内网网关、新 API 域名）。
	ExtraMonitorHosts map[string]string `json:"extra_monitor_hosts,omitempty"`
	// ExtraMonitorSuffixes 后缀匹配，在通配规则之后评估。
	ExtraMonitorSuffixes []MonitoredSuffix `json:"extra_monitor_suffixes,omitempty"`
	// InstallSystemProxy 为 true 时，--install 写入 WinINet 与 setx。
	// 省略该字段时默认 false：优先采用非侵入式模式，不修改本机系统代理与持久环境变量。
	InstallSystemProxy *bool `json:"install_system_proxy,omitempty"`
	// InstallIDEProxy 为 true 时才写入 VS Code/Cursor 等的 settings.json（http.proxy 等）。默认 false：仅靠系统代理即可让 Electron 走 MITM，避免与 WinINet 重复配置导致网络异常。
	InstallIDEProxy *bool `json:"install_ide_proxy,omitempty"`
	// ReportOpaqueTraffic 为 true（默认）时，对无法解析 JSON usage 的响应（如 gRPC/Protobuf）按响应体大小做粗略估算并上报，使 135 大屏可见；非官方计费口径。
	// 设为 false 则仅上报能解析出 usage 的 JSON（与旧版行为一致）。
	ReportOpaqueTraffic *bool `json:"report_opaque_traffic,omitempty"`
	// GatewayPort 为 API Gateway 专用端口（可选）。设置后，该端口仅提供反向代理 /v1/* 与 /vendor/* 路由，
	// 不做 CONNECT MITM，也不需要 CA 证书信任。设为 0 或省略则 Gateway 路由共享 MITM 主端口。
	GatewayPort int `json:"gateway_port,omitempty"`
	// APIKey 上报数据时附加的认证 Key，对应服务端 COLLECT_API_KEY 配置。为空时不发送 X-API-Key 头。
	APIKey string `json:"api_key,omitempty"`
	// ExtraBypassDomains 企业管理员可添加的额外直连域名/通配，与内置 bypassDomains 合并。
	// 适合公司内网域名（如 "*.corp.company.com"）、VPN 地址等。
	ExtraBypassDomains []string `json:"extra_bypass_domains,omitempty"`
	// ReportProxy 上报服务器流量使用的代理。"auto" 或空值 = 智能判断（内网直连，外网走上游代理）；
	// "direct" = 强制直连；"upstream" = 强制走 upstream_proxy；也可填具体代理地址。
	ReportProxy string `json:"report_proxy,omitempty"`
}

// EffectiveInstallSystemProxy 是否写入系统代理与环境变量。省略字段时默认 false，优先保持本机网络环境不变。
func (c *Config) EffectiveInstallSystemProxy() bool {
	if c == nil {
		return false
	}
	if c.InstallSystemProxy == nil {
		return false
	}
	return *c.InstallSystemProxy
}

// EffectiveInstallIDEProxy 是否向 IDE 的 settings.json 注入 http.proxy。默认 false。
func (c *Config) EffectiveInstallIDEProxy() bool {
	if c == nil || c.InstallIDEProxy == nil {
		return false
	}
	return *c.InstallIDEProxy
}

// EffectiveReportOpaqueTraffic 无法解析 JSON usage 时是否按体积估算上报。默认 true。
func (c *Config) EffectiveReportOpaqueTraffic() bool {
	if c == nil || c.ReportOpaqueTraffic == nil {
		return true
	}
	return *c.ReportOpaqueTraffic
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("未找到配置文件 %s\n  请双击「开始使用.bat」，或在本目录执行: ai-monitor.exe --setup", path)
		}
		return nil, err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("配置文件格式错误: %v", err)
	}

	if cfg.Port == 0 {
		cfg.Port = 18090
	}
	if cfg.ServerURL == "" {
		cfg.ServerURL = DefaultServerURL
	}
	cfg.ServerURL = strings.TrimSpace(strings.TrimRight(cfg.ServerURL, "/"))
	cfg.UpstreamProxy = strings.TrimSpace(cfg.UpstreamProxy)
	// Auto-fill missing fields from OS
	if cfg.UserName == "" {
		cfg.UserName = getOSUserName()
	}
	if cfg.UserID == "" {
		cfg.UserID = generateUserID()
	}

	if err := validateServerURL(cfg.ServerURL); err != nil {
		return nil, fmt.Errorf("server_url 无效: %w", err)
	}
	if err := validateUpstreamProxyURL(cfg.UpstreamProxy); err != nil {
		return nil, fmt.Errorf("upstream_proxy 无效: %w", err)
	}

	return &cfg, nil
}

// generateUserID 生成稳定的匿名用户 ID（MD5 哈希，16 位十六进制）。
// 优先对 Windows SID（user.Uid，格式 S-1-5-21-...）哈希，确保改名/换机同人仍为同 ID。
// 兜底对小写完整登录名哈希（DOMAIN\\user），避免手填工号时大小写错误。
func generateUserID() string {
	u, err := user.Current()
	var raw string
	if err == nil {
		// u.Uid 在 Windows 上是完整 SID，在 Linux/macOS 是 uid 数字字符串
		raw = strings.TrimSpace(u.Uid)
		if raw == "" {
			raw = strings.ToLower(strings.TrimSpace(u.Username))
		}
	} else {
		hostname, _ := os.Hostname()
		raw = strings.ToLower(hostname)
	}
	sum := md5.Sum([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func getOSUserName() string {
	u, err := user.Current()
	if err != nil {
		return "unknown"
	}
	// On Windows, Name field often has the display name
	if u.Name != "" {
		return u.Name
	}
	// Fallback: use login name
	name := u.Username
	// Strip domain prefix (DOMAIN\user or user@domain)
	if i := strings.LastIndex(name, "\\"); i >= 0 {
		name = name[i+1:]
	}
	if i := strings.Index(name, "@"); i >= 0 {
		name = name[:i]
	}
	return name
}
