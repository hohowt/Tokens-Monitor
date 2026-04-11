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

interface UpdateCheckResultData {
    status: string;
    message: string;
    version?: string;
    currentVersion?: string;
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
        private readonly extensionVersion: string = '0.0.0',
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
            } else if (msg.type === 'changeDays') {
                const days = Number(msg.days) || 1;
                this.selectedDays = days;
                this.tracker.setSelectedDays(days);
                await this.refreshDashboard();
            } else if (msg.type === 'checkUpdate') {
                this.view?.webview.postMessage({ type: 'updateCheckState', data: { checking: true } });
                try {
                    const result = await vscode.commands.executeCommand<UpdateCheckResultData>('tokenMonitor.checkUpdate');
                    this.view?.webview.postMessage({
                        type: 'updateCheckState',
                        data: { checking: false, result: result ?? { status: 'cancelled', message: '已取消更新。' } }
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : '未知错误';
                    this.view?.webview.postMessage({
                        type: 'updateCheckState',
                        data: { checking: false, result: { status: 'error', message: `检查更新失败：${message}` } }
                    });
                }
            }
        });
    }

    private selectedDays = 1;

    private getStats() {
        const breakdown = this.tracker.getBreakdown();
        return {
            todayTokens: this.tracker.todayTokens,
            todayRequests: this.tracker.todayRequests,
            totalReported: this.tracker.totalReported,
            totalFailed: this.tracker.totalFailed,
            breakdown,
            proxyRunning: false, // will be updated async
            selectedDays: this.selectedDays,
        };
    }

    private async fetchOverview(): Promise<{
        total_tokens: number;
        total_cost_cny: number;
        total_requests: number;
        active_users: number;
        tokens_change_pct: number | null;
        cost_change_pct: number | null;
    } | null> {
        if (!this.config.serverUrl) return null;
        try {
            const url = `${this.config.serverUrl}/api/dashboard/overview?days=${this.selectedDays}`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) return null;
            return await res.json() as {
                total_tokens: number;
                total_cost_cny: number;
                total_requests: number;
                active_users: number;
                tokens_change_pct: number | null;
                cost_change_pct: number | null;
            };
        } catch (e) {
            console.error('[Dashboard] fetchOverview failed:', e);
            return null;
        }
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

    private postStatsUpdate(overview?: {
        total_tokens: number;
        total_cost_cny: number;
        total_requests: number;
        active_users: number;
        tokens_change_pct: number | null;
        cost_change_pct: number | null;
    } | null): void {
        this.view?.webview.postMessage({
            type: 'update',
            data: {
                ...this.getStats(),
                overview: overview || null,
            },
        });
    }

    private postIdentityStatus(data: IdentityStatusData): void {
        this.view?.webview.postMessage({
            type: 'identityStatus',
            data,
        });
    }


    private normalizeValue(value: string | undefined | null): string {
        return (value || '').trim().replace(/\/+$/, '');
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
        const overview = await this.fetchOverview();
        console.log('[Dashboard] overview result:', overview ? `tokens=${overview.total_tokens} requests=${overview.total_requests}` : 'null');
        this.postStatsUpdate(overview);
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
        --panel-elevated: rgba(20, 24, 33, 0.92);
        --panel-muted: rgba(255, 255, 255, 0.03);
        --border: rgba(255, 255, 255, 0.08);
        --border-strong: rgba(255, 255, 255, 0.14);
        --text-main: #edf1f7;
        --text-sub: #98a0b2;
        --accent: #ff5b50;
        --accent-strong: #ff875f;
        --accent-glow: rgba(255, 91, 80, 0.22);
        --accent-soft: rgba(255, 91, 80, 0.08);
        --blue-glow: rgba(107, 163, 255, 0.22);
        --green-glow: rgba(56, 217, 139, 0.2);
        --amber-glow: rgba(255, 184, 77, 0.22);
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
            radial-gradient(circle at top left, rgba(255, 91, 80, 0.18), transparent 28%),
            radial-gradient(circle at 82% 2%, rgba(74, 134, 255, 0.13), transparent 24%),
            radial-gradient(circle at 50% 100%, rgba(255, 184, 77, 0.08), transparent 30%),
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
            linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.015)),
            linear-gradient(180deg, rgba(26, 31, 43, 0.96), rgba(18, 23, 31, 0.96));
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 18px;
        box-shadow: 0 18px 38px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.04);
        backdrop-filter: blur(18px);
    }

    .header {
        position: relative;
        overflow: hidden;
        margin: 14px 12px 10px;
        padding: 20px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(240px, 280px);
        gap: 16px;
        align-items: start;
        background:
            linear-gradient(135deg, rgba(255, 91, 80, 0.12), rgba(255, 255, 255, 0.03) 44%, rgba(74, 134, 255, 0.1) 100%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent);
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
        padding: 15px 16px 13px;
        border-radius: 20px;
        background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.015)),
            rgba(10, 14, 20, 0.42);
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        gap: 10px;
        box-shadow: 0 16px 26px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.04);
        cursor: pointer;
        transition: border-color 0.2s ease, transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    }
    .header-identity:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 255, 255, 0.18);
        background: rgba(15, 20, 28, 0.52);
        box-shadow: 0 20px 28px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05);
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
        width: 86px;
        height: 4px;
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
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 0.01em;
        color: #fff;
        margin-top: 12px;
    }
    .header-subline {
        margin-top: 8px;
        max-width: 380px;
        font-size: 12px;
        line-height: 1.5;
        color: rgba(220, 227, 239, 0.74);
    }
    .header-author {
        margin-top: 10px;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.54);
        font-family: var(--font-mono);
    }
    .header-version {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .header-version .version-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        font-family: var(--font-mono);
    }
    .header-version .btn-update {
        padding: 2px 8px;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.6);
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.2s;
    }
    .header-version .btn-update:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.25);
    }
    .header-version .btn-update.is-loading {
        pointer-events: none;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 91, 80, 0.14);
        border-color: rgba(255, 91, 80, 0.32);
    }
    .header-version .btn-update.is-loading::before {
        content: '';
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 6px;
        vertical-align: -1px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: rgba(255, 255, 255, 0.92);
        animation: spin 0.75s linear infinite;
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
        padding: 0 12px 18px;
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
        align-items: stretch;
        justify-content: space-between;
        gap: 14px;
        padding: 14px;
    }
    .toolbar-main {
        flex: 1;
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0;
    }
    .toolbar-item {
        min-width: 0;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.012)),
            rgba(255, 255, 255, 0.015);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
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
        font-weight: 600;
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
        min-height: 88px;
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
        min-width: 72px;
        padding: 9px 14px;
        font-size: 11px;
        font-weight: 700;
        color: var(--text-main);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--border-strong);
        cursor: pointer;
        border-radius: 12px;
        transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, color 0.2s ease;
        flex-shrink: 0;
    }
    .btn-proxy:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.07);
        border-color: rgba(255, 255, 255, 0.22);
        box-shadow: 0 10px 16px rgba(0, 0, 0, 0.16);
    }
    .btn-proxy.is-active {
        color: rgba(223, 255, 238, 0.96);
        border-color: rgba(56, 217, 139, 0.24);
        background: linear-gradient(135deg, rgba(56, 217, 139, 0.16), rgba(56, 217, 139, 0.08));
        box-shadow: 0 10px 18px rgba(56, 217, 139, 0.12);
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
        align-items: stretch;
        justify-content: center;
        gap: 8px;
        flex-shrink: 0;
        padding: 10px 12px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.015);
        min-width: 148px;
    }
    .refresh-meta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 16px;
        font-size: 11px;
        color: var(--text-sub);
        white-space: nowrap;
        justify-content: flex-start;
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
        background: rgba(255, 255, 255, 0.05);
        border-color: var(--border-strong);
    }
    .btn-secondary:hover {
        border-color: rgba(255, 255, 255, 0.24);
        background: rgba(255, 255, 255, 0.08);
        box-shadow: 0 10px 16px rgba(0, 0, 0, 0.16);
    }
    .refresh-btn {
        width: 100%;
        min-width: 120px;
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

    .date-range-bar {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin: 14px 0 12px;
        padding: 8px;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
            linear-gradient(135deg, rgba(255, 91, 80, 0.08), rgba(107, 163, 255, 0.06)),
            rgba(255, 255, 255, 0.03);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .date-btn {
        min-width: 0;
        padding: 10px 8px !important;
        border: 1px solid transparent !important;
        border-radius: 12px !important;
        background: rgba(255, 255, 255, 0.01) !important;
        color: rgba(214, 221, 234, 0.72) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        transition: transform 0.18s ease, background 0.22s ease, color 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease !important;
        text-align: center !important;
        letter-spacing: 0.04em !important;
        box-shadow: none !important;
        outline: none !important;
        line-height: 1.4 !important;
        min-height: 40px !important;
    }
    .date-btn:hover {
        background: rgba(255, 255, 255, 0.06) !important;
        border-color: rgba(255, 255, 255, 0.08) !important;
        color: #edf1f7 !important;
        transform: translateY(-1px);
    }
    .date-btn.active {
        background: linear-gradient(135deg, rgba(255, 91, 80, 0.28), rgba(255, 135, 95, 0.18)) !important;
        border-color: rgba(255, 135, 95, 0.26) !important;
        color: #fff3ee !important;
        font-weight: 700 !important;
        box-shadow: 0 10px 24px rgba(255, 91, 80, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    }

    .stats-panel {
        padding: 0;
    }
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        width: 100%;
        padding: 14px;
        align-items: stretch;
    }
    .stat-item {
        position: relative;
        min-width: 0;
        min-height: 102px;
        padding: 15px 16px 16px;
        box-sizing: border-box;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.02)),
            rgba(8, 12, 18, 0.28);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        overflow: hidden;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .stat-item:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 16px 24px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .stat-item::before {
        content: '';
        position: absolute;
        top: 0;
        left: 16px;
        width: 34px;
        height: 3px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(255, 91, 80, 0.95), rgba(255, 184, 77, 0.72));
        box-shadow: 0 0 14px rgba(255, 91, 80, 0.28);
    }
    .stat-item.stat-item-green::before {
        background: linear-gradient(90deg, rgba(56, 217, 139, 0.95), rgba(130, 255, 202, 0.72));
        box-shadow: 0 0 14px var(--green-glow);
    }
    .stat-item.stat-item-amber::before {
        background: linear-gradient(90deg, rgba(255, 184, 77, 0.95), rgba(255, 222, 130, 0.72));
        box-shadow: 0 0 14px var(--amber-glow);
    }
    .stat-item.stat-item-blue::before {
        background: linear-gradient(90deg, rgba(107, 163, 255, 0.95), rgba(155, 198, 255, 0.72));
        box-shadow: 0 0 14px var(--blue-glow);
    }
    .stat-label {
        padding-top: 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: rgba(220, 228, 240, 0.62);
        margin-bottom: 12px;
        line-height: 1.45;
    }
    .stat-num {
        font-family: var(--font-mono);
        font-size: clamp(25px, 5vw, 31px);
        font-weight: 800;
        line-height: 1.05;
        letter-spacing: -0.04em;
        color: #fff;
        transition: opacity 0.2s ease;
        word-break: break-word;
    }
    .stat-num.is-loading { opacity: 0.45; }
    .stat-num.red { color: #ff875f !important; }
    .stat-num.green { color: #38d98b !important; }
    .stat-num.amber { color: #ffb84d !important; }
    .stat-num.blue { color: #6ba3ff !important; }
    .stat-sub {
        margin-top: 4px;
        font-size: 11px;
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
        position: relative;
        transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
    }
    .section-block:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 18px 30px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .section-block.expanded {
        border-color: rgba(255, 91, 80, 0.18);
        box-shadow: 0 18px 30px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(255, 91, 80, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 15px 16px;
        color: var(--text-main);
        cursor: pointer;
        user-select: none;
        transition: background 0.2s ease;
    }
    .section-title:hover {
        background: rgba(255, 255, 255, 0.02);
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
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.01));
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
        letter-spacing: 0.03em;
    }
    .field input {
        width: 100%;
        min-height: 42px;
        padding: 11px 13px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(7, 10, 15, 0.4);
        color: var(--text-main);
        font-size: 13px;
        font-family: var(--font-ui);
        outline: none;
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    }
    .field input:hover {
        border-color: rgba(255, 255, 255, 0.18);
        background: rgba(10, 14, 20, 0.5);
    }
    .field input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(255, 91, 80, 0.14), 0 10px 18px rgba(0, 0, 0, 0.16);
        background: rgba(10, 14, 20, 0.54);
        transform: translateY(-1px);
    }
    .field input::placeholder {
        color: rgba(152, 160, 178, 0.56);
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
        padding: 12px 13px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.035);
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
        padding: 12px 13px;
        border-radius: 16px;
        border: 1px dashed rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.035);
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
        backdrop-filter: blur(16px);
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
        .date-range-bar {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .stats-grid {
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
            <div class="header-version">
                <span class="version-label">v${this.esc(this.extensionVersion)}</span>
                <button class="btn-update" id="checkUpdateBtn" type="button">检查更新</button>
            </div>
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

        <div class="date-range-bar">
            <button class="date-btn active" data-days="1">今日</button>
            <button class="date-btn" data-days="7">近7天</button>
            <button class="date-btn" data-days="15">近15天</button>
            <button class="date-btn" data-days="30">近30天</button>
        </div>

        <div class="stats-panel glass-panel">
            <div class="stats-grid">
                <div class="stat-item stat-item-red">
                    <div class="stat-label" id="tokensTitle">今日 Tokens</div>
                    <div class="stat-num red" id="todayTokens">${stats.todayTokens.toLocaleString()}</div>
                </div>
                <div class="stat-item stat-item-green">
                    <div class="stat-label" id="requestsTitle">今日请求</div>
                    <div class="stat-num green" id="todayRequests">${stats.todayRequests}</div>
                </div>
                <div class="stat-item stat-item-amber">
                    <div class="stat-label" id="costTitle">今日成本</div>
                    <div class="stat-num amber" id="todayCost">¥0.00</div>
                </div>
                <div class="stat-item stat-item-blue">
                    <div class="stat-label" id="usersTitle">活跃用户</div>
                    <div class="stat-num blue" id="activeUsers">0</div>
                </div>
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
                        <input id="cfgServer" type="text" data-key="serverUrl" value="${this.esc(cfgData.serverUrl)}" placeholder="例如：https://otw.tech:59889" />
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
        document.querySelectorAll('.stat-num').forEach(el => {
            el.classList.toggle('is-loading', Boolean(refreshing));
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

    function setUpdateButtonState(checking, result) {
        const btn = document.getElementById('checkUpdateBtn');
        if (!btn) return;
        if (checking) {
            btn.disabled = true;
            btn.classList.add('is-loading');
            btn.textContent = '检查中';
            return;
        }
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.textContent = '检查更新';
        if (result && result.message) {
            showToast(result.message);
        }
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }


    function toggleSection(id) {
        const sec = document.getElementById(id + 'Section');
        const arr = document.getElementById(id + 'Arrow');
        if (!sec || !arr) return;
        const block = sec.closest('.section-block');
        if (sec.classList.contains('show')) {
            sec.classList.remove('show');
            arr.classList.remove('open');
            if (block) block.classList.remove('expanded');
        } else {
            sec.classList.add('show');
            arr.classList.add('open');
            if (block) block.classList.add('expanded');
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

        const checkUpdateBtn = document.getElementById('checkUpdateBtn');
        if (checkUpdateBtn && checkUpdateBtn.dataset.boundClick !== '1') {
            checkUpdateBtn.dataset.boundClick = '1';
            checkUpdateBtn.addEventListener('click', () => {
                if (checkUpdateBtn.disabled) return;
                setUpdateButtonState(true);
                vscMsg('checkUpdate');
            });
        }

        document.querySelectorAll('.date-btn').forEach(btn => {
            if (btn.dataset.boundClick === '1') return;
            btn.dataset.boundClick = '1';
            btn.addEventListener('click', () => {
                const days = parseInt(btn.getAttribute('data-days') || '1', 10);
                document.querySelectorAll('.date-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const label = days === 1 ? '今日' : ('近' + days + '天');
                const tokensTitle = document.getElementById('tokensTitle');
                const requestsTitle = document.getElementById('requestsTitle');
                const costTitle = document.getElementById('costTitle');
                const usersTitle = document.getElementById('usersTitle');
                if (tokensTitle) tokensTitle.textContent = label + ' Tokens';
                if (requestsTitle) requestsTitle.textContent = label + '请求';
                if (costTitle) costTitle.textContent = label + '成本';
                if (usersTitle) usersTitle.textContent = label + '活跃用户';
                beginRefreshFeedback(false);
                vscode.postMessage({ type: 'changeDays', days });
            });
        });
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
                const todayCostEl = document.getElementById('todayCost');
                const activeUsersEl = document.getElementById('activeUsers');
                const dot = document.getElementById('statusDot');
                const identity = document.getElementById('headerIdentity');

                const overview = msg.data.overview;
                const selectedDays = msg.data.selectedDays || 1;
                const label = selectedDays === 1 ? '今日' : ('近' + selectedDays + '天');

                if (overview) {
                    if (todayTokensEl) todayTokensEl.textContent = Number(overview.total_tokens || 0).toLocaleString();
                    if (todayRequestsEl) todayRequestsEl.textContent = Number(overview.total_requests || 0).toLocaleString();
                    if (todayCostEl) todayCostEl.textContent = '¥' + Number(overview.total_cost_cny || 0).toFixed(2);
                    if (activeUsersEl) activeUsersEl.textContent = String(overview.active_users || 0);
                } else {
                    if (todayTokensEl) todayTokensEl.textContent = Number(msg.data.todayTokens || 0).toLocaleString();
                    if (todayRequestsEl) todayRequestsEl.textContent = String(msg.data.todayRequests || 0);
                    if (todayCostEl) todayCostEl.textContent = '¥0.00';
                    if (activeUsersEl) activeUsersEl.textContent = '0';
                }

                const tokensTitle = document.getElementById('tokensTitle');
                const requestsTitle = document.getElementById('requestsTitle');
                const costTitle = document.getElementById('costTitle');
                const usersTitle = document.getElementById('usersTitle');
                if (tokensTitle) tokensTitle.textContent = label + ' Tokens';
                if (requestsTitle) requestsTitle.textContent = label + '请求';
                if (costTitle) costTitle.textContent = label + '成本';
                if (usersTitle) usersTitle.textContent = label + '活跃用户';

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

            if (msg.type === 'updateCheckState') {
                setUpdateButtonState(Boolean(msg.data && msg.data.checking), msg.data && msg.data.result);
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
                            : '监控代理默认关闭；启用时会自动安装当前用户证书，并尽量沿用现有系统或公司代理。');
                    hint.classList.toggle('warning', reloadRequired);
                }
                if (reloadBtn) {
                    reloadBtn.classList.toggle('hidden', !reloadRequired);
                }
            }

        } catch (error) {
            showToast('面板渲染异常，已自动恢复');
            console.error('[dashboard] message handler error:', error);
        }
    });
</script>
</body>
</html>`;
    }
}

