package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const Version = "2.0.10"

// proxyEnvKeys lists environment variables cleared by --uninstall（含旧版曾写入的 HTTP_PROXY 等）.
var proxyEnvKeys = []string{
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
	"OPENAI_BASE_URL", "OPENAI_API_BASE",
	"ANTHROPIC_BASE_URL",
	"NODE_EXTRA_CA_CERTS",
}

func selfBinaryName() string {
	if runtime.GOOS == "windows" {
		return "ai-monitor.exe"
	}
	return "ai-monitor"
}

func manualCAInstallHint(certPath string) string {
	switch runtime.GOOS {
	case "windows":
		return fmt.Sprintf(`certutil -addstore -user Root "%s"`, certPath)
	case "darwin":
		return fmt.Sprintf(`security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "%s"`, certPath)
	default:
		return fmt.Sprintf("请将 %s 手动导入系统或浏览器信任存储", certPath)
	}
}

func main() {
	install := flag.Bool("install", false, "安装: 默认仅安装 CA，不改系统代理；配合 install_system_proxy=true 或 --install-full 才写系统代理")
	installFull := flag.Bool("install-full", false, "与 --install 合用: 强制系统代理(覆盖 config 中 install_system_proxy=false)")
	installCertOnly := flag.Bool("install-cert-only", false, "与 --install 合用: 仅安装 CA，不改系统代理(与 Proxifier 共存时用)")
	installIDE := flag.Bool("install-ide", false, "与 --install 合用: 强制写入 VS Code/Cursor 的 http.proxy（默认不写，仅用系统代理）")
	launch := flag.Bool("launch", false, "启动本地 MITM，并仅对子进程注入代理环境变量；不修改系统代理或用户环境变量")
	launchPreset := flag.String("launch-preset", "", "按预设启动受管应用，例如 vscode、cursor、powershell、cmd")
	listLaunchPresets := flag.Bool("list-launch-presets", false, "列出可用的受管应用启动预设")
	uninstall := flag.Bool("uninstall", false, "卸载: 移除CA证书, 清除系统代理和环境变量")
	setup := flag.Bool("setup", false, "傻瓜式配置向导：生成 config.json 并安装证书/代理")
	configPath := flag.String("config", "config.json", "配置文件路径")
	flag.Parse()

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════════╗")
	fmt.Println("  ║   AI Token 监控客户端 v" + Version + "              ║")
	fmt.Println("  ║   模式: 本地 MITM（流量须指向本代理）    ║")
	fmt.Println("  ╚══════════════════════════════════════════╝")
	fmt.Println()

	dataDir := filepath.Join(os.Getenv("APPDATA"), "ai-monitor")
	os.MkdirAll(dataDir, 0755)

	certMgr, err := NewCertManager(dataDir)
	if err != nil {
		log.Fatalf("  证书管理初始化失败: %v", err)
	}

	if *uninstall {
		doUninstall(certMgr)
		return
	}

	if *setup {
		if err := runSetupWizard(*configPath, certMgr); err != nil {
			log.Fatalf("  %v", err)
		}
		return
	}

	if *listLaunchPresets {
		printLaunchPresets()
		return
	}

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("  加载配置失败: %v", err)
	}

	bypass := buildProxyBypass()
	noProxy := buildNoProxyEnv()

	if *install {
		proxyAddr := fmt.Sprintf("localhost:%d", cfg.Port)
		full := (*installFull || cfg.EffectiveInstallSystemProxy()) && !*installCertOnly
		patchIDE := *installIDE || cfg.EffectiveInstallIDEProxy()
		doInstall(certMgr, cfg, proxyAddr, bypass, noProxy, full, patchIDE)
		return
	}

	if *launch || strings.TrimSpace(*launchPreset) != "" {
		if err := runManagedProcess(cfg, certMgr, flag.Args(), *launchPreset); err != nil {
			log.Fatalf("  启动目标应用失败: %v", err)
		}
		return
	}

	// ── Normal run ──
	runtime, err := startMonitorRuntime(cfg, certMgr, "")
	if err != nil {
		log.Fatalf("  %v", err)
	}
	if runtime.listenPort != cfg.Port {
		log.Printf("[提示] 配置端口 %d 已被占用，已自动改用 %d（定向启动应用时请指向新端口）", cfg.Port, runtime.listenPort)
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\n  正在关闭...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		runtime.Shutdown(ctx)
	}()

	fmt.Printf("  用户: %s (%s) | 部门: %s\n", cfg.UserName, cfg.UserID, cfg.Department)
	fmt.Printf("  本地 MITM (拦截 AI 流量): %s\n", runtime.proxyAddr)
	fmt.Printf("  Token 上报服务器 (135): %s  →  POST /api/collect 与 /api/clients/heartbeat\n", cfg.ServerURL)
	if strings.TrimSpace(cfg.UpstreamProxy) != "" {
		fmt.Printf("  上游代理透传: %s\n", cfg.UpstreamProxy)
	}
	eh, es := 0, 0
	if cfg.ExtraMonitorHosts != nil {
		eh = len(cfg.ExtraMonitorHosts)
	}
	if cfg.ExtraMonitorSuffixes != nil {
		es = len(cfg.ExtraMonitorSuffixes)
	}
	fmt.Printf("  内置监控: %d 个精确域名 + %d 条通配规则；config 额外: %d 主机 + %d 后缀\n",
		len(aiDomains), len(aiWildcardDomains), eh, es)
	fmt.Printf("  CA 证书: %s\n", certMgr.CACertPath())
	fmt.Println()
	fmt.Println("  说明: 默认不修改系统代理；推荐用 `--launch <程序>` 仅对子进程注入代理环境变量。")
	fmt.Println("        若必须接管整机代理，请显式启用 install_system_proxy=true 或使用 --install-full（legacy 模式）。")
	fmt.Println("        经 MITM 的请求会尽量记录用量（免费额度与付费调用均尝试统计，不按计费类型过滤）；JSON 有 usage 为 [记录]，gRPC 多为 [记录·估算]。")
	fmt.Println("  扩展: config.json 可设 extra_monitor_*；report_opaque_traffic=false 可关闭体积估算。")
	if runtime.gatewayPort > 0 {
		fmt.Printf("  API Gateway (无 MITM): localhost:%d  ← 工具可设 OPENAI_BASE_URL=http://localhost:%d/openai/v1\n", runtime.gatewayPort, runtime.gatewayPort)
	}
	fmt.Println()
	fmt.Println("  等待 AI 请求中... (Ctrl+C 退出)")
	fmt.Println("  " + strings.Repeat("─", 55))

	// Start gateway server on dedicated port (if configured)
	if runtime.gatewayServer != nil {
		go func() {
			if err := runtime.gatewayServer.Serve(runtime.gatewayLn); err != http.ErrServerClosed {
				log.Printf("[gateway] 服务启动失败: %v", err)
			}
		}()
	}

	if err := runtime.server.Serve(runtime.listener); err != http.ErrServerClosed {
		log.Fatalf("  服务器启动失败: %v", err)
	}
	fmt.Println("  已关闭。")
}

