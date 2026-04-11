package main

import (
	"encoding/csv"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var percentEnvPattern = regexp.MustCompile(`%([^%]+)%`)

type launchPreset struct {
	Name        string
	Description string
	Candidates  []string
	Args        []string
	KnownPaths  []string
}

var managedLaunchPresets = []launchPreset{
	{
		Name:        "vscode",
		Description: "启动 VS Code（仅当前进程走本地 MITM）",
		Candidates:  []string{"code.cmd", "code.exe", "code"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
			"%PROGRAMFILES%\\Microsoft VS Code\\Code.exe",
			"%PROGRAMFILES(X86)%\\Microsoft VS Code\\Code.exe",
		},
	},
	{
		Name:        "cursor",
		Description: "启动 Cursor（仅当前进程走本地 MITM）",
		Candidates:  []string{"cursor.exe", "cursor.cmd", "cursor"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe",
			"%PROGRAMFILES%\\Cursor\\Cursor.exe",
			"%PROGRAMFILES(X86)%\\Cursor\\Cursor.exe",
		},
	},
	{
		Name:        "windsurf",
		Description: "启动 Windsurf",
		Candidates:  []string{"windsurf.exe", "windsurf.cmd", "windsurf"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe",
		},
	},
	{
		Name:        "kiro",
		Description: "启动 Kiro",
		Candidates:  []string{"kiro.exe", "kiro.cmd", "kiro"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe",
		},
	},
	{
		Name:        "vscodium",
		Description: "启动 VS Codium",
		Candidates:  []string{"codium.cmd", "codium.exe", "codium"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe",
			"%PROGRAMFILES%\\VSCodium\\VSCodium.exe",
		},
	},
	{
		Name:        "trae",
		Description: "启动 Trae",
		Candidates:  []string{"trae.exe", "trae.cmd", "trae"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Trae\\Trae.exe",
		},
	},
	{
		Name:        "zed",
		Description: "启动 Zed 编辑器",
		Candidates:  []string{"zed.exe", "zed"},
		KnownPaths: []string{
			"%LOCALAPPDATA%\\Programs\\Zed\\zed.exe",
		},
	},
	{
		Name:        "idea",
		Description: "启动 IntelliJ IDEA",
		Candidates:  []string{"idea64.exe", "idea.cmd", "idea"},
		KnownPaths: []string{
			"%PROGRAMFILES%\\JetBrains\\IntelliJ IDEA *\\bin\\idea64.exe",
		},
	},
	{
		Name:        "webstorm",
		Description: "启动 WebStorm",
		Candidates:  []string{"webstorm64.exe", "webstorm.cmd", "webstorm"},
		KnownPaths: []string{
			"%PROGRAMFILES%\\JetBrains\\WebStorm *\\bin\\webstorm64.exe",
		},
	},
	{
		Name:        "pycharm",
		Description: "启动 PyCharm",
		Candidates:  []string{"pycharm64.exe", "pycharm.cmd", "pycharm"},
		KnownPaths: []string{
			"%PROGRAMFILES%\\JetBrains\\PyCharm *\\bin\\pycharm64.exe",
		},
	},
	{
		Name:        "goland",
		Description: "启动 GoLand",
		Candidates:  []string{"goland64.exe", "goland.cmd", "goland"},
		KnownPaths: []string{
			"%PROGRAMFILES%\\JetBrains\\GoLand *\\bin\\goland64.exe",
		},
	},
	{
		Name:        "powershell",
		Description: "启动 PowerShell 终端（适合再在里面运行 CLI 工具）",
		Candidates:  []string{"pwsh.exe", "powershell.exe"},
		KnownPaths: []string{
			"%PROGRAMFILES%\\PowerShell\\7\\pwsh.exe",
			"%PROGRAMFILES(X86)%\\PowerShell\\7\\pwsh.exe",
			"%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		},
	},
	{
		Name:        "cmd",
		Description: "启动 CMD 终端（适合再在里面运行 CLI 工具）",
		Candidates:  []string{"cmd.exe"},
		KnownPaths:  []string{"%SYSTEMROOT%\\System32\\cmd.exe"},
	},
}

type monitorRuntime struct {
	reporter      *Reporter
	server        *http.Server
	listener      net.Listener
	proxyAddr     string
	listenPort    int
	gatewayServer *http.Server   // nil if gateway_port not configured
	gatewayLn     net.Listener   // nil if gateway_port not configured
	gatewayPort   int
}

func startMonitorRuntime(cfg *Config, certMgr *CertManager, sourceApp string) (*monitorRuntime, error) {
	reporter := NewReporter(cfg)
	reporter.sourceApp = sourceApp
	go reporter.Start()

	ctxPing, cancelPing := context.WithTimeout(context.Background(), 6*time.Second)
	go func() {
		defer cancelPing()
		if err := reporter.PingServer(ctxPing); err != nil {
			log.Printf("[启动] 探测上报服务器 /health 失败: %v（心跳与上报将自动重试）", err)
		} else {
			log.Printf("[启动] 上报服务器 %s 可达", cfg.ServerURL)
		}
	}()

	proxy := NewProxyServer(cfg, reporter, certMgr)
	ln, listenPort, err := tryListenMitmPort(cfg.Port)
	if err != nil {
		return nil, err
	}
	proxy.listenPort = listenPort

	rt := &monitorRuntime{
		reporter: reporter,
		server: &http.Server{
			Handler:           proxy,
			ReadHeaderTimeout: 30 * time.Second,
			ReadTimeout:       0,
			WriteTimeout:      0,
			IdleTimeout:       120 * time.Second,
		},
		listener:   ln,
		proxyAddr:  fmt.Sprintf("localhost:%d", listenPort),
		listenPort: listenPort,
	}

	// Start dedicated gateway port if configured (no MITM, no cert needed).
	if cfg.GatewayPort > 0 && cfg.GatewayPort != cfg.Port {
		gwHandler := newGatewayOnlyHandler(proxy)
		gwLn, gwPort, err := tryListenMitmPort(cfg.GatewayPort)
		if err != nil {
			log.Printf("[gateway] 无法监听端口 %d: %v（Gateway 路由在主端口 %d 仍可用）", cfg.GatewayPort, err, listenPort)
		} else {
			rt.gatewayServer = &http.Server{
				Handler:           gwHandler,
				ReadHeaderTimeout: 30 * time.Second,
				IdleTimeout:       120 * time.Second,
			}
			rt.gatewayLn = gwLn
			rt.gatewayPort = gwPort
			log.Printf("[gateway] API Gateway 监听端口 %d（无 MITM）", gwPort)
		}
	}

	return rt, nil
}

func (m *monitorRuntime) Shutdown(ctx context.Context) error {
	m.reporter.Flush()
	if m.gatewayServer != nil {
		m.gatewayServer.Shutdown(ctx)
	}
	return m.server.Shutdown(ctx)
}

func runManagedProcess(cfg *Config, certMgr *CertManager, args []string, presetName string) error {
	commandArgs, preset, err := resolveLaunchCommand(args, presetName, exec.LookPath)
	if err != nil {
		return err
	}
	if err := ensureManagedPresetProcessNotRunning(preset); err != nil {
		return err
	}

	// Singleton check for launch mode: if a healthy instance is already running, reuse it
	// instead of starting another one. We still launch the child process but skip starting a new proxy.
	existingPort, alive := checkExistingInstance()
	if alive {
		log.Printf("[launch] 检测到已运行的 ai-monitor 实例 (端口 %d)，复用已有实例", existingPort)
		return launchChildWithExistingProxy(cfg, certMgr, commandArgs, preset, existingPort)
	}
	removeInstanceInfo()

	if err := certMgr.InstallCA(); err != nil {
		log.Printf("[launch] 安装 CA 失败，请手动信任 %s: %v", certMgr.CACertPath(), err)
	} else {
		log.Printf("[launch] 已确保 CA 证书安装到当前用户信任存储")
	}

	sourceApp := inferSourceApp(commandArgs, preset)
	runtime, err := startMonitorRuntime(cfg, certMgr, sourceApp)
	if err != nil {
		return err
	}
	if err := writeInstanceInfo(runtime.listenPort); err != nil {
		log.Printf("[launch] 写入 instance.json 失败: %v", err)
	}
	go func() {
		if err := runtime.server.Serve(runtime.listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[launch] 本地 MITM 退出: %v", err)
		}
	}()

	httpProxy := "http://" + runtime.proxyAddr
	envVars := map[string]string{
		"HTTP_PROXY":             httpProxy,
		"HTTPS_PROXY":            httpProxy,
		"NO_PROXY":               buildNoProxyEnvWithConfig(cfg),
		"OPENAI_BASE_URL":        httpProxy + "/openai/v1",
		"OPENAI_API_BASE":        httpProxy + "/openai/v1",
		"ANTHROPIC_BASE_URL":     httpProxy + "/anthropic",
		"AI_MONITOR_LAUNCH_MODE": "managed-process",
		"AI_MONITOR_SOURCE_APP":  sourceApp,
		"NODE_EXTRA_CA_CERTS":    certMgr.CACertPath(),
	}
	if preset != nil {
		envVars["AI_MONITOR_LAUNCH_PRESET"] = preset.Name
	}

	cmd := exec.Command(commandArgs[0], commandArgs[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = mergeEnv(os.Environ(), envVars)

	if preset != nil {
		log.Printf("[launch] 使用预设 %q 启动受管应用: %s", preset.Name, strings.Join(commandArgs, " "))
	} else {
		log.Printf("[launch] 仅对目标进程注入代理环境变量: %s", strings.Join(commandArgs, " "))
	}
	err = cmd.Run()
	removeInstanceInfo()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := runtime.Shutdown(ctx)
	if err != nil {
		return err
	}
	return shutdownErr
}

// launchChildWithExistingProxy launches the target process pointing at an already-running
// ai-monitor instance. No new proxy is started.
func launchChildWithExistingProxy(cfg *Config, certMgr *CertManager, commandArgs []string, preset *launchPreset, port int) error {
	sourceApp := inferSourceApp(commandArgs, preset)
	httpProxy := fmt.Sprintf("http://localhost:%d", port)
	envVars := map[string]string{
		"HTTP_PROXY":             httpProxy,
		"HTTPS_PROXY":            httpProxy,
		"NO_PROXY":               buildNoProxyEnvWithConfig(cfg),
		"OPENAI_BASE_URL":        httpProxy + "/openai/v1",
		"OPENAI_API_BASE":        httpProxy + "/openai/v1",
		"ANTHROPIC_BASE_URL":     httpProxy + "/anthropic",
		"AI_MONITOR_LAUNCH_MODE": "managed-process",
		"AI_MONITOR_SOURCE_APP":  sourceApp,
		"NODE_EXTRA_CA_CERTS":    certMgr.CACertPath(),
	}
	if preset != nil {
		envVars["AI_MONITOR_LAUNCH_PRESET"] = preset.Name
	}

	cmd := exec.Command(commandArgs[0], commandArgs[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = mergeEnv(os.Environ(), envVars)

	log.Printf("[launch] 复用已有代理 (localhost:%d)，启动: %s", port, strings.Join(commandArgs, " "))
	return cmd.Run()
}

func inferSourceApp(commandArgs []string, preset *launchPreset) string {
	if preset != nil && strings.TrimSpace(preset.Name) != "" {
		return preset.Name
	}
	if len(commandArgs) == 0 {
		return ""
	}
	base := strings.ToLower(filepath.Base(commandArgs[0]))
	for _, ext := range []string{".exe", ".cmd", ".bat"} {
		base = strings.TrimSuffix(base, ext)
	}
	switch base {
	case "code", "vscode":
		return "vscode"
	case "cursor":
		return "cursor"
	case "windsurf":
		return "windsurf"
	case "kiro":
		return "kiro"
	case "codium", "vscodium":
		return "vscodium"
	case "trae":
		return "trae"
	case "zed":
		return "zed"
	case "idea", "idea64":
		return "jetbrains"
	case "webstorm", "webstorm64":
		return "jetbrains"
	case "pycharm", "pycharm64":
		return "jetbrains"
	case "goland", "goland64":
		return "jetbrains"
	case "pwsh", "powershell":
		return "powershell"
	case "cmd":
		return "cmd"
	default:
		return base
	}
}

func resolveLaunchCommand(args []string, presetName string, lookPath func(string) (string, error)) ([]string, *launchPreset, error) {
	presetName = strings.TrimSpace(strings.ToLower(presetName))
	if presetName == "" {
		if len(args) == 0 {
			return nil, nil, fmt.Errorf("--launch 后需要提供目标程序，例如: ai-monitor.exe --launch code.cmd；或使用 --launch-preset vscode")
		}
		return args, nil, nil
	}

	preset := findLaunchPreset(presetName)
	if preset == nil {
		return nil, nil, fmt.Errorf("未知 launch 预设 %q，可先执行 --list-launch-presets 查看", presetName)
	}

	resolved, candidate, err := resolvePresetBinary(*preset, lookPath, fileExists)
	if err != nil {
		return nil, nil, fmt.Errorf("launch 预设 %q 未找到可执行文件（尝试过: %s）", preset.Name, strings.Join(candidate, ", "))
	}

	command := []string{resolved}
	command = append(command, preset.Args...)
	command = append(command, args...)
	return command, preset, nil
}

func findLaunchPreset(name string) *launchPreset {
	for idx := range managedLaunchPresets {
		preset := &managedLaunchPresets[idx]
		if preset.Name == name {
			return preset
		}
	}
	return nil
}

func ensureManagedPresetProcessNotRunning(preset *launchPreset) error {
	imageName, displayName := managedPresetProcessImage(preset)
	if imageName == "" {
		return nil
	}
	running, err := isProcessImageRunning(imageName)
	if err != nil {
		log.Printf("[launch] 检查现有 %s 进程失败，跳过预检查: %v", displayName, err)
		return nil
	}
	if running {
		return fmt.Errorf("检测到已运行的 %s 进程。请先彻底退出现有 %s（包括后台残留窗口），再使用启动器重新打开，否则会复用旧实例，导致监控不生效", displayName, displayName)
	}
	return nil
}

func managedPresetProcessImage(preset *launchPreset) (imageName, displayName string) {
	if preset == nil {
		return "", ""
	}
	switch strings.ToLower(strings.TrimSpace(preset.Name)) {
	case "vscode":
		return "Code.exe", "VS Code"
	case "cursor":
		return "Cursor.exe", "Cursor"
	case "windsurf":
		return "Windsurf.exe", "Windsurf"
	case "kiro":
		return "Kiro.exe", "Kiro"
	case "vscodium":
		return "VSCodium.exe", "VS Codium"
	case "trae":
		return "Trae.exe", "Trae"
	default:
		return "", ""
	}
}

func isProcessImageRunning(imageName string) (bool, error) {
	if strings.TrimSpace(imageName) == "" {
		return false, nil
	}
	if runtime.GOOS != "windows" {
		return false, nil
	}
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("IMAGENAME eq %s", imageName), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false, err
	}
	text := strings.TrimSpace(string(out))
	if text == "" || strings.HasPrefix(strings.ToUpper(text), "INFO:") {
		return false, nil
	}
	reader := csv.NewReader(strings.NewReader(text))
	for {
		record, err := reader.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return false, err
		}
		if len(record) > 0 && strings.EqualFold(strings.TrimSpace(record[0]), imageName) {
			return true, nil
		}
	}
	return false, nil
}

func resolvePresetBinary(preset launchPreset, lookPath func(string) (string, error), exists func(string) bool) (string, []string, error) {
	tried := make([]string, 0, len(preset.Candidates))
	for _, candidate := range preset.Candidates {
		tried = append(tried, candidate)
		resolved, err := lookPath(candidate)
		if err == nil {
			return resolved, tried, nil
		}
	}
	for _, rawPath := range preset.KnownPaths {
		resolved := expandEnvPath(rawPath)
		if strings.TrimSpace(resolved) == "" {
			continue
		}
		tried = append(tried, resolved)
		if exists(resolved) {
			return resolved, tried, nil
		}
	}
	return "", tried, errors.New("not found")
}

func expandEnvPath(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	return percentEnvPattern.ReplaceAllStringFunc(raw, func(match string) string {
		key := strings.Trim(match, "%")
		if key == "" {
			return match
		}
		if value := os.Getenv(key); value != "" {
			return value
		}
		return match
	})
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func printLaunchPresets() {
	fmt.Println("可用 launch 预设:")
	for _, preset := range managedLaunchPresets {
		fmt.Printf("  - %s: %s\n", preset.Name, preset.Description)
		fmt.Printf("    候选命令: %s\n", strings.Join(preset.Candidates, ", "))
		if len(preset.KnownPaths) > 0 {
			fmt.Printf("    常见安装目录: %s\n", strings.Join(preset.KnownPaths, ", "))
		}
	}
	fmt.Println()
	fmt.Println("示例:")
	fmt.Printf("  %s --launch-preset vscode\n", selfBinaryName())
	fmt.Printf("  %s --launch-preset cursor\n", selfBinaryName())
	fmt.Printf("  %s --launch-preset powershell\n", selfBinaryName())
	fmt.Printf("  %s --launch code --reuse-window\n", selfBinaryName())
}

func mergeEnv(existing []string, overrides map[string]string) []string {
	merged := make(map[string]string, len(existing)+len(overrides))
	for _, item := range existing {
		parts := strings.SplitN(item, "=", 2)
		if len(parts) != 2 {
			continue
		}
		merged[strings.ToUpper(parts[0])] = parts[1]
	}
	for key, value := range overrides {
		merged[strings.ToUpper(key)] = value
	}
	result := make([]string, 0, len(merged))
	for key, value := range merged {
		result = append(result, key+"="+value)
	}
	return result
}
