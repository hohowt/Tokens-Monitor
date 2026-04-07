package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// runSetupWizard 交互式生成 config.json 并执行 doInstall（默认仅证书，不改系统代理）。
func runSetupWizard(configPath string, certMgr *CertManager) error {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════════╗")
	fmt.Println("  ║   首次配置向导（多数项可直接回车）        ║")
	fmt.Println("  ╚══════════════════════════════════════════╝")
	fmt.Println()

	if _, err := os.Stat(configPath); err == nil {
		fmt.Print("  已存在 config.json，覆盖并重新安装？(y/N): ")
		text, _ := reader.ReadString('\n')
		if strings.TrimSpace(strings.ToLower(text)) != "y" {
			fmt.Println("  已取消（未修改任何文件）。")
			return nil
		}
		fmt.Println()
	}

	cfg := &Config{
		Port:       18090,
		ServerURL:  DefaultServerURL,
		UserID:     generateUserID(),
		UserName:   getOSUserName(),
		Department: "",
	}

	fmt.Printf("  上报服务器 [%s]: ", cfg.ServerURL)
	if s, _ := reader.ReadString('\n'); strings.TrimSpace(s) != "" {
		cfg.ServerURL = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(s), "/"))
	}
	if cfg.ServerURL == "" {
		cfg.ServerURL = DefaultServerURL
	}
	if err := validateServerURL(cfg.ServerURL); err != nil {
		return fmt.Errorf("server_url 无效: %w", err)
	}

	fmt.Printf("  您的姓名 [%s]: ", cfg.UserName)
	if s, _ := reader.ReadString('\n'); strings.TrimSpace(s) != "" {
		cfg.UserName = strings.TrimSpace(s)
	}

	fmt.Printf("  部门（可空）: ")
	if s, _ := reader.ReadString('\n'); strings.TrimSpace(s) != "" {
		cfg.Department = strings.TrimSpace(s)
	}

	fmt.Printf("  本地监听端口 [%d]: ", cfg.Port)
	if s, _ := reader.ReadString('\n'); strings.TrimSpace(s) != "" {
		p := strings.TrimSpace(s)
		if port, err := strconv.Atoi(p); err == nil && port > 0 && port <= 65535 {
			cfg.Port = port
		} else {
			fmt.Println("  （输入无效，保留默认端口）")
		}
	}

	fmt.Printf("  上游代理（可空，如 socks5://127.0.0.1:7890）: ")
	if s, _ := reader.ReadString('\n'); strings.TrimSpace(s) != "" {
		cfg.UpstreamProxy = strings.TrimSpace(s)
		if err := validateUpstreamProxyURL(cfg.UpstreamProxy); err != nil {
			return err
		}
	}

	fmt.Println()
	fmt.Println("  ── 如何让 AI 流量经过本程序？──")
	fmt.Println("  [1] 推荐：仅安装证书，不改系统代理；后续用 --launch 只启动受管应用")
	fmt.Println("  [2] legacy：自动设置 Windows 系统代理（会影响整机网络）")
	fmt.Print("  请选择 1 或 2 [1]: ")
	choice, _ := reader.ReadString('\n')
	choice = strings.TrimSpace(choice)
	switch choice {
	case "", "1":
		f := false
		cfg.InstallSystemProxy = &f
		fmt.Println("  → 已选：非侵入式模式（推荐）")
		fmt.Println("  → 后续请用 ai-monitor.exe --launch <你的程序> 启动受管应用；不会改系统代理。")
	case "2":
		t := true
		cfg.InstallSystemProxy = &t
		fmt.Println("  → 已选：系统代理（legacy，仅在确需整机导流时使用）")
	default:
		f := false
		cfg.InstallSystemProxy = &f
		fmt.Println("  → 输入无效，按推荐处理：非侵入式模式")
	}

	f := false
	cfg.InstallIDEProxy = &f

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("保存配置失败: %v", err)
	}
	fmt.Printf("\n  ✓ 已保存 %s\n\n", configPath)

	bypass := buildProxyBypass()
	noProxy := buildNoProxyEnv()
	proxyAddr := fmt.Sprintf("localhost:%d", cfg.Port)
	full := cfg.EffectiveInstallSystemProxy()
	patchIDE := cfg.EffectiveInstallIDEProxy()

	doInstall(certMgr, cfg, proxyAddr, bypass, noProxy, full, patchIDE)

	fmt.Println()
	fmt.Println("  向导已完成。接下来请保持本窗口运行。")
	fmt.Println("  推荐启动方式：ai-monitor.exe --launch <你的程序>，只影响该程序，不改本机网络。")
	fmt.Println("  （若选了系统代理：关机再开请先运行监控，否则部分网络可能暂时不可用）")
	fmt.Println("  说明: 免费与付费 AI 调用只要经过本代理且可解析或估算，都会尽量上报，不因是否扣费而区分。")
	return nil
}
