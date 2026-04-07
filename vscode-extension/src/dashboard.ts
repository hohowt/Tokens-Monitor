import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';
import { MonitorConfig, getConfig } from './config';
import { LocalProxyStatusSnapshot, ProxyManager } from './proxyManager';

const PROXY_RELOAD_PENDING_KEY = 'aiTokenMonitor.proxyReloadPending';

interface IdentityStatusData {
    status: string;
    message: string;
    existing_name?: string;
    other_employee_ids?: string[];
    known_apps?: string[];
}

interface ProxyStatusData {
    proxyRunning: boolean;
    reloadRequired: boolean;
}

interface DiagnosticCheck {
    label: string;
    status: 'ok' | 'warn' | 'error' | 'info';
    detail: string;
}

interface DiagnosticReport {
    summary: 'ok' | 'warn' | 'error';
    headline: string;
    checks: DiagnosticCheck[];
    recentLogs: string[];
}

interface DiagnosticAckData {
    startedAt: number;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private refreshTimer?: ReturnType<typeof setInterval>;
    private config: MonitorConfig;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly tracker: TokenTracker,
        initialConfig: MonitorConfig,
        private readonly globalState: vscode.Memento,
        private readonly secrets: vscode.SecretStorage,
        private readonly proxyManager?: ProxyManager,
    ) {
        this.config = initialConfig;
    }

    public updateConfig(cfg: MonitorConfig) {
        this.config = cfg;
        if (this.view?.visible) {
            this.view.webview.postMessage({ type: 'configUpdated', data: this.getConfigData() });
            void this.refreshDashboard();
        }
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        void this.refreshDashboard();
        void this.notifyProxyStatus();

        // Update every 10 seconds
        this.refreshTimer = setInterval(() => {
            if (this.view?.visible) {
                void this.refreshDashboard();
                void this.notifyProxyStatus();
            }
        }, 10_000);

        webviewView.onDidDispose(() => {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
        });

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'refresh') {
                await this.refreshDashboard(true);
            } else if (msg.type === 'saveConfig') {
                await this.saveConfig(msg.data);
            } else if (msg.type === 'savePat') {
                if (typeof msg.pat === 'string' && msg.pat) {
                    await this.secrets.store('copilotPat', msg.pat);
                    this.view?.webview.postMessage({ type: 'patSaved' });
                }
            } else if (msg.type === 'newChat') {
                vscode.commands.executeCommand('tokenMonitor.newChat');
            } else if (msg.type === 'startProxy') {
                await vscode.commands.executeCommand('tokenMonitor.startProxy');
            } else if (msg.type === 'stopProxy') {
                await vscode.commands.executeCommand('tokenMonitor.stopProxy');
            } else if (msg.type === 'reloadWindow') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (msg.type === 'runDiagnostics') {
                this.view?.webview.postMessage({
                    type: 'diagnosticsAck',
                    data: { startedAt: Date.now() } satisfies DiagnosticAckData,
                });
                await this.runDiagnosticsWithTimeout();
            }
        });
    }

    private async runDiagnosticsWithTimeout(): Promise<void> {
        const timeoutMs = 12_000;
        let finished = false;

        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                if (finished) {
                    resolve();
                    return;
                }
                finished = true;
                this.postDiagnosticsResult({
                    summary: 'error',
                    headline: '诊断执行超时，已自动中断。请检查扩展输出日志并重载窗口后重试。',
                    checks: [{
                        label: '诊断超时',
                        status: 'error',
                        detail: `扩展侧在 ${Math.round(timeoutMs / 1000)} 秒内未完成诊断流程，可能存在本地阻塞或通信异常。`,
                    }],
                    recentLogs: this.proxyManager ? this.filterDiagnosticLogs(this.proxyManager.getRecentOutputLines(80)) : [],
                });
                resolve();
            }, timeoutMs);
        });

        await Promise.race([
            (async () => {
                await this.runDiagnostics();
                if (!finished) {
                    finished = true;
                }
            })(),
            timeoutPromise,
        ]);
    }

    private getStats() {
        const breakdown = this.tracker.getBreakdown();
        return {
            todayTokens: this.tracker.todayTokens,
            todayRequests: this.tracker.todayRequests,
            totalReported: this.tracker.totalReported,
            totalFailed: this.tracker.totalFailed,
            breakdown,
            proxyRunning: false, // will be updated async
        };
    }

    private getConfigData() {
        return {
            serverUrl: this.config.serverUrl,
            userId: this.config.userId,
            userName: this.config.userName,
            department: this.config.department,
            copilotOrg: this.config.copilotOrg,
            // copilotPat is stored in SecretStorage and never sent to the webview
        };
    }

    private async saveConfig(data: Record<string, unknown>): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('aiTokenMonitor');
        const stringKeys = ['serverUrl', 'userId', 'userName', 'department', 'copilotOrg'] as const;
        for (const key of stringKeys) {
            if (key in data) {
                await cfg.update(key, String(data[key] ?? ''), vscode.ConfigurationTarget.Global);
            }
        }
        this.config = getConfig();
        this.tracker.updateConfig(this.config);
        this.view?.webview.postMessage({ type: 'configSaved' });
        await this.refreshDashboard(true);
    }

    private postStatsUpdate(): void {
        this.view?.webview.postMessage({
            type: 'update',
            data: this.getStats(),
        });
    }

    private postIdentityStatus(data: IdentityStatusData): void {
        this.view?.webview.postMessage({
            type: 'identityStatus',
            data,
        });
    }

    private postDiagnosticsResult(data: DiagnosticReport): void {
        this.view?.webview.postMessage({
            type: 'diagnosticsResult',
            data,
        });
    }

    private normalizeValue(value: string | undefined | null): string {
        return (value || '').trim().replace(/\/+$/, '');
    }

    private async fetchJsonWithTimeout<T>(url: string, timeoutMs = 5000): Promise<T | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                return null;
            }
            return await response.json() as T;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private filterDiagnosticLogs(lines: string[]): string[] {
        const important = lines.filter(line => /\[上报\]|\[心跳\]|\[MITM|\[记录|\[网络\]|\[启动\]|HTTP 409|identity_conflict|冲突|Process exited|Local proxy did not become ready|Binary not found|Updated VS Code http\.proxy/i.test(line));
        const selected = important.length > 0 ? important : lines;
        return selected.slice(-10);
    }

    private async runDiagnostics(): Promise<void> {
        const checks: DiagnosticCheck[] = [];
        let summary: DiagnosticReport['summary'] = 'ok';
        const userId = this.config.userId.trim();
        const userName = this.config.userName.trim();
        const serverUrl = this.normalizeValue(this.config.serverUrl);
        const reloadRequired = this.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false);
        const currentHttpProxy = this.normalizeValue(vscode.workspace.getConfiguration('http').get<string>('proxy', ''));
        const recentLogs = this.proxyManager ? this.filterDiagnosticLogs(this.proxyManager.getRecentOutputLines(80)) : [];

        const addCheck = (status: DiagnosticCheck['status'], label: string, detail: string) => {
            checks.push({ status, label, detail });
            if (status === 'error') {
                summary = 'error';
                return;
            }
            if (status === 'warn' && summary === 'ok') {
                summary = 'warn';
            }
        };

        try {
            if (!serverUrl || !userId || !userName) {
                addCheck('error', '基础配置', '上报地址、工号、姓名未填写完整，当前无法建立完整上报链路。');
            } else {
                addCheck('ok', '基础配置', `当前身份为 ${userName}（${userId}），上报地址 ${serverUrl}`);
            }

            let serverHealthy = false;
            if (serverUrl) {
                const health = await this.fetchJsonWithTimeout<{ status?: string }>(`${serverUrl}/health`, 4000);
                serverHealthy = health?.status === 'ok';
                addCheck(
                    serverHealthy ? 'ok' : 'error',
                    '服务端连接',
                    serverHealthy ? '服务端 /health 检查通过。' : '无法访问服务端 /health，地址错误或网络不通时会卡在这里。',
                );
            }

            const identityStatus = await this.fetchIdentityStatus();
            if (identityStatus.status === 'conflict') {
                addCheck('error', '身份校验', identityStatus.message);
            } else if (identityStatus.status === 'warning' || identityStatus.status === 'unavailable') {
                addCheck('warn', '身份校验', identityStatus.message);
            } else if (identityStatus.status === 'incomplete') {
                addCheck('error', '身份校验', identityStatus.message);
            } else {
                addCheck('ok', '身份校验', identityStatus.message);
            }

            if (!this.proxyManager) {
                addCheck('error', '本地监控代理', '当前扩展实例没有可用的代理管理器。');
                this.postDiagnosticsResult({
                    summary,
                    headline: '本地监控代理不可用',
                    checks,
                    recentLogs,
                });
                return;
            }

            const binaryPath = this.proxyManager.findBinaryPath();
            addCheck(
                binaryPath ? 'ok' : 'error',
                '本地监控程序',
                binaryPath ? `已找到本地 ai-monitor：${binaryPath}` : '未找到 ai-monitor，可导致只有心跳和面板同步，没有真实请求进入本地代理。',
            );

            const proxyStatus = await this.proxyManager.getProxyStatus();
            addCheck(
                proxyStatus === 'off' ? 'error' : 'ok',
                '代理进程状态',
                proxyStatus === 'internal'
                    ? '扩展内置代理正在运行。'
                    : proxyStatus === 'external'
                        ? '检测到外部代理实例正在提供监控能力。'
                        : '当前没有可用的本地监控代理。',
            );

            if (!this.config.transparentMode) {
                addCheck('warn', '透明代理', '透明代理已关闭，Copilot 等网络请求可能不会进入本地监控。');
            } else {
                const expectedProxy = this.normalizeValue(this.proxyManager.getMitmProxyUrl());
                addCheck(
                    currentHttpProxy === expectedProxy ? 'ok' : 'error',
                    'VS Code 代理设置',
                    currentHttpProxy === expectedProxy
                        ? `http.proxy 已指向 ${expectedProxy}`
                        : (currentHttpProxy
                            ? `当前 http.proxy 为 ${currentHttpProxy}，不是监控代理 ${expectedProxy}`
                            : `当前 http.proxy 为空，尚未指向监控代理 ${expectedProxy}`),
                );
            }

            if (reloadRequired) {
                addCheck('error', '窗口状态', '当前窗口还没有重载。最常见的现象就是 users / clients 已有记录，但没有任何 Token 进入 /api/collect。');
            } else {
                addCheck('ok', '窗口状态', '当前窗口不处于待重载状态。');
            }

            const localStatus = await this.proxyManager.getLocalStatus();
            if (localStatus) {
                this.applyProxyRuntimeChecks(localStatus, checks, addCheck, serverUrl, userName);
            } else if (proxyStatus !== 'off') {
                addCheck('warn', '本地代理状态页', '本地代理正在运行，但 /status 暂时不可读。通常是刚启动、端口冲突或进程异常。');
            }

            if (recentLogs.length === 0) {
                addCheck('info', '最近代理日志', '最近没有关键日志，通常意味着当前窗口里还没有 AI 请求进入本地监控。');
            } else if (recentLogs.some(line => /HTTP 409|identity_conflict|冲突/i.test(line))) {
                addCheck('error', '最近代理日志', '代理已经尝试上报，但最近日志里出现了冲突或 409 拒绝。');
            } else if (recentLogs.some(line => /\[上报\].*最终失败|\[网络\].*POST \/api\/collect/i.test(line))) {
                addCheck('error', '最近代理日志', '代理已经抓到请求，但最近发送 /api/collect 失败了。');
            } else if (recentLogs.some(line => /\[记录|\[MITM/i.test(line))) {
                addCheck('warn', '最近代理日志', '已经看到 AI 请求流经本地代理，但还没有看到成功上报。');
            } else {
                addCheck('info', '最近代理日志', '最近没有看到 AI 请求流经本地代理的明显迹象。');
            }

            const headline = this.buildDiagnosticHeadline({
                reloadRequired,
                serverHealthy,
                identityStatus,
                proxyStatus,
                currentHttpProxy,
                expectedProxy: this.config.transparentMode ? this.normalizeValue(this.proxyManager.getMitmProxyUrl()) : '',
                localStatus,
                recentLogs,
                hasConfig: Boolean(serverUrl && userId && userName),
            });

            this.postDiagnosticsResult({
                summary,
                headline,
                checks,
                recentLogs,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            checks.push({
                status: 'error',
                label: '诊断执行',
                detail: `诊断过程发生异常：${message}`,
            });
            this.postDiagnosticsResult({
                summary: 'error',
                headline: '诊断执行异常，请重试。若持续异常，请重载窗口后再试。',
                checks,
                recentLogs,
            });
        }
    }

    private applyProxyRuntimeChecks(
        localStatus: LocalProxyStatusSnapshot,
        _checks: DiagnosticCheck[],
        addCheck: (status: DiagnosticCheck['status'], label: string, detail: string) => void,
        serverUrl: string,
        userName: string,
    ): void {
        const runtimeServer = this.normalizeValue(localStatus.server);
        const reported = Number(localStatus.stats?.total_reported ?? 0);
        const totalTokens = Number(localStatus.stats?.total_tokens ?? 0);

        addCheck(
            runtimeServer && runtimeServer !== serverUrl ? 'warn' : 'ok',
            '代理运行配置',
            runtimeServer && runtimeServer !== serverUrl
                ? `本地代理当前上报到 ${runtimeServer}，与面板配置的 ${serverUrl} 不一致。`
                : `本地代理版本 ${localStatus.version || 'unknown'}，状态 ${localStatus.status || 'running'}。`,
        );

        addCheck(
            localStatus.user && userName && localStatus.user !== userName ? 'warn' : 'ok',
            '代理当前身份',
            localStatus.user && userName && localStatus.user !== userName
                ? `本地代理当前用户是 ${localStatus.user}，与面板填写的 ${userName} 不一致。`
                : `本地代理当前用户 ${localStatus.user || '未知'}。`,
        );

        addCheck(
            reported > 0 ? 'ok' : 'warn',
            '本地成功上报',
            reported > 0
                ? `本地代理已成功上报 ${reported} 条记录，共 ${totalTokens.toLocaleString()} Tokens。`
                : '本地代理最近还没有成功上报任何 Token 记录。',
        );
    }

    private buildDiagnosticHeadline(args: {
        reloadRequired: boolean;
        serverHealthy: boolean;
        identityStatus: IdentityStatusData;
        proxyStatus: string;
        currentHttpProxy: string;
        expectedProxy: string;
        localStatus: LocalProxyStatusSnapshot | null;
        recentLogs: string[];
        hasConfig: boolean;
    }): string {
        if (!args.hasConfig) {
            return '基础配置还没填完整，当前无法建立有效上报链路。';
        }
        if (!args.serverHealthy) {
            return '服务端健康检查失败，先确认上报地址和网络连通性。';
        }
        if (args.identityStatus.status === 'conflict') {
            return '工号和姓名与服务器记录冲突，服务端会拒绝写入。';
        }
        if (args.reloadRequired) {
            return '当前窗口还没有重载，这是最可能导致“用户已入库但没有 Token 记录”的原因。';
        }
        if (args.proxyStatus === 'off') {
            return '本地监控代理没有运行，请先让请求真正进入本地代理。';
        }
        if (args.expectedProxy && args.currentHttpProxy !== args.expectedProxy) {
            return 'VS Code 当前没有把网络请求路由到本地监控代理。';
        }
        if (Number(args.localStatus?.stats?.total_reported ?? 0) > 0) {
            return '本地代理已经出现成功上报，当前链路基本正常。';
        }
        if (args.recentLogs.some(line => /HTTP 409|identity_conflict|冲突/i.test(line))) {
            return '代理抓到了请求，但服务端最近拒绝了上报。';
        }
        if (args.recentLogs.some(line => /\[上报\].*最终失败|\[网络\].*POST \/api\/collect/i.test(line))) {
            return '代理抓到了请求，但发送到服务端失败。';
        }
        if (args.recentLogs.some(line => /\[记录|\[MITM/i.test(line))) {
            return '代理已经抓到 AI 请求，但还没有成功写到服务端。';
        }
        return '当前还没有看到 AI 请求流经本地代理。若你刚安装扩展，先重载窗口再发起一次真实请求。';
    }

    private getDefaultIdentityStatus(): IdentityStatusData {
        const userId = this.config.userId.trim();
        const userName = this.config.userName.trim();

        if (!userId && !userName) {
            return {
                status: 'incomplete',
                message: '填写工号和姓名后会自动检查是否与服务器已有身份冲突。同一工号可在 VS Code、Cursor、PowerShell 等多个应用共用。',
            };
        }

        if (!userId || !userName) {
            return {
                status: 'incomplete',
                message: '请同时填写工号和姓名。系统会自动检查重复编号；同一工号可以在多个应用共用。',
            };
        }

        if (!this.config.serverUrl.trim()) {
            return {
                status: 'unavailable',
                message: '请先配置上报地址，之后面板会自动检查工号是否已被其他姓名占用。',
            };
        }

        return {
            status: 'checking',
            message: '正在检查当前工号是否已存在。同一工号在多个应用共用属于正常情况。',
        };
    }

    private async fetchIdentityStatus(): Promise<IdentityStatusData> {
        const fallback = this.getDefaultIdentityStatus();
        if (fallback.status !== 'checking') {
            return fallback;
        }

        try {
            const params = new URLSearchParams({
                user_id: this.config.userId.trim(),
                user_name: this.config.userName.trim(),
                department: this.config.department.trim(),
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`${this.config.serverUrl}/api/clients/identity-check?${params.toString()}`, {
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!response.ok) {
                return {
                    status: 'unavailable',
                    message: response.status === 404
                        ? '服务器暂未部署身份检查接口，暂时无法自动识别重复工号。'
                        : '服务器暂时无法完成工号校验，请稍后重试。',
                };
            }
            return await response.json() as IdentityStatusData;
        } catch {
            return {
                status: 'unavailable',
                message: '无法连接上报服务器或校验超时，暂时不能检查工号是否重复。',
            };
        }
    }

    public async notifyProxyStatus(): Promise<void> {
        const running = this.proxyManager ? await this.proxyManager.isProxyAvailable() : false;
        const reloadRequired = this.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false);
        this.view?.webview.postMessage({
            type: 'proxyStatus',
            data: {
                proxyRunning: running,
                reloadRequired,
            } satisfies ProxyStatusData,
        });
    }

    private async refreshDashboard(flushPending = false): Promise<void> {
        const identityStatus = await this.fetchIdentityStatus();
        if (identityStatus.status !== 'conflict') {
            if (flushPending) {
                await this.tracker.flushOfflineQueue();
            }
            await this.tracker.syncStats();
        }
        this.postStatsUpdate();
        this.postIdentityStatus(identityStatus);
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private getNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let value = '';
        for (let i = 0; i < 32; i += 1) {
            value += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return value;
    }

    private renderBreakdown(data?: Record<string, number>): string {
        if (!data || Object.keys(data).length === 0) {
            return '<div class="empty-state">暂无数据</div>';
        }
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, [, v]) => sum + v, 0);
        return entries.map(([key, value]) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return `<div class="breakdown-row">
                <div class="breakdown-top">
                    <span class="breakdown-label">${this.esc(key)}</span>
                    <span class="breakdown-value">${value.toLocaleString()} <span style="opacity:0.6;margin-left:6px;color:var(--text-sub)">${pct}%</span></span>
                </div>
                <div class="breakdown-bar"><div class="breakdown-fill" style="width:${pct}%"></div></div>
            </div>`;
        }).join('');
    }

    private getHtml(webview: vscode.Webview): string {
        const stats = this.getStats();
        const cfgData = this.getConfigData();
        const nonce = this.getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
    :root {
        --bg: #101318;
        --bg-soft: #171b23;
        --panel: rgba(22, 26, 34, 0.82);
        --panel-strong: rgba(26, 30, 39, 0.96);
        --border: rgba(255, 255, 255, 0.08);
        --border-strong: rgba(255, 255, 255, 0.14);
        --text-main: #edf1f7;
        --text-sub: #98a0b2;
        --accent: #ff5b50;
        --accent-strong: #ff875f;
        --accent-glow: rgba(255, 91, 80, 0.22);
        --accent-soft: rgba(255, 91, 80, 0.08);
        --success: #38d98b;
        --error: #ff5377;
        --font-ui: var(--vscode-font-family);
        --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Mono', monospace;
    }

    * { box-sizing: border-box; }
    body {
        position: relative;
        min-height: 100vh;
        font-family: var(--font-ui);
        color: var(--text-main);
        background:
            radial-gradient(circle at top left, rgba(255, 91, 80, 0.16), transparent 30%),
            radial-gradient(circle at top right, rgba(74, 134, 255, 0.12), transparent 26%),
            linear-gradient(180deg, var(--bg-soft) 0%, var(--bg) 100%);
        padding: 0;
        margin: 0;
        overflow-x: hidden;
    }
    body::before {
        content: '';
        position: fixed;
        inset: 0;
        background:
            linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
        background-size: 24px 24px;
        mask-image: linear-gradient(180deg, rgba(255,255,255,0.25), transparent 58%);
        opacity: 0.24;
        pointer-events: none;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 999px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.22); }

    .glass-panel {
        background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.012)),
            var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .header {
        position: relative;
        overflow: hidden;
        margin: 12px 12px 10px;
        padding: 18px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(240px, 280px);
        gap: 14px;
        align-items: start;
        background:
            linear-gradient(135deg, rgba(255, 91, 80, 0.1), rgba(255, 255, 255, 0.025) 48%, rgba(74, 134, 255, 0.08) 100%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent);
    }
    .header-left {
        position: relative;
        z-index: 1;
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }
    .header-brand-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .header-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.24);
    }
    .header-identity {
        position: relative;
        z-index: 1;
        min-width: 0;
        align-self: start;
        padding: 14px 16px 12px;
        border-radius: 18px;
        background: rgba(10, 14, 20, 0.34);
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        gap: 10px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
        cursor: pointer;
        transition: border-color 0.2s ease, transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    }
    .header-identity:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 255, 255, 0.2);
        background: rgba(15, 20, 28, 0.46);
    }
    .header-identity.empty {
        border-style: dashed;
        background: rgba(255, 255, 255, 0.03);
    }
    .header-identity.offline {
        border-color: rgba(255, 83, 119, 0.42);
        background: linear-gradient(180deg, rgba(82, 24, 38, 0.46), rgba(30, 12, 18, 0.55));
        box-shadow: 0 12px 24px rgba(255, 83, 119, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .identity-kicker {
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.5);
    }
    .identity-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .identity-name {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: 0.2px;
        color: #fff;
        line-height: 1.1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .identity-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
    }
    .identity-details {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
    }
    .identity-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        line-height: 1;
    }
    .identity-pill.is-empty {
        background: rgba(255, 255, 255, 0.025);
        border-style: dashed;
        color: rgba(255, 255, 255, 0.44);
    }
    .identity-pill-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.42);
    }
    .identity-pill-value {
        max-width: 128px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--text-main);
    }
    .identity-hint {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.48);
        white-space: nowrap;
    }
    .header::before {
        content: '';
        position: absolute;
        top: 0;
        left: 18px;
        width: 72px;
        height: 3px;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent), rgba(255, 255, 255, 0));
    }
    .header::after {
        content: '';
        position: absolute;
        right: -40px;
        top: -60px;
        width: 180px;
        height: 180px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 135, 95, 0.18) 0%, transparent 68%);
        pointer-events: none;
    }
    .header-brand {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.84);
    }
    .header-caption {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.54);
    }
    .header-title {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: #fff;
        margin-top: 12px;
    }
    .header-subline {
        margin-top: 8px;
        max-width: 380px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-sub);
    }
    .header-author {
        margin-top: 10px;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.54);
        font-family: var(--font-mono);
    }
    .user-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 0;
        padding: 4px 9px;
        border-radius: 999px;
        background: rgba(56, 217, 139, 0.12);
        border: 1px solid rgba(56, 217, 139, 0.24);
        color: var(--success);
        font-size: 10px;
        font-weight: 600;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .user-status::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 6px currentColor;
    }
    .user-status.error {
        background: rgba(255, 83, 119, 0.12);
        border-color: rgba(255, 83, 119, 0.24);
        color: var(--error);
    }

    .content {
        position: relative;
        z-index: 1;
        padding: 0 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .btn {
        width: auto;
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.3px;
    }
    .btn:hover {
        transform: translateY(-1px);
    }
    .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 14px;
    }
    .toolbar-main {
        flex: 1;
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
        gap: 14px;
    }
    .toolbar-item {
        min-width: 0;
    }
    .toolbar-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: rgba(255, 255, 255, 0.46);
    }
    .toolbar-value {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-main);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .proxy-control {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
        font-size: 12px;
    }
    .proxy-summary {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .proxy-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--error);
        box-shadow: 0 0 6px var(--error);
        transition: all 0.3s ease;
    }
    .proxy-dot.on {
        background: var(--success);
        box-shadow: 0 0 6px var(--success);
    }
    .proxy-status-text {
        font-weight: 600;
        color: var(--text-main);
    }
    .proxy-status-text.pending {
        color: #ffb84d;
    }
    .proxy-dot.pending {
        background: #ffb84d;
        box-shadow: 0 0 8px rgba(255, 184, 77, 0.7);
    }
    .btn-proxy {
        padding: 8px 12px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-main);
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--border-strong);
        cursor: pointer;
        border-radius: 10px;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }
    .btn-proxy:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.22);
    }
    .btn-proxy.is-active {
        color: var(--success);
        border-color: rgba(56, 217, 139, 0.28);
        background: rgba(56, 217, 139, 0.08);
    }
    .btn-proxy:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .proxy-hint {
        margin-top: 7px;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-sub);
    }
    .proxy-hint.warning {
        color: rgba(255, 235, 204, 0.92);
    }
    .proxy-reload-btn {
        margin-top: 8px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--accent-strong);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }
    .proxy-reload-btn:hover {
        color: #ffab7d;
    }
    .proxy-reload-btn.hidden {
        display: none;
    }
    .toolbar-actions {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        flex-shrink: 0;
    }
    .refresh-meta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 16px;
        font-size: 11px;
        color: var(--text-sub);
        white-space: nowrap;
    }
    .refresh-meta::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.26);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04);
        transition: background 0.2s ease, box-shadow 0.2s ease;
        flex-shrink: 0;
    }
    .refresh-meta.is-refreshing {
        color: var(--text-main);
    }
    .refresh-meta.is-refreshing::before {
        background: var(--accent);
        box-shadow: 0 0 12px var(--accent-glow);
        animation: pulseDot 1.1s ease-in-out infinite;
    }
    .btn-secondary {
        color: var(--text-main);
        background: rgba(255, 255, 255, 0.04);
        border-color: var(--border-strong);
    }
    .btn-secondary:hover {
        border-color: rgba(255, 255, 255, 0.24);
        background: rgba(255, 255, 255, 0.08);
    }
    .refresh-btn {
        min-width: 104px;
    }
    .refresh-btn.is-loading {
        position: relative;
        pointer-events: none;
        color: rgba(255, 255, 255, 0.92);
        border-color: rgba(255, 91, 80, 0.36);
        background: rgba(255, 91, 80, 0.12);
    }
    .refresh-btn.is-loading::before {
        content: '';
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 8px;
        vertical-align: -2px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: rgba(255, 255, 255, 0.92);
        animation: spin 0.75s linear infinite;
    }
    .diagnostic-panel {
        display: grid;
        gap: 12px;
        padding: 14px;
    }
    .diagnostic-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .diagnostic-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-main);
    }
    .diagnostic-caption {
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-sub);
    }
    .diagnostic-btn {
        min-width: 96px;
    }
    .diagnostic-btn.is-loading {
        pointer-events: none;
        opacity: 0.75;
    }
    .diagnostic-summary {
        padding: 11px 12px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        font-size: 12px;
        line-height: 1.6;
        color: var(--text-sub);
    }
    .diagnostic-summary.checking {
        color: var(--text-main);
        border-color: rgba(255, 184, 77, 0.24);
        background: rgba(255, 184, 77, 0.08);
    }
    .diagnostic-summary.ok {
        color: rgba(220, 255, 236, 0.92);
        border-color: rgba(56, 217, 139, 0.22);
        background: rgba(56, 217, 139, 0.08);
    }
    .diagnostic-summary.warn {
        color: rgba(255, 235, 204, 0.92);
        border-color: rgba(255, 184, 77, 0.24);
        background: rgba(255, 184, 77, 0.09);
    }
    .diagnostic-summary.error {
        color: rgba(255, 222, 230, 0.94);
        border-color: rgba(255, 83, 119, 0.28);
        background: rgba(255, 83, 119, 0.1);
    }
    .diagnostic-list {
        display: grid;
        gap: 8px;
    }
    .diagnostic-item {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 10px;
        align-items: start;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.02);
    }
    .diagnostic-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .diagnostic-item.ok .diagnostic-badge {
        background: rgba(56, 217, 139, 0.14);
        color: var(--success);
    }
    .diagnostic-item.warn .diagnostic-badge {
        background: rgba(255, 184, 77, 0.14);
        color: #ffb84d;
    }
    .diagnostic-item.error .diagnostic-badge {
        background: rgba(255, 83, 119, 0.16);
        color: var(--error);
    }
    .diagnostic-item.info .diagnostic-badge {
        background: rgba(255, 255, 255, 0.08);
        color: var(--text-sub);
    }
    .diagnostic-item-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-main);
    }
    .diagnostic-item-detail {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.55;
        color: var(--text-sub);
    }
    .diagnostic-logs-wrap.hidden {
        display: none;
    }
    .diagnostic-logs-title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.42);
    }
    .diagnostic-logs {
        margin: 0;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(7, 10, 15, 0.42);
        color: rgba(232, 238, 248, 0.9);
        font-size: 11px;
        line-height: 1.55;
        font-family: var(--font-mono);
        white-space: pre-wrap;
        max-height: 220px;
        overflow: auto;
    }

    .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
    }
    .card {
        position: relative;
        overflow: hidden;
        padding: 18px 16px 16px;
        min-height: 118px;
    }
    .card::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(145deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0));
        pointer-events: none;
    }
    .card::after {
        content: '';
        position: absolute;
        top: 16px;
        left: 16px;
        width: 58px;
        height: 3px;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent), rgba(255, 255, 255, 0));
        opacity: 0.85;
    }
    .card:nth-child(2)::after {
        background: linear-gradient(90deg, var(--success), rgba(255, 255, 255, 0));
    }
    .card.is-refreshing {
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04), 0 16px 30px rgba(0, 0, 0, 0.2);
    }
    .card.is-refreshing::before {
        background:
            linear-gradient(145deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
            linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), transparent);
        background-size: auto, 220px 100%;
        background-repeat: no-repeat;
        animation: shimmer 1.15s linear infinite;
    }
    .card.is-refreshing .card-value,
    .card.is-refreshing .card-note {
        opacity: 0.72;
        transition: opacity 0.2s ease;
    }
    .card-title {
        position: relative;
        z-index: 1;
        font-size: 11px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.5);
        margin-bottom: 20px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
    }
    .card-value {
        position: relative;
        z-index: 1;
        font-family: var(--font-mono);
        font-size: 32px;
        line-height: 1;
        font-weight: 700;
        letter-spacing: -0.5px;
    }
    .card-value.tokens {
        color: #fff;
        text-shadow: 0 0 18px rgba(255, 91, 80, 0.18);
    }
    .card-value.requests {
        color: #fff;
        text-shadow: 0 0 18px rgba(56, 217, 139, 0.16);
    }
    .card-note {
        position: relative;
        z-index: 1;
        margin-top: 14px;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-sub);
    }

    .report-bar {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 18px;
    }
    .report-bar span {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--panel-strong);
        color: var(--text-sub);
        font-size: 11px;
    }
    .report-bar strong {
        font-family: var(--font-mono);
        font-size: 14px;
    }
    .report-bar .ok { color: var(--success); }
    .report-bar .fail { color: var(--error); }

    .section-stack {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .section-block {
        overflow: hidden;
    }
    .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        color: var(--text-main);
        cursor: pointer;
        user-select: none;
    }
    .section-copy {
        min-width: 0;
    }
    .section-heading {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: var(--text-main);
    }
    .section-caption {
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-sub);
    }
    .section-title .arrow {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text-sub);
        font-size: 9px;
        transition: transform 0.2s ease, color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
    }
    .section-title .arrow.open {
        transform: rotate(90deg);
        color: var(--accent);
        border-color: rgba(255, 91, 80, 0.32);
        background: var(--accent-soft);
    }

    .config-section {
        display: none;
        padding: 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .config-section.show {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
        animation: fadeIn 0.22s ease;
    }
    #basicSection.show,
    #advancedSection.show {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: 12px;
        row-gap: 12px;
    }
    .field-span-2 {
        grid-column: 1 / -1;
    }
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .metric-group + .metric-group {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
    }
    .metric-group-title {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-sub);
    }
    .metric-group-title::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 8px var(--accent-glow);
    }

    .field { display: flex; flex-direction: column; gap: 7px; }
    .field label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-main);
        opacity: 0.85;
    }
    .field input {
        width: 100%;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(7, 10, 15, 0.32);
        color: var(--text-main);
        font-size: 13px;
        font-family: var(--font-ui);
        outline: none;
        transition: all 0.2s ease;
    }
    .field input:hover {
        border-color: rgba(255, 255, 255, 0.18);
        background: rgba(10, 14, 20, 0.42);
    }
    .field input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(255, 91, 80, 0.15);
        background: rgba(10, 14, 20, 0.5);
    }
    .field input.input-warning {
        border-color: rgba(255, 184, 77, 0.45);
        box-shadow: 0 0 0 1px rgba(255, 184, 77, 0.08);
    }
    .field input.input-error {
        border-color: rgba(255, 83, 119, 0.46);
        box-shadow: 0 0 0 1px rgba(255, 83, 119, 0.14);
        background: rgba(54, 18, 28, 0.34);
    }

    .identity-check-panel {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 10px;
        align-items: start;
        padding: 11px 12px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-sub);
        font-size: 11px;
        line-height: 1.6;
    }
    .identity-check-panel::before {
        content: '';
        width: 8px;
        height: 8px;
        margin-top: 5px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.26);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
    }
    .identity-check-panel.subtle::before,
    .identity-check-panel.checking::before {
        background: rgba(255, 255, 255, 0.34);
    }
    .identity-check-panel.checking::before {
        animation: pulseDot 1.1s ease-in-out infinite;
    }
    .identity-check-panel.ok {
        border-color: rgba(56, 217, 139, 0.22);
        background: rgba(56, 217, 139, 0.08);
        color: rgba(220, 255, 236, 0.9);
    }
    .identity-check-panel.ok::before {
        background: var(--success);
        box-shadow: 0 0 10px rgba(56, 217, 139, 0.24);
    }
    .identity-check-panel.warning {
        border-color: rgba(255, 184, 77, 0.24);
        background: rgba(255, 184, 77, 0.09);
        color: rgba(255, 235, 204, 0.9);
    }
    .identity-check-panel.warning::before {
        background: #ffb84d;
        box-shadow: 0 0 10px rgba(255, 184, 77, 0.22);
    }
    .identity-check-panel.error {
        border-color: rgba(255, 83, 119, 0.3);
        background: rgba(255, 83, 119, 0.1);
        color: rgba(255, 222, 230, 0.92);
    }
    .identity-check-panel.error::before {
        background: var(--error);
        box-shadow: 0 0 10px rgba(255, 83, 119, 0.24);
    }

    .breakdown-list {
        display: grid;
        gap: 12px;
    }
    .breakdown-row {
        display: grid;
        gap: 6px;
    }
    .breakdown-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }
    .breakdown-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-main);
        font-size: 11px;
    }
    .breakdown-value {
        color: var(--text-sub);
        font-size: 11px;
        white-space: nowrap;
    }
    .breakdown-bar {
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
    }
    .breakdown-fill {
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), var(--accent-strong));
        box-shadow: 0 0 10px var(--accent-glow);
        transition: width 0.35s ease;
    }

    .info-note {
        margin-top: 0;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px dashed rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-sub);
        font-size: 11px;
        line-height: 1.6;
    }
    .empty-state {
        padding: 4px 0;
        color: var(--text-sub);
        font-size: 11px;
    }

    .toast {
        position: fixed;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%) translateY(20px);
        padding: 9px 16px;
        border-radius: 999px;
        border: 1px solid rgba(255, 91, 80, 0.24);
        background: rgba(16, 19, 24, 0.96);
        color: #fff;
        font-size: 11px;
        box-shadow: 0 16px 32px rgba(0, 0, 0, 0.24);
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s ease;
    }
    .toast.show {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }
    @keyframes shimmer {
        from { background-position: 0 0, -220px 0; }
        to { background-position: 0 0, calc(100% + 220px) 0; }
    }
    @keyframes pulseDot {
        0%, 100% { transform: scale(1); opacity: 0.82; }
        50% { transform: scale(1.25); opacity: 1; }
    }

    @media (max-width: 560px) {
        .header {
            margin: 10px 10px 8px;
            padding: 16px;
            grid-template-columns: 1fr;
        }
        .header-identity {
            max-width: none;
        }
        .header-title {
            font-size: 19px;
        }
        .identity-top {
            flex-direction: column;
            align-items: flex-start;
        }
        .identity-bottom {
            flex-direction: column;
            align-items: flex-start;
        }
        .content {
            padding: 0 10px 14px;
        }
        .toolbar {
            flex-direction: column;
            align-items: stretch;
        }
        .toolbar-main {
            grid-template-columns: 1fr;
        }
        .toolbar-actions {
            width: 100%;
            justify-content: stretch;
        }
        .toolbar-actions .btn {
            flex: 1;
        }
        .grid {
            grid-template-columns: 1fr;
        }
        #basicSection.show,
        #advancedSection.show {
            grid-template-columns: 1fr;
        }
    }