func doInstall(certMgr *CertManager, cfg *Config, proxyAddr, bypass, noProxy string, fullSystemProxy, patchIDE bool) {
	httpProxy := "http://" + proxyAddr

	fmt.Println("  [1/4] 安装 CA 证书到用户信任存储...")
	if err := certMgr.InstallCA(); err != nil {
		log.Printf("    ✗ CA 证书安装失败: %v", err)
		fmt.Printf("    手动安装: %s\n", manualCAInstallHint(certMgr.CACertPath()))
	} else {
		fmt.Printf("    ✓ CA 证书已安装: %s\n", certMgr.CACertPath())
	}

	if !fullSystemProxy {
		fmt.Println("  [2/4] 跳过系统代理 / 环境变量 / IDE（默认，不破坏本机原有代理）")
		fmt.Println("    — 未修改系统代理或持久环境变量，可与本机原有网络配置共存。")
		fmt.Printf("    — 推荐用法: %s --launch <你的程序>，仅对子进程注入 HTTP(S)_PROXY 与 Base URL。\n", selfBinaryName())
		fmt.Println("    — 若目标应用已有固定公司代理，可在 config.json 中设置 upstream_proxy 让本地 MITM 外联继续走原代理。")
		if runtime.GOOS == "windows" {
			fmt.Println("    — 若确需整机代理导流，可重新安装并启用 install_system_proxy=true 或执行 --install-full。")
		} else {
			fmt.Println("    — 非 Windows 暂未实现自动整机代理与持久环境变量配置，请优先使用 --launch 模式。")
		}
		fmt.Println()
		fmt.Println("  ══════════════════════════════════════════")
		fmt.Println("  ✓ 安装完成 (仅 CA)")
		fmt.Printf("  运行 %s 启动监控，或用 --launch 定向启动目标应用。\n", selfBinaryName())
		fmt.Printf("  卸载: %s --uninstall\n", selfBinaryName())
		fmt.Println("  ══════════════════════════════════════════")
		return
	}

	fmt.Println("  [2/4] 设置系统代理...")
	if err := EnableSystemProxy(proxyAddr, bypass); err != nil {
		log.Printf("    ✗ 系统代理设置失败: %v", err)
	} else {
		fmt.Printf("    ✓ 系统代理: %s\n", proxyAddr)
	}

	fmt.Println("  [3/4] 设置环境变量（HTTP(S)_PROXY 指向本程序 + NO_PROXY 与系统代理例外一致）...")
	fmt.Println("    — 未列入 NO_PROXY 的域名（如各 AI API）经 Node/CLI 也会走本机 MITM；GitHub/VS Code/CDN 走直连。")
	envVars := map[string]string{
		"HTTP_PROXY":          httpProxy,
		"HTTPS_PROXY":         httpProxy,
		"NO_PROXY":            noProxy,
		"OPENAI_BASE_URL":     httpProxy + "/openai/v1",
		"OPENAI_API_BASE":     httpProxy + "/openai/v1",
		"ANTHROPIC_BASE_URL":  httpProxy + "/anthropic",
		"NODE_EXTRA_CA_CERTS": certMgr.CACertPath(),
	}
	if err := SetEnvProxy(envVars); err != nil {
		log.Printf("    ✗ 环境变量设置失败: %v", err)
	} else {
		fmt.Println("    ✓ 已设置:")
		envOrder := []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL", "NODE_EXTRA_CA_CERTS"}
		for _, k := range envOrder {
			v := envVars[k]
			if k == "NO_PROXY" && len(v) > 120 {
				fmt.Printf("      %s=%s…\n", k, v[:120])
				continue
			}
			fmt.Printf("      %s=%s\n", k, v)
		}
	}

	fmt.Println("  [4/4] IDE 内嵌代理 (VS Code / Cursor)...")
	if patchIDE {
		ideCount := configureIDEProxy(httpProxy, certMgr.CACertPath())
		if ideCount > 0 {
			fmt.Printf("    ✓ 已写入 %d 个 IDE 的 settings.json（config install_ide_proxy=true）\n", ideCount)
		} else {
			fmt.Println("    — 未发现已安装的 IDE")
		}
	} else {
		if runtime.GOOS == "windows" {
			fmt.Println("    — 已跳过（默认）。Electron/VS Code 将使用 Windows 系统代理走 MITM，避免与 IDE 内 http.proxy 重复导致网络异常。")
			fmt.Println("      若某扩展仍不走系统代理，可在 config.json 设 \"install_ide_proxy\": true 后重新执行 --install")
		} else {
			fmt.Println("    — 已跳过。若需要让 VS Code / Cursor 明确走本地 MITM，可在 config.json 设 \"install_ide_proxy\": true 后重新执行 --install")
		}
	}

	fmt.Println()
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println("  ✓ 安装完成!")
	fmt.Println()
	fmt.Println("  注意: 需重新打开终端窗口，环境变量才生效。")
	fmt.Printf("  运行 %s 即可启动监控。\n", selfBinaryName())
	fmt.Println("  Token 记录发往 config.json 中的 server_url（默认 192.168.0.135:8000）。")
	fmt.Printf("  卸载: %s --uninstall\n", selfBinaryName())
	fmt.Println("  ══════════════════════════════════════════")
}

func doUninstall(certMgr *CertManager) {
	fmt.Println("  [1/4] 移除 CA 证书...")
	certMgr.UninstallCA()
	fmt.Println("    ✓ done")

	fmt.Println("  [2/4] 清除系统代理...")
	DisableSystemProxy()
	fmt.Println("    ✓ done")

	fmt.Println("  [3/4] 清除环境变量...")
	ClearEnvProxy(proxyEnvKeys)
	fmt.Println("    ✓ done")

	fmt.Println("  [4/4] 清除 IDE 代理配置...")
	removeIDEProxy()
	fmt.Println("    ✓ done")

	fmt.Println()
	fmt.Println("  ✓ 卸载完成! 重新打开终端窗口和 IDE 使更改生效。")
}
