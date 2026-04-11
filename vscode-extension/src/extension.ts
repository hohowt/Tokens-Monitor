import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';
import { StatusBarManager } from './statusBar';
import { DashboardProvider } from './dashboard';
import { registerChatParticipant } from './chatParticipant';
import { registerTools } from './tools';
import { CopilotMetrics } from './copilotMetrics';
import { getConfig } from './config';
import { EventBus } from './eventBus';
import { NetworkInterceptor } from './networkInterceptor';
import { ProxyManager } from './proxyManager';
import { CursorCollector } from './collectors/cursorCollector';
import { ClineCollector } from './collectors/clineCollector';
import { ContinueCollector } from './collectors/continueCollector';
import { checkForUpdates } from './updater';

const PROXY_RELOAD_PENDING_KEY = 'aiTokenMonitor.proxyReloadPending';

export async function activate(context: vscode.ExtensionContext) {
    // Migrate old default server URL to new one
    const cfgSection = vscode.workspace.getConfiguration('aiTokenMonitor');
    const currentUrl = cfgSection.get<string>('serverUrl', '');
    if (currentUrl === 'http://192.168.0.135:8000') {
        await cfgSection.update('serverUrl', 'https://otw.tech:59889', vscode.ConfigurationTarget.Global);
    }

    const cfg = getConfig();

    // Create EventBus for decoupled architecture
    const eventBus = new EventBus();

    const proxyManager = new ProxyManager(cfg, context);
    let interceptor: NetworkInterceptor | undefined;
    let statusBar: StatusBarManager | undefined;
    let dashboardProvider: DashboardProvider | undefined;

    const stopInterceptor = () => {
        if (!interceptor) {
            return;
        }
        interceptor.stop();
        interceptor = undefined;
    };

    const startInterceptor = (serverUrl: string) => {
        stopInterceptor();
        interceptor = new NetworkInterceptor(eventBus, serverUrl);
        try {
            interceptor.start();
        } catch (err) {
            console.warn('[Extension] NetworkInterceptor failed to start:', err);
            vscode.window.showWarningMessage(`AI Token 拦截器启动失败: ${err}`);
            interceptor = undefined;
        }
    };

    const syncReloadPendingState = async (pending: boolean) => {
        await context.globalState.update(PROXY_RELOAD_PENDING_KEY, pending);
        statusBar?.setReloadPending(pending);
        if (dashboardProvider) {
            await dashboardProvider.notifyProxyStatus();
        }
    };

    const promptReloadForProxyRouting = async (reason: 'startup' | 'config-change'): Promise<void> => {
        await syncReloadPendingState(true);

        const message = reason === 'startup'
            ? 'AI Token 监控已接管当前 VS Code 的网络代理。要开始采集当前窗口里的 Copilot / AI 请求，需要重载窗口一次。'
            : 'AI Token 监控已更新当前 VS Code 的网络代理。要让当前窗口里的 Copilot / AI 请求进入监控，需要重载窗口一次。';

        const action = await vscode.window.showInformationMessage(
            message,
            '立即重载',
            '稍后',
        );

        if (action === '立即重载') {
            // Keep pending=true so that after reload, wasReloadPending suppresses re-prompting.
            // applyTransportMode will clear it on next activation.
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    };

    const applyTransportMode = async (
        config = getConfig(),
        restartProxy = false,
        reason: 'startup' | 'config-change' = 'startup',
    ) => {
        proxyManager.updateConfig(config);
        // 如果上次设置了"待重载"，说明这次激活就是用户重载后的结果，应直接清除标记
        const wasReloadPending = context.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false);

        const result = restartProxy ? await proxyManager.restart(config) : await proxyManager.start();
        if (result.status === 'off') {
            await syncReloadPendingState(false);
            startInterceptor(config.serverUrl);
            return;
        }

        stopInterceptor();
        if (wasReloadPending) {
            // 用户已完成重载，proxy routing 已生效，清除标记
            await syncReloadPendingState(false);
        } else if (result.routingChanged) {
            console.log('[Extension] Transparent proxy routing updated. Reload window to route existing connections.');
            void promptReloadForProxyRouting(reason);
        }
    };

    await applyTransportMode(cfg, false, 'startup');
    context.subscriptions.push({ dispose: () => { stopInterceptor(); void proxyManager.stop(); } });

    // Core services
    const tracker = new TokenTracker(cfg, context.globalState, eventBus);
    statusBar = new StatusBarManager(tracker);
    statusBar.setReloadPending(context.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false));

    // Start token tracker (real-time reporting)
    tracker.start();
    context.subscriptions.push({ dispose: () => tracker.stop() });

    // Status bar
    statusBar.show();
    context.subscriptions.push({ dispose: () => statusBar.dispose() });

    // Chat Participant: @monitor
    registerChatParticipant(context, tracker, eventBus);

    // LM Tools
    registerTools(context, tracker, eventBus);

    // Dashboard WebView
    const extensionVersion = context.extension.packageJSON.version ?? '0.0.0';
    dashboardProvider = new DashboardProvider(
        context.extensionUri, tracker, cfg, context.globalState, context.secrets, proxyManager, extensionVersion
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('tokenMonitor.dashboard', dashboardProvider)
    );

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenMonitor.showDashboard', () => {
            vscode.commands.executeCommand('tokenMonitor.dashboard.focus');
        }),
        vscode.commands.registerCommand('tokenMonitor.newChat', () => {
            vscode.commands.executeCommand('workbench.action.chat.open', { query: '@otw ' });
        }),
        vscode.commands.registerCommand('tokenMonitor.startProxy', async () => {
            const startCfg = { ...getConfig(), transparentMode: true };
            proxyManager.updateConfig(startCfg);
            const result = await proxyManager.start({ skipUpstreamDetect: true });
            if (result.status === 'off') {
                await syncReloadPendingState(false);
                startInterceptor(startCfg.serverUrl);
                vscode.window.showWarningMessage('监控代理启动失败，请检查 Output 面板“AI Token Monitor Proxy”');
            } else {
                stopInterceptor();
                if (result.routingChanged) {
                    void promptReloadForProxyRouting('config-change');
                } else if (context.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false)) {
                    await syncReloadPendingState(false);
                }
            }
            await dashboardProvider.notifyProxyStatus();
        }),
        vscode.commands.registerCommand('tokenMonitor.stopProxy', async () => {
            await proxyManager.stop();
            await syncReloadPendingState(false);
            startInterceptor(getConfig().serverUrl);
            await dashboardProvider.notifyProxyStatus();
        }),
        vscode.commands.registerCommand('tokenMonitor.checkUpdate', async () => {
            return await checkForUpdates(context, getConfig().serverUrl, true);
        })
    );

    // Copilot Metrics API (if org is configured; PAT is read from SecretStorage at poll time)
    if (cfg.copilotOrg) {
        const metrics = new CopilotMetrics(cfg, tracker, context.secrets);
        metrics.startPolling();
        context.subscriptions.push({ dispose: () => metrics.stopPolling() });
    }

    // Initialize data collectors for seamless monitoring
    const collectors = [
        new CursorCollector(eventBus),
        new ClineCollector(eventBus),
        new ContinueCollector(eventBus),
    ];

    for (const collector of collectors) {
        try {
            await collector.init?.();
            await collector.start();
            context.subscriptions.push({
                dispose: () => { collector.stop().catch(err => console.warn(`Error stopping ${collector.name}:`, err)); }
            });
            console.log(`[Extension] Data collector ${collector.name} started`);
        } catch (err) {
            console.warn(`[Extension] Data collector ${collector.name} failed to start:`, err);
        }
    }

    // Listen for config changes — auto-apply
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiTokenMonitor') || e.affectsConfiguration('http.proxy')) {
                const newCfg = getConfig();
                tracker.updateConfig(newCfg);
                statusBar.refresh();
                dashboardProvider.updateConfig(newCfg);
                void applyTransportMode(newCfg, true, 'config-change');
            }
        })
    );

    // First-run setup wizard
    if (!cfg.userId) {
        const action = await vscode.window.showInformationMessage(
            '腾轩 AI 监控: 请先配置用户信息。启用后将自动记录 @otw 和相关工具的 AI 使用情况。',
            '打开监控面板'
        );
        if (action === '打开监控面板') {
            vscode.commands.executeCommand('tokenMonitor.dashboard.focus');
        }
    }

    // One-time tip
    const tipShown = context.globalState.get<boolean>('monitorTipShown', false);
    if (!tipShown) {
        context.globalState.update('monitorTipShown', true);
        const action = await vscode.window.showInformationMessage(
            '腾轩 AI 监控已启动。通过 @otw、LM Tools 和 Copilot Metrics API 自动记录 AI 使用情况。',
            '打开面板'
        );
        if (action === '打开面板') {
            vscode.commands.executeCommand('tokenMonitor.dashboard.focus');
        }
    }

    // Self-update check (non-blocking, silent on failure)
    void checkForUpdates(context, cfg.serverUrl);
}

export function deactivate() {
    // Cleanup is handled by subscriptions in activate()
}