</style>
</head>
<body>
    <div class="header glass-panel">
        <div class="header-left">
            <div class="header-brand-row">
                <div class="header-brand">腾轩旅游集团</div>
                <div class="header-dot"></div>
                <div class="header-caption">统一监控面板</div>
            </div>
            <div class="header-title">AI Token 监控</div>
            <div class="header-subline">本地采集、自动上报、统一汇总。</div>
            <div class="header-author">Powered by Zhi.Chen</div>
        </div>
        <div class="header-identity${cfgData.userName ? '' : ' empty'}${stats.totalFailed > 0 ? ' offline' : ''}" id="headerIdentity" data-section="basic" title="点击修改基础设置">
            <div class="identity-kicker">当前身份</div>
            <div class="identity-top">
                <div class="identity-name" id="displayName">${this.esc(cfgData.userName || '未绑定身份')}</div>
                <div class="user-status${stats.totalFailed > 0 ? ' error' : ''}" id="statusDot">${stats.totalFailed > 0 ? '离线' : '在线'}</div>
            </div>
            <div class="identity-bottom">
                <div class="identity-details">
                    <div class="identity-pill${cfgData.department ? '' : ' is-empty'}" id="identityDeptPill">
                        <span class="identity-pill-label">部门</span>
                        <span class="identity-pill-value" id="identityDept">${this.esc(cfgData.department || '未填写')}</span>
                    </div>
                    <div class="identity-pill${cfgData.userId ? '' : ' is-empty'}" id="identityUserIdPill">
                        <span class="identity-pill-label">工号</span>
                        <span class="identity-pill-value" id="identityUserId">${this.esc(cfgData.userId || '未填写')}</span>
                    </div>
                </div>
                <div class="identity-hint" id="identityHint">${cfgData.userName ? '点击修改基础设置' : '点击填写基础设置'}</div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="toolbar glass-panel">
            <div class="toolbar-main">
                <div class="toolbar-item">
                    <div class="toolbar-label">上报地址</div>
                    <div class="toolbar-value" id="serverAddress" title="${this.esc(cfgData.serverUrl || '未配置上报地址')}">${this.esc(cfgData.serverUrl || '未配置上报地址')}</div>
                </div>
                <div class="toolbar-item">
                    <div class="toolbar-label">监控代理</div>
                    <div class="proxy-control">
                        <div>
                            <div class="proxy-summary">
                                <div class="proxy-dot" id="proxyDot"></div>
                                <span class="proxy-status-text" id="proxyStatus">检测中…</span>
                            </div>
                            <div class="proxy-hint" id="proxyHint">启动后若收到重载提示，请立即重载窗口。</div>
                            <button class="proxy-reload-btn hidden" id="proxyReloadBtn" type="button">立即重载窗口</button>
                        </div>
                        <button class="btn-proxy" id="proxyBtn" type="button">启动</button>
                    </div>
                </div>
            </div>
            <div class="toolbar-actions">
                <div class="refresh-meta" id="refreshMeta">等待同步</div>
                <button class="btn btn-secondary refresh-btn" id="refreshBtn" type="button">刷新数据</button>
            </div>
        </div>

        <div class="diagnostic-panel glass-panel">
            <div class="diagnostic-head">
                <div>
                    <div class="diagnostic-title">一键检查</div>
                    <div class="diagnostic-caption">检查当前配置、本地代理、服务端连通性和最近代理日志，定位为什么没有 Token 上报。</div>
                </div>
                <button class="btn btn-secondary diagnostic-btn" id="diagnosticBtn" type="button">一键检查</button>
            </div>
            <div class="diagnostic-summary" id="diagnosticSummary">点“一键检查”后，会直接告诉你最可能的问题位置。</div>
            <div class="diagnostic-list" id="diagnosticList"></div>
            <div class="diagnostic-logs-wrap hidden" id="diagnosticLogsWrap">
                <div class="diagnostic-logs-title">最近代理日志</div>
                <pre class="diagnostic-logs" id="diagnosticLogs"></pre>
            </div>
        </div>

        <div class="grid">
            <div class="card glass-panel">
                <div class="card-title">今日 Tokens</div>
                <div class="card-value tokens" id="todayTokens">${stats.todayTokens.toLocaleString()}</div>
                <div class="card-note">显示当前身份的当日统计，点击刷新会重新同步服务端数据。</div>
            </div>
            <div class="card glass-panel">
                <div class="card-title">今日请求</div>
                <div class="card-value requests" id="todayRequests">${stats.todayRequests}</div>
                <div class="card-note">仅统计当前工号当天请求数，不再混入其他员工的汇总。</div>
            </div>
        </div>

        <div class="section-stack">
            <div class="section-block glass-panel">
                <div class="section-title" id="basicToggle" data-section="basic">
                    <div class="section-copy">
                        <div class="section-heading">基础设置</div>
                        <div class="section-caption">配置上报地址、姓名、工号与部门信息</div>
                    </div>
                    <span class="arrow" id="basicArrow">▶</span>
                </div>
                <div class="config-section" id="basicSection">
                    <div class="field field-span-2">
                        <label>上报地址</label>
                        <input id="cfgServer" type="text" data-key="serverUrl" value="${this.esc(cfgData.serverUrl)}" placeholder="例如：http://192.168.0.135:8000" />
                    </div>
                    <div class="field">
                        <label>工号</label>
                        <input id="cfgUserId" type="text" data-key="userId" value="${this.esc(cfgData.userId)}" placeholder="例如：10001" />
                    </div>
                    <div class="field">
                        <label>姓名</label>
                        <input id="cfgUserName" type="text" data-key="userName" value="${this.esc(cfgData.userName)}" placeholder="例如：张三" />
                    </div>
                    <div class="field field-span-2">
                        <label>部门</label>
                        <input id="cfgDept" type="text" data-key="department" value="${this.esc(cfgData.department)}" placeholder="例如：公共技术部" />
                    </div>
                    <div class="identity-check-panel subtle field-span-2" id="identityCheckPanel">
                        <div id="identityCheckText">填写工号和姓名后会自动检查是否与服务器已有身份冲突。同一工号可在 VS Code、Cursor、PowerShell 等多个应用共用。</div>
                    </div>
                </div>
            </div>

            <div class="section-block glass-panel">
                <div class="section-title" id="advancedToggle" data-section="advanced">
                    <div class="section-copy">
                        <div class="section-heading">高级设置</div>
                        <div class="section-caption">Copilot 组织与本地凭据管理</div>
                    </div>
                    <span class="arrow" id="advancedArrow">▶</span>
                </div>
                <div class="config-section" id="advancedSection">
                    <div class="field">
                        <label>Copilot 组织</label>
                        <input id="cfgCopilotOrg" type="text" data-key="copilotOrg" value="${this.esc(cfgData.copilotOrg)}" placeholder="例如：your-org" />
                    </div>
                    <div class="field">
                        <label>GitHub PAT（可选）</label>
                        <input id="cfgCopilotPat" type="password" placeholder="例如：ghp_xxxx..." />
                    </div>
                    <div class="info-note field-span-2">
                        监控数据通过本地代理采集并上报。<br>
                        PAT 仅保存在本机 SecretStorage，不会显示在面板中。
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="toast" id="toast"></div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let isRefreshInFlight = false;
    let manualRefreshPending = false;
    let diagnosticsInFlight = false;
    let diagnosticsAcked = false;
    let diagnosticsStartedAt = 0;
    let diagnosticsAckTimeout = 0;
    let refreshTimeout;

    function vscMsg(type, data) {
        vscode.postMessage({ type, ...data });
    }

    function formatRefreshTime() {
        return new Date().toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function updateRefreshMeta(text, refreshing) {
        const meta = document.getElementById('refreshMeta');
        if (!meta) return;
        meta.textContent = text;
        meta.classList.toggle('is-refreshing', Boolean(refreshing));
    }

    function setCardRefreshState(refreshing) {
        document.querySelectorAll('.grid .card').forEach(card => {
            card.classList.toggle('is-refreshing', Boolean(refreshing));
        });
    }

    function beginRefreshFeedback(manual) {
        isRefreshInFlight = true;
        manualRefreshPending = Boolean(manual);
        const btn = document.getElementById('refreshBtn');
        if (btn) {
            btn.disabled = true;
            btn.classList.add('is-loading');
            btn.textContent = '刷新中';
        }
        setCardRefreshState(true);
        updateRefreshMeta('正在同步最新数据…', true);
        clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(() => {
            if (!isRefreshInFlight) return;
            isRefreshInFlight = false;
            manualRefreshPending = false;
            setCardRefreshState(false);
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('is-loading');
                btn.textContent = '刷新数据';
            }
            updateRefreshMeta('同步超时，请重试', false);
            showToast('刷新超时');
        }, 15000);
    }

    function finishRefreshFeedback() {
        clearTimeout(refreshTimeout);
        const btn = document.getElementById('refreshBtn');
        const wasManualRefresh = manualRefreshPending;
        isRefreshInFlight = false;
        manualRefreshPending = false;
        setCardRefreshState(false);
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btn.textContent = '刷新数据';
        }
        updateRefreshMeta('上次同步 ' + formatRefreshTime(), false);
        if (wasManualRefresh) {
            showToast('数据已刷新');
        }
    }

    function triggerManualRefresh() {
        if (isRefreshInFlight) return;
        beginRefreshFeedback(true);
        vscMsg('refresh');
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setDiagnosticsLoading(loading) {
        diagnosticsInFlight = Boolean(loading);
        diagnosticsStartedAt = diagnosticsInFlight ? Date.now() : 0;
        const btn = document.getElementById('diagnosticBtn');
        const summary = document.getElementById('diagnosticSummary');
        if (btn) {
            btn.disabled = diagnosticsInFlight;
            btn.classList.toggle('is-loading', diagnosticsInFlight);
            btn.textContent = diagnosticsInFlight ? '检查中' : '一键检查';
        }
        if (summary && diagnosticsInFlight) {
            summary.className = 'diagnostic-summary checking';
            summary.textContent = '正在检查本地配置、服务端连接和代理运行状态…';
        }
    }

    let diagnosticsTimeout = 0;

    function runDiagnostics() {
        if (diagnosticsInFlight) return;
        diagnosticsAcked = false;
        setDiagnosticsLoading(true);
        clearTimeout(diagnosticsAckTimeout);
        diagnosticsAckTimeout = setTimeout(() => {
            if (!diagnosticsInFlight || diagnosticsAcked) return;
            setDiagnosticsLoading(false);
            const summary = document.getElementById('diagnosticSummary');
            if (summary) {
                summary.className = 'diagnostic-summary error';
                summary.textContent = '未收到扩展响应，诊断消息可能未送达。请重载窗口后重试。';
            }
            showToast('诊断通道异常');
        }, 3000);
        clearTimeout(diagnosticsTimeout);
        diagnosticsTimeout = setTimeout(() => {
            if (!diagnosticsInFlight) return;
            setDiagnosticsLoading(false);
            const summary = document.getElementById('diagnosticSummary');
            if (summary) {
                summary.className = 'diagnostic-summary error';
                summary.textContent = '诊断请求超时。请确认上报地址可访问，并重载窗口后重试。';
            }
            showToast('一键检查超时');
        }, 15000);
        vscMsg('runDiagnostics');
    }

    function renderDiagnostics(report) {
        clearTimeout(diagnosticsAckTimeout);
        clearTimeout(diagnosticsTimeout);
        const summary = document.getElementById('diagnosticSummary');
        const list = document.getElementById('diagnosticList');
        const logsWrap = document.getElementById('diagnosticLogsWrap');
        const logs = document.getElementById('diagnosticLogs');
        setDiagnosticsLoading(false);
        if (!summary || !list || !logsWrap || !logs) return;

        summary.className = 'diagnostic-summary ' + (report?.summary || 'warn');
        summary.textContent = report?.headline || '未拿到诊断结果，请稍后重试。';

        const checks = Array.isArray(report?.checks) ? report.checks : [];
        list.innerHTML = checks.map(item => {
            const status = item?.status || 'info';
            const badgeText = status === 'ok' ? '正常' : status === 'warn' ? '注意' : status === 'error' ? '异常' : '信息';
            return '<div class="diagnostic-item ' + status + '">' +
                '<div class="diagnostic-badge">' + badgeText + '</div>' +
                '<div>' +
                    '<div class="diagnostic-item-title">' + escapeHtml(item?.label || '检查项') + '</div>' +
                    '<div class="diagnostic-item-detail">' + escapeHtml(item?.detail || '') + '</div>' +
                '</div>' +
            '</div>';
        }).join('');

        const recentLogs = Array.isArray(report?.recentLogs) ? report.recentLogs : [];
        logsWrap.classList.toggle('hidden', recentLogs.length === 0);
        logs.textContent = recentLogs.join('\n');
    }

    function toggleSection(id) {
        const sec = document.getElementById(id + 'Section');
        const arr = document.getElementById(id + 'Arrow');
        if (!sec || !arr) return;
        if (sec.classList.contains('show')) {
            sec.classList.remove('show');
            arr.classList.remove('open');
        } else {
            sec.classList.add('show');
            arr.classList.add('open');
        }
    }

    function toggleProxy() {
        const btn = document.getElementById('proxyBtn');
        const status = document.getElementById('proxyStatus');
        if (!btn || !status) return;
        const running = btn.classList.contains('is-active') || status.textContent.startsWith('运行中');
        if (running) {
            vscMsg('stopProxy');
        } else {
            vscMsg('startProxy');
        }
        btn.disabled = true;
    }

    function reloadWindow() {
        vscode.postMessage({ type: 'reloadWindow' });
    }

    function bindUiActions() {
        document.querySelectorAll('[data-section]').forEach(el => {
            if (el.dataset.boundClick === '1') return;
            el.dataset.boundClick = '1';
            el.addEventListener('click', () => {
                const sectionId = el.getAttribute('data-section');
                if (sectionId) {
                    toggleSection(sectionId);
                }
            });
        });

        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn && refreshBtn.dataset.boundClick !== '1') {
            refreshBtn.dataset.boundClick = '1';
            refreshBtn.addEventListener('click', triggerManualRefresh);
        }

        const diagnosticBtn = document.getElementById('diagnosticBtn');
        if (diagnosticBtn && diagnosticBtn.dataset.boundClick !== '1') {
            diagnosticBtn.dataset.boundClick = '1';
            diagnosticBtn.addEventListener('click', runDiagnostics);
        }

        const proxyBtn = document.getElementById('proxyBtn');
        if (proxyBtn && proxyBtn.dataset.boundClick !== '1') {
            proxyBtn.dataset.boundClick = '1';
            proxyBtn.addEventListener('click', toggleProxy);
        }

        const reloadBtn = document.getElementById('proxyReloadBtn');
        if (reloadBtn && reloadBtn.dataset.boundClick !== '1') {
            reloadBtn.dataset.boundClick = '1';
            reloadBtn.addEventListener('click', reloadWindow);
        }
    }

    let saveTimer;
    function scheduleAutoSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(doSave, 800);
    }

    function doSave() {
        try {
            const data = {};
            document.querySelectorAll('.config-section input[data-key]').forEach(el => {
                if (el.type === 'checkbox') data[el.getAttribute('data-key')] = el.checked;
                else data[el.getAttribute('data-key')] = el.value.trim();
            });
            vscode.postMessage({ type: 'saveConfig', data });
        } catch (error) {
            showToast('保存配置失败');
            console.error('[dashboard] save config error:', error);
        }
    }

    function setIdentityInputsState(level) {
        const userIdInput = document.getElementById('cfgUserId');
        const userNameInput = document.getElementById('cfgUserName');
        [userIdInput, userNameInput].forEach(input => {
            if (!input) return;
            input.classList.remove('input-warning', 'input-error');
            if (level === 'warning') input.classList.add('input-warning');
            if (level === 'error') input.classList.add('input-error');
        });
    }

    function updateIdentityCheck(data) {
        const panel = document.getElementById('identityCheckPanel');
        const text = document.getElementById('identityCheckText');
        const hintEl = document.getElementById('identityHint');
        const cfgUserNameEl = document.getElementById('cfgUserName');
        const hasUserName = cfgUserNameEl ? cfgUserNameEl.value.trim() : '';
        if (!panel || !text) return;

        panel.className = 'identity-check-panel field-span-2';
        const status = data?.status || 'incomplete';
        text.textContent = data?.message || '填写工号和姓名后会自动检查是否与服务器已有身份冲突。';

        if (status === 'matched' || status === 'new') {
            panel.classList.add('ok');
            setIdentityInputsState('ok');
            if (hintEl && hasUserName) {
                hintEl.textContent = '身份已校验，可多应用共用';
            }
            return;
        }

        if (status === 'warning') {
            panel.classList.add('warning');
            setIdentityInputsState('warning');
            if (hintEl && hasUserName) {
                hintEl.textContent = '请确认工号信息';
            }
            return;
        }

        if (status === 'conflict') {
            panel.classList.add('error');
            setIdentityInputsState('error');
            if (hintEl) {
                hintEl.textContent = '工号冲突，请修改基础设置';
            }
            return;
        }

        if (status === 'checking') {
            panel.classList.add('checking');
        } else {
            panel.classList.add('subtle');
        }
        setIdentityInputsState('ok');
        if (hintEl && !hasUserName) {
            hintEl.textContent = '点击填写基础设置';
        } else if (hintEl) {
            hintEl.textContent = '点击修改基础设置';
        }
    }

    function markIdentityCheckPending(dataKey) {
        if (!['serverUrl', 'userId', 'userName', 'department'].includes(dataKey || '')) {
            return;
        }
        updateIdentityCheck({
            status: 'checking',
            message: '身份信息已修改，正在自动保存并检查。若工号已存在且姓名一致，可继续在多个应用共用。'
        });
    }

    document.querySelectorAll('.config-section input[data-key]').forEach(el => {
        el.addEventListener('input', function() {
            markIdentityCheckPending(this.getAttribute('data-key'));
            scheduleAutoSave();
        });
    });

    const cfgServerEl = document.getElementById('cfgServer');
    if (cfgServerEl) {
        cfgServerEl.addEventListener('input', function() {
            updateServerAddress(this.value.trim());
        });
    }

    const patInput = document.getElementById('cfgCopilotPat');
    if (patInput) {
        patInput.addEventListener('change', () => {
            const val = patInput.value.trim();
            if (val) vscode.postMessage({ type: 'savePat', pat: val });
        });
    }

    bindUiActions();

    function showToast(text) {
        const t = document.getElementById('toast');
        t.textContent = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    function updateServerAddress(url) {
        const serverAddress = document.getElementById('serverAddress');
        if (!serverAddress) return;
        const value = (url || '').trim();
        serverAddress.textContent = value || '未配置上报地址';
        serverAddress.title = value || '未配置上报地址';
    }

    function updateUserCard(cfg) {
        const identity = document.getElementById('headerIdentity');
        const nameEl = document.getElementById('displayName');
        const deptEl = document.getElementById('identityDept');
        const userIdEl = document.getElementById('identityUserId');
        const deptPillEl = document.getElementById('identityDeptPill');
        const userIdPillEl = document.getElementById('identityUserIdPill');
        const hintEl = document.getElementById('identityHint');
        if (!identity || !nameEl || !deptEl || !userIdEl || !deptPillEl || !userIdPillEl || !hintEl) {
            return;
        }
        if (cfg.userName) {
            identity.classList.remove('empty');
            nameEl.textContent = cfg.userName;
            deptEl.textContent = cfg.department || '未填写';
            userIdEl.textContent = cfg.userId || '未填写';
            deptPillEl.classList.toggle('is-empty', !cfg.department);
            userIdPillEl.classList.toggle('is-empty', !cfg.userId);
            hintEl.textContent = '点击修改基础设置';
        } else {
            identity.classList.add('empty');
            nameEl.textContent = '未绑定身份';
            deptEl.textContent = cfg.department || '未填写';
            userIdEl.textContent = cfg.userId || '未填写';
            deptPillEl.classList.toggle('is-empty', !cfg.department);
            userIdPillEl.classList.toggle('is-empty', !cfg.userId);
            hintEl.textContent = '点击填写基础设置';
        }
    }

    function updateBreakdown(elementId, data) {
        const el = document.getElementById(elementId);
        if (!el || !data) return;
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, e) => sum + e[1], 0);
        if (entries.length === 0) {
            el.innerHTML = '<div class="empty-state">暂无数据</div>';
            return;
        }
        el.innerHTML = entries.map(([key, value]) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return '<div class="breakdown-row">' +
                '<div class="breakdown-top">' +
                    '<span class="breakdown-label">' + key + '</span>' +
                    '<span class="breakdown-value">' + value.toLocaleString() + ' <span style="opacity:0.65;margin-left:6px;">' + pct + '%</span></span>' +
                '</div>' +
                '<div class="breakdown-bar"><div class="breakdown-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        }).join('');
    }

    window.addEventListener('message', event => {
        try {
            const msg = event.data;
            if (msg.type === 'update') {
                const todayTokensEl = document.getElementById('todayTokens');
                const todayRequestsEl = document.getElementById('todayRequests');
                const dot = document.getElementById('statusDot');
                const identity = document.getElementById('headerIdentity');
                if (todayTokensEl) todayTokensEl.textContent = Number(msg.data.todayTokens || 0).toLocaleString();
                if (todayRequestsEl) todayRequestsEl.textContent = String(msg.data.todayRequests || 0);
                finishRefreshFeedback();
                const hasError = Number(msg.data.totalFailed || 0) > 0;
                if (dot) {
                    dot.className = hasError ? 'user-status error' : 'user-status';
                    dot.textContent = hasError ? '离线' : '在线';
                }
                if (identity) {
                    if (hasError) {
                        identity.classList.add('offline');
                    } else {
                        identity.classList.remove('offline');
                    }
                }

                if (msg.data.breakdown) {
                    updateBreakdown('appBreakdown', msg.data.breakdown.apps);
                    updateBreakdown('modelBreakdown', msg.data.breakdown.models);
                    updateBreakdown('sourceBreakdown', msg.data.breakdown.sources);
                }
            }

            if (msg.type === 'configSaved') {
                showToast('已自动保存');
                const cfgUserNameEl = document.getElementById('cfgUserName');
                const cfgUserIdEl = document.getElementById('cfgUserId');
                const cfgDeptEl = document.getElementById('cfgDept');
                const cfg = {
                    userName: cfgUserNameEl ? cfgUserNameEl.value.trim() : '',
                    userId: cfgUserIdEl ? cfgUserIdEl.value.trim() : '',
                    department: cfgDeptEl ? cfgDeptEl.value.trim() : ''
                };
                updateUserCard(cfg);
                const srvEl = document.getElementById('cfgServer');
                if (srvEl) {
                    updateServerAddress(srvEl.value.trim());
                }
            }

            if (msg.type === 'patSaved') {
                showToast('PAT 已保存');
            }

            if (msg.type === 'configUpdated') {
                const cfgServerEl = document.getElementById('cfgServer');
                const cfgUserIdEl = document.getElementById('cfgUserId');
                const cfgUserNameEl = document.getElementById('cfgUserName');
                const cfgDeptEl = document.getElementById('cfgDept');
                const cfgCopilotOrgEl = document.getElementById('cfgCopilotOrg');
                if (cfgServerEl) cfgServerEl.value = msg.data.serverUrl || '';
                if (cfgUserIdEl) cfgUserIdEl.value = msg.data.userId || '';
                if (cfgUserNameEl) cfgUserNameEl.value = msg.data.userName || '';
                if (cfgDeptEl) cfgDeptEl.value = msg.data.department || '';
                if (cfgCopilotOrgEl) cfgCopilotOrgEl.value = msg.data.copilotOrg || '';
                updateUserCard(msg.data || {});
                updateServerAddress((msg.data && msg.data.serverUrl) || '');
            }

            if (msg.type === 'identityStatus') {
                updateIdentityCheck(msg.data);
            }

            if (msg.type === 'proxyStatus') {
                const status = document.getElementById('proxyStatus');
                const btn = document.getElementById('proxyBtn');
                const dot = document.getElementById('proxyDot');
                const hint = document.getElementById('proxyHint');
                const reloadBtn = document.getElementById('proxyReloadBtn');
                const running = Boolean(msg.data.proxyRunning);
                const reloadRequired = Boolean(msg.data.reloadRequired);
                if (status) {
                    status.textContent = reloadRequired
                        ? (running ? '运行中，待重载' : '待重载')
                        : (running ? '运行中' : '未启动');
                    status.classList.toggle('pending', reloadRequired);
                }
                if (btn) {
                    btn.textContent = running ? '停止' : '启动';
                    btn.disabled = false;
                    btn.classList.toggle('is-active', running);
                }
                if (dot) {
                    if (running) { dot.classList.add('on'); } else { dot.classList.remove('on'); }
                    dot.classList.toggle('pending', reloadRequired);
                }
                if (hint) {
                    hint.textContent = reloadRequired
                        ? '当前窗口还没有重载，Copilot / AI 请求可能仍走旧连接，所以暂时不会进入 Token 上报。'
                        : (running
                            ? '监控代理已运行，新的 AI 请求会通过本地监控链路上报。'
                            : '监控代理未启动；启动后若收到重载提示，请立即重载窗口。');
                    hint.classList.toggle('warning', reloadRequired);
                }
                if (reloadBtn) {
                    reloadBtn.classList.toggle('hidden', !reloadRequired);
                }
            }

            if (msg.type === 'diagnosticsResult') {
                renderDiagnostics(msg.data);
            }

            if (msg.type === 'diagnosticsAck') {
                diagnosticsAcked = true;
                clearTimeout(diagnosticsAckTimeout);
            }
        } catch (error) {
            setDiagnosticsLoading(false);
            showToast('面板渲染异常，已自动恢复');
            console.error('[dashboard] message handler error:', error);
        }
    });

    setInterval(() => {
        if (!diagnosticsInFlight || !diagnosticsStartedAt) {
            return;
        }
        if (Date.now() - diagnosticsStartedAt > 20000) {
            setDiagnosticsLoading(false);
            const summary = document.getElementById('diagnosticSummary');
            if (summary) {
                summary.className = 'diagnostic-summary error';
                summary.textContent = '诊断等待超时，可能是面板通信异常。请重载窗口后重试。';
            }
            showToast('诊断已超时，已解除卡住状态');
        }
    }, 1000);

    window.addEventListener('error', () => {
        setDiagnosticsLoading(false);
    });

    window.addEventListener('unhandledrejection', () => {
        setDiagnosticsLoading(false);
    });
</script>
</body>
</html>`;
    }
}

