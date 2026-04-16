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

// Version is set at build time via -ldflags "-X main.Version=..."
// Fallback to "dev" when built without ldflags.
var Version = "dev"

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
	globalInstall := flag.Bool("global-install", false, "全局安装: 安装 CA + 设用户级 HTTP_PROXY 环境变量 + 注册开机自启（推荐，一键覆盖所有开发工具）")
	globalUninstall := flag.Bool("global-uninstall", false, "全局卸载: 移除 CA + 清除环境变量 + 移除开机自启")
	launch := flag.Bool("launch", false, "启动本地 MITM，并仅对子进程注入代理环境变量；不修改系统代理或用户环境变量")
	launchPreset := flag.String("launch-preset", "", "按预设启动受管应用，例如 vscode、cursor、powershell、cmd")
	listLaunchPresets := flag.Bool("list-launch-presets", false, "列出可用的受管应用启动预设")
	uninstall := flag.Bool("uninstall", false, "卸载: 移除CA证书, 清除系统代理和环境变量")
	setup := flag.Bool("setup", false, "傻瓜式配置向导：生成 config.json 并安装证书/代理")
	configPath := flag.String("config", "config.json", "配置文件路径")
	showVersion := flag.Bool("version", false, "显示版本号并退出")
	flag.Parse()

	if *showVersion {
		fmt.Println(Version)
		os.Exit(0)
	}

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════════╗")
	fmt.Printf("  ║   AI Token 监控客户端 %-20s║\n", "v"+Version)
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

	if *globalUninstall {
		doGlobalUninstall(certMgr)
		return
	}

	if *globalInstall {
		cfg, err := LoadConfig(*configPath)
		if err != nil {
			log.Fatalf("  加载配置失败: %v", err)
		}
		doGlobalInstall(certMgr, cfg, *configPath)
		return
	}

	if *setup {
		if err := runSetupWizard(*configPath, certMgr); err != nil {
			log.Fatalf("  %v", err)
		}
		return
	}

	// When no config exists and no explicit flags are given, launch the web wizard automatically.
	// This handles the "double-click ai-monitor.exe" scenario for first-time users.
	if !*install && !*launch && strings.TrimSpace(*launchPreset) == "" && !*listLaunchPresets {
		if _, err := os.Stat(*configPath); os.IsNotExist(err) {
			fmt.Println("  未找到 config.json，正在打开安装向导...")
			if err := runWebWizard(*configPath, certMgr); err != nil {
				log.Fatalf("  安装向导出错: %v", err)
			}
			return
		}
	}

	if *listLaunchPresets {
		printLaunchPresets()
		return
	}

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("  加载配置失败: %v", err)
	}

	bypass := buildProxyBypassWithConfig(cfg)
	noProxy := buildNoProxyEnvWithConfig(cfg)

	if *install {
		// Resolve actual port: reuse running instance or probe available port.
		actualPort := resolveActualPort(cfg)
		proxyAddr := fmt.Sprintf("localhost:%d", actualPort)
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
	// Singleton check: if a healthy instance already exists, don't start a second one.
	existingPort, alive := checkExistingInstance()
	if alive {
		fmt.Printf("  已有 ai-monitor 实例运行于端口 %d，当前进程退出。\n", existingPort)
		fmt.Println("  如需重启，请先终止已有进程。")
		os.Exit(0)
	}
	removeInstanceInfo() // clean up any stale PID file

	runtime, err := startMonitorRuntime(cfg, certMgr, "")
	if err != nil {
		log.Fatalf("  %v", err)
	}
	if err := writeInstanceInfo(runtime.listenPort); err != nil {
		log.Printf("[singleton] 写入 instance.json 失败: %v", err)
	}
	applySessionManagedProxy(cfg, certMgr, runtime.listenPort)
	if runtime.listenPort != cfg.Port {
		log.Printf("[提示] 配置端口 %d 已被占用，已自动改用 %d（定向启动应用时请指向新端口）", cfg.Port, runtime.listenPort)
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\n  正在关闭...")
		removeInstanceInfo()
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
	restoreSessionManagedProxyOnShutdown()
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

	// Detect existing upstream BEFORE overwriting so we can chain through it
	detectedUpstream := detectUpstreamProxy(cfg)
	previousProxy := readCurrentSystemProxy()
	previousEnvVars := snapshotProxyEnvVars()

	if detectedUpstream != "" {
		fmt.Printf("    ℹ 检测到已有代理: %s（将作为上游保留）\n", detectedUpstream)
		if strings.TrimSpace(cfg.UpstreamProxy) == "" {
			cfg.UpstreamProxy = detectedUpstream
			// Best-effort write to config file
			patchConfigUpstreamProxy(filepath.Join(filepath.Dir(os.Args[0]), "config.json"), detectedUpstream)
		}
	}

	saveInstallState(&InstallState{
		SystemProxySet:        true,
		PreviousProxyAddr:     previousProxy,
		PreviousProxyEnabled:  previousProxy != "",
		IDESettingsPatched:    patchIDE,
		PreviousUpstreamProxy: detectedUpstream,
		PreviousEnvVars:       previousEnvVars,
	})

	fmt.Println("  [2/4] 设置系统代理...")
	if previousProxy != "" {
		fmt.Printf("    ℹ 检测到现有系统代理: %s（已备份，卸载时将恢复）\n", previousProxy)
	}
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
	state := loadInstallState()

	fmt.Println("  [1/4] 移除 CA 证书...")
	certMgr.UninstallCA()
	fmt.Println("    ✓ done")

	fmt.Println("  [2/4] 清除系统代理...")
	restoreWinInetProxyFromState(state)
	fmt.Println("    ✓ done")

	fmt.Println("  [3/4] 恢复环境变量...")
	restoreOrClearEnvVars(state)
	fmt.Println("    ✓ done")

	fmt.Println("  [4/4] 清除 IDE 代理配置...")
	removeIDEProxy()
	fmt.Println("    ✓ done")

	// Clean up state files
	clearInstallState()
	removeInstanceInfo()

	fmt.Println()
	fmt.Println("  ✓ 卸载完成! 重新打开终端窗口和 IDE 使更改生效。")
}

func doGlobalInstall(certMgr *CertManager, cfg *Config, configPath string) {
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println("  全局安装模式")
	fmt.Println("  效果: 所有新启动的开发工具自动走 ai-monitor 监控")
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println()

	actualPort := resolveActualPort(cfg)
	proxyAddr := fmt.Sprintf("localhost:%d", actualPort)
	httpProxy := "http://" + proxyAddr

	// ── Step 0: Detect existing upstream proxy BEFORE overwriting anything ──
	// This is critical: once we overwrite system proxy and env vars, we can
	// no longer distinguish the user's original proxy from our own.
	detectedUpstream := detectUpstreamProxy(cfg)
	previousSysProxy := readCurrentSystemProxy()
	previousEnvVars := snapshotProxyEnvVars()

	if detectedUpstream != "" {
		fmt.Printf("  ℹ 检测到已有代理: %s\n", detectedUpstream)
		fmt.Println("    ai-monitor 将作为中间层，非 AI 流量继续走原代理，不影响外网访问")
		fmt.Println()
	}

	// Auto-persist detected upstream into config so runtime always finds it
	if detectedUpstream != "" && strings.TrimSpace(cfg.UpstreamProxy) == "" {
		cfg.UpstreamProxy = detectedUpstream
		if err := patchConfigUpstreamProxy(configPath, detectedUpstream); err != nil {
			log.Printf("    ⚠ 写入 upstream_proxy 到 config.json 失败: %v", err)
		} else {
			fmt.Printf("    ✓ 已将上游代理写入 config.json: upstream_proxy=%s\n", detectedUpstream)
		}
	}

	// Step 1: Install CA certificate
	fmt.Println("  [1/4] 安装 CA 证书到用户信任存储...")
	if err := certMgr.InstallCA(); err != nil {
		log.Printf("    ✗ CA 证书安装失败: %v", err)
		fmt.Printf("    手动安装: %s\n", manualCAInstallHint(certMgr.CACertPath()))
	} else {
		fmt.Printf("    ✓ CA 证书已安装: %s\n", certMgr.CACertPath())
	}

	// Step 2: Set user-level environment variables
	fmt.Println("  [2/4] 设置用户级环境变量...")
	noProxy := buildNoProxyEnvWithConfig(cfg)
	envVars := map[string]string{
		"HTTP_PROXY":          httpProxy,
		"HTTPS_PROXY":         httpProxy,
		"NO_PROXY":            noProxy,
		"NODE_EXTRA_CA_CERTS": certMgr.CACertPath(),
	}
	if err := SetEnvProxy(envVars); err != nil {
		log.Printf("    ✗ 环境变量设置失败: %v", err)
	} else {
		fmt.Println("    ✓ 已设置 HTTP_PROXY / HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS")
		fmt.Println("      → VS Code/Cursor/JetBrains/Claude Code/Aider/Codex 等 CLI 工具自动走监控")
	}

	// Step 3: Set Windows system proxy via PAC (with DIRECT fallback for crash safety)
	fmt.Println("  [3/4] 设置 Windows 系统代理（PAC + DIRECT 回退）...")
	previousAutoConfigURL := ReadCurrentAutoConfigURL()
	if previousSysProxy != "" && !isSelfProxy(previousSysProxy) {
		fmt.Printf("    ℹ 检测到现有系统代理: %s（已备份，卸载时将恢复）\n", previousSysProxy)
	}
	if previousAutoConfigURL != "" {
		fmt.Printf("    ℹ 检测到现有 PAC: %s（已备份，卸载时将恢复）\n", previousAutoConfigURL)
	}
	pacURL, err := writePACFile(actualPort, cfg)
	if err != nil {
		log.Printf("    ✗ PAC 文件生成失败: %v", err)
	} else {
		fmt.Printf("    ✓ PAC 文件: %s\n", pacFilePath())
	}
	saveInstallState(&InstallState{
		SystemProxySet:        true,
		PreviousProxyAddr:     previousSysProxy,
		PreviousProxyEnabled:  previousSysProxy != "" && !isSelfProxy(previousSysProxy),
		PreviousUpstreamProxy: detectedUpstream,
		PreviousEnvVars:       previousEnvVars,
		PACFileSet:            true,
		PACFilePath:           pacFilePath(),
		PreviousAutoConfigURL: previousAutoConfigURL,
	})
	if err := EnableSystemProxyPAC(pacURL); err != nil {
		log.Printf("    ✗ 系统代理 (PAC) 设置失败: %v", err)
		fmt.Println("      Visual Studio 中的 GitHub Copilot 可能无法被监控")
	} else {
		fmt.Printf("    ✓ 系统代理 (PAC): %s\n", pacURL)
		fmt.Println("      → 浏览器 / Visual Studio / .NET 应用自动走监控")
		fmt.Println("      → MITM 异常时自动回退直连，不影响上网（无需看门狗）")
	}

	// Step 4: Register auto-start
	fmt.Println("  [4/4] 注册开机自启...")
	if err := installAutoStart(configPath); err != nil {
		log.Printf("    ✗ 注册失败: %v", err)
		fmt.Println("    可手动将 ai-monitor.exe 快捷方式放入「启动」文件夹")
	} else {
		fmt.Println("    ✓ 已注册: 每次登录自动在后台启动 ai-monitor")
	}

	// Start background instance now if not already running
	if _, alive := checkExistingInstance(); !alive {
		fmt.Println()
		fmt.Println("  正在启动后台服务...")
		if err := startBackgroundInstance(configPath); err != nil {
			log.Printf("    ✗ 后台启动失败: %v", err)
			fmt.Println("    请手动运行 ai-monitor.exe")
		} else {
			fmt.Println("    ✓ ai-monitor 已在后台运行")
		}
	} else {
		fmt.Println()
		fmt.Println("  ✓ ai-monitor 已在运行中")
	}

	fmt.Println()
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println("  ✓ 全局安装完成!")
	fmt.Println()
	fmt.Println("  覆盖范围:")
	fmt.Println("    ✓ VS Code / Cursor / Windsurf / Kiro / Trae  (环境变量)")
	fmt.Println("    ✓ JetBrains IDEA / WebStorm / PyCharm / GoLand  (环境变量)")
	fmt.Println("    ✓ Visual Studio 2022 + GitHub Copilot  (系统代理)")
	fmt.Println("    ✓ Claude Code / Codex / Aider / OpenCode 等 CLI  (环境变量)")
	if detectedUpstream != "" {
		fmt.Println()
		fmt.Printf("  代理兼容: 已有代理 %s 保留为上游，外网访问不受影响\n", detectedUpstream)
	}
	fmt.Println()
	fmt.Println("  重要: 需重新打开终端窗口和 IDE，环境变量才对新进程生效。")
	fmt.Println("  已打开的程序不受影响，关闭后再打开即可。")
	fmt.Printf("  卸载: %s --global-uninstall\n", selfBinaryName())
	fmt.Println("  ══════════════════════════════════════════")
}

func doGlobalUninstall(certMgr *CertManager) {
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println("  全局卸载")
	fmt.Println("  ══════════════════════════════════════════")
	fmt.Println()

	state := loadInstallState()

	fmt.Println("  [1/4] 移除 CA 证书...")
	certMgr.UninstallCA()
	fmt.Println("    ✓ done")

	fmt.Println("  [2/4] 恢复用户级环境变量...")
	restoreOrClearEnvVars(state)
	fmt.Println("    ✓ done")

	fmt.Println("  [3/4] 恢复系统代理...")
	restoreProxyFromState(state)
	fmt.Println("    ✓ done")

	fmt.Println("  [4/4] 移除计划任务（开机自启 + 旧看门狗清理）...")
	if err := uninstallAutoStart(); err != nil {
		log.Printf("    ⚠ 开机自启: %v", err)
	} else {
		fmt.Println("    ✓ 已移除开机自启")
	}
	// Clean up watchdog task from previous installs (before PAC migration)
	if err := uninstallWatchdogTask(); err != nil {
		log.Printf("    ⚠ 看门狗: %v", err)
	} else {
		fmt.Println("    ✓ 已移除看门狗（如有）")
	}

	clearInstallState()
	removeInstanceInfo()

	fmt.Println()
	fmt.Println("  ✓ 全局卸载完成! 重新打开终端窗口和 IDE 使更改生效。")
}

// restoreOrClearEnvVars restores previously saved environment variables, or
// clears ai-monitor's env vars if no previous state was saved.
func restoreOrClearEnvVars(state *InstallState) {
	keysToManage := []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"}

	if state != nil && len(state.PreviousEnvVars) > 0 {
		// Restore previous values for keys that had values before install
		restored := make(map[string]string)
		for _, key := range keysToManage {
			if prev, ok := state.PreviousEnvVars[key]; ok && prev != "" {
				restored[key] = prev
			}
		}
		// Also check lowercase variants
		for _, key := range []string{"http_proxy", "https_proxy", "no_proxy"} {
			if prev, ok := state.PreviousEnvVars[key]; ok && prev != "" {
				restored[key] = prev
			}
		}

		if len(restored) > 0 {
			fmt.Println("    ℹ 恢复之前的环境变量:")
			if err := SetEnvProxy(restored); err != nil {
				log.Printf("    ⚠ 恢复环境变量失败: %v", err)
			} else {
				for k, v := range restored {
					fmt.Printf("      %s=%s\n", k, v)
				}
			}
		}

		// Clear keys that had no previous value (were set by ai-monitor for the first time)
		var toClear []string
		for _, key := range keysToManage {
			if _, ok := state.PreviousEnvVars[key]; !ok {
				toClear = append(toClear, key)
			}
		}
		if len(toClear) > 0 {
			ClearEnvProxy(toClear)
		}
	} else {
		ClearEnvProxy(keysToManage)
	}
}

// restoreWinInetProxyFromState restores the user's previous WinINet proxy or disables it.
func restoreWinInetProxyFromState(state *InstallState) {
	if state != nil && state.PreviousProxyEnabled && state.PreviousProxyAddr != "" {
		fmt.Printf("    ℹ 恢复之前的系统代理: %s\n", state.PreviousProxyAddr)
		if err := EnableSystemProxy(state.PreviousProxyAddr, ""); err != nil {
			log.Printf("    ⚠ 恢复系统代理失败: %v", err)
		}
	} else {
		DisableSystemProxy()
	}
}

// applySessionManagedProxy re-applies system proxy and user env vars when install_state
// records a global / full install (SystemProxySet). Called each time the MITM process starts
// so that after a prior graceful shutdown cleared env vars, the next run configures them again.
// For PAC-based installs, regenerates the PAC file with the current listen port.
func applySessionManagedProxy(cfg *Config, certMgr *CertManager, listenPort int) {
	if runtime.GOOS != "windows" {
		return
	}
	st := loadInstallState()
	if st == nil || !st.SystemProxySet {
		return
	}
	proxyAddr := fmt.Sprintf("localhost:%d", listenPort)
	httpProxy := "http://" + proxyAddr
	noProxy := buildNoProxyEnvWithConfig(cfg)
	envVars := map[string]string{
		"HTTP_PROXY":          httpProxy,
		"HTTPS_PROXY":         httpProxy,
		"NO_PROXY":            noProxy,
		"NODE_EXTRA_CA_CERTS": certMgr.CACertPath(),
	}

	if st.PACFileSet {
		// PAC mode: regenerate PAC file with current port (may have changed)
		pacURL, err := writePACFile(listenPort, cfg)
		if err != nil {
			log.Printf("[session] PAC 文件重新生成失败: %v", err)
		} else {
			// Re-set AutoConfigURL to prompt WinINet to re-read the PAC file
			if err := EnableSystemProxyPAC(pacURL); err != nil {
				log.Printf("[session] 启用 PAC 代理失败: %v", err)
			} else {
				fmt.Printf("  [会话] 已更新 PAC 代理 (端口 %d)\n", listenPort)
			}
		}
	} else {
		// Legacy (pre-PAC) install: use hardcoded ProxyServer
		bypass := buildProxyBypassWithConfig(cfg)
		if err := EnableSystemProxy(proxyAddr, bypass); err != nil {
			log.Printf("[session] 启用系统代理失败: %v", err)
		} else {
			fmt.Printf("  [会话] 已启用系统代理 %s\n", proxyAddr)
		}
	}

	if err := SetEnvProxy(envVars); err != nil {
		log.Printf("[session] 设置用户环境变量失败: %v", err)
	} else {
		fmt.Println("  [会话] 已同步用户级 HTTP(S)_PROXY")
	}
}

// restoreSessionManagedProxyOnShutdown runs after the MITM server stops. When install_state
// records SystemProxySet, restores environment variables so new terminals don't point at a dead proxy.
// For PAC-based installs, the system proxy is NOT touched — the PAC file's DIRECT fallback
// handles the dead MITM gracefully, so browsers continue working immediately.
func restoreSessionManagedProxyOnShutdown() {
	if runtime.GOOS != "windows" {
		return
	}
	st := loadInstallState()
	if st == nil || !st.SystemProxySet {
		return
	}

	if st.PACFileSet {
		// PAC mode: leave AutoConfigURL in place (DIRECT fallback keeps network alive).
		// Only restore env vars so new terminals don't try the dead proxy.
		fmt.Println("\n  [会话] 正在恢复用户环境变量…（PAC 代理保持，MITM 下线后自动直连）")
		restoreOrClearEnvVars(st)
		fmt.Println("  [会话] 已恢复环境变量。下次启动 ai-monitor 将自动恢复监控。")
	} else {
		// Legacy (pre-PAC) mode: restore everything
		fmt.Println("\n  [会话] 正在恢复系统代理与用户环境变量…")
		restoreWinInetProxyFromState(st)
		restoreOrClearEnvVars(st)
		fmt.Println("  [会话] 已恢复。请重新打开终端/IDE 使环境变量生效。")
	}
}

// restoreProxyFromState undoes what doGlobalInstall set up: removes PAC file,
// clears AutoConfigURL, and restores the user's previous proxy configuration.
func restoreProxyFromState(state *InstallState) {
	if state != nil && state.PACFileSet {
		// PAC-based install: clean up PAC file and registry
		removePACFile()
		DisableSystemProxyPAC()
		// Restore previous AutoConfigURL if user had one before our install
		if state.PreviousAutoConfigURL != "" {
			fmt.Printf("    ℹ 恢复之前的 PAC: %s\n", state.PreviousAutoConfigURL)
			if err := EnableSystemProxyPAC(state.PreviousAutoConfigURL); err != nil {
				log.Printf("    ⚠ 恢复 PAC 失败: %v", err)
			}
		} else if state.PreviousProxyEnabled && state.PreviousProxyAddr != "" {
			// User had a manual proxy before our install
			fmt.Printf("    ℹ 恢复之前的系统代理: %s\n", state.PreviousProxyAddr)
			if err := EnableSystemProxy(state.PreviousProxyAddr, ""); err != nil {
				log.Printf("    ⚠ 恢复系统代理失败: %v", err)
			}
		}
	} else {
		// Legacy (pre-PAC) install: use old restore logic
		restoreWinInetProxyFromState(state)
	}
}

// resolveActualPort determines the port that IDE settings should point to.
// If a running instance exists, use its port. Otherwise probe to find the
// port that would actually be bound.
func resolveActualPort(cfg *Config) int {
	// Check if an existing instance is running
	if port, alive := checkExistingInstance(); alive {
		log.Printf("[install] 检测到已运行的 ai-monitor 实例，使用端口 %d", port)
		return port
	}

	// No running instance — probe which port would be bound
	ln, port, err := tryListenMitmPort(cfg.Port)
	if err != nil {
		log.Printf("[install] 端口探测失败: %v，使用配置端口 %d", err, cfg.Port)
		return cfg.Port
	}
	ln.Close()
	return port
}
