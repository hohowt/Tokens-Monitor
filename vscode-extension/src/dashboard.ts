import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWindowsCertificateTrustStatus, WindowsCertificateTrustStatus } from './certificateTrust';
import { TokenTracker, TrackerRuntimeStatus } from './tokenTracker';
import { MonitorConfig, getConfig } from './config';
import { LocalProxyStatusSnapshot, ProxyEnvironmentDiagnosis, ProxyManager } from './proxyManager';

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
    blocked: boolean;
    blockedReason?: string;
}

interface UpdateCheckResultData {
    status: string;
    message: string;
    version?: string;
    currentVersion?: string;
}

interface LinkCheckItemData {
    id: string;
    title: string;
    status: 'ok' | 'warning' | 'error' | 'neutral' | 'checking';
    summary: string;
    detail?: string;
}

interface LinkCheckData {
    overallStatus: 'ok' | 'warning' | 'error' | 'neutral' | 'checking';
    checkedAt?: string;
    items: LinkCheckItemData[];
}

export class DashboardProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private refreshTimer?: ReturnType<typeof setInterval>;
    private config: MonitorConfig;
    private lastLinkCheck?: { fetchedAt: number; data: LinkCheckData };
    private linkCheckInFlight?: Promise<LinkCheckData>;

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
            } else if (msg.type === 'runLinkCheck') {
                this.postLinkCheck({
                    overallStatus: 'checking',
                    items: [
                        { id: 'local-proxy', title: '本地代理', status: 'checking', summary: '正在检查本地代理与当前路由…' },
                        { id: 'environment', title: '代理环境', status: 'checking', summary: '正在检查当前代理环境与接管策略…' },
                        { id: 'certificate', title: '证书安装', status: 'checking', summary: '正在检查当前用户证书信任状态…' },
                        { id: 'upstream', title: '上游代理', status: 'checking', summary: '正在检查外网转发链路…' },
                        { id: 'reporting', title: '最近上报', status: 'checking', summary: '正在检查最近上报与服务端连通性…' },
                    ],
                });
                await this.refreshLinkCheck(true);
            } else if (msg.type === 'authLogin') {
                await this.handleLogin(msg.data);
            } else if (msg.type === 'authRegister') {
                await this.handleRegister(msg.data);
            } else if (msg.type === 'authSetPassword') {
                await this.handleSetPassword(msg.data);
            } else if (msg.type === 'authLogout') {
                await this.handleLogout();
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
            let url = `${this.config.serverUrl}/api/dashboard/overview?days=${this.selectedDays}`;
            if (this.config.userId) {
                url += `&employee_id=${encodeURIComponent(this.config.userId)}`;
            }
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
            upstreamProxy: this.config.upstreamProxy,
            copilotOrg: this.config.copilotOrg,
            // copilotPat is stored in SecretStorage and never sent to the webview
        };
    }

    private async saveConfig(data: Record<string, unknown>): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('aiTokenMonitor');
        const stringKeys = ['serverUrl', 'userId', 'userName', 'department', 'upstreamProxy', 'copilotOrg'] as const;
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

    // ── Auth handlers ──────────────────────────────────────────

    private async authFetch(endpoint: string, body: Record<string, unknown>): Promise<any> {
        const url = `${this.config.serverUrl}/api/auth/${endpoint}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timer);
            const json = await resp.json().catch(() => ({}));
            return { ok: resp.ok, status: resp.status, data: json };
        } catch {
            clearTimeout(timer);
            return { ok: false, status: 0, data: { detail: '无法连接服务器，请检查上报地址。' } };
        }
    }

    private async applyAuthResult(data: { employee_id: string; name: string; department?: string; auth_token: string }): Promise<void> {
        await this.secrets.store('authToken', data.auth_token);
        this.tracker.setAuthToken(data.auth_token);
        const cfg = vscode.workspace.getConfiguration('aiTokenMonitor');
        await cfg.update('userId', data.employee_id, vscode.ConfigurationTarget.Global);
        await cfg.update('userName', data.name, vscode.ConfigurationTarget.Global);
        await cfg.update('department', data.department ?? '', vscode.ConfigurationTarget.Global);
        this.config = getConfig();
        this.tracker.updateConfig(this.config);
    }

    private async handleLogin(data: { employeeId: string; password: string }): Promise<void> {
        const result = await this.authFetch('login', { employee_id: data.employeeId, password: data.password });
        if (result.ok) {
            await this.applyAuthResult(result.data);
            this.view?.webview.postMessage({ type: 'authSuccess', data: { ...result.data, mode: 'login' } });
            await this.refreshDashboard(true);
        } else if (result.status === 403 && result.data?.detail === 'password_not_set') {
            this.view?.webview.postMessage({ type: 'authNeedSetPassword', data: { employeeId: data.employeeId } });
        } else {
            const msg = result.status === 401 ? '工号或密码错误' : (result.data?.detail ?? '登录失败');
            this.view?.webview.postMessage({ type: 'authError', data: { message: msg } });
        }
    }

    private async handleRegister(data: { name: string; department: string; password: string }): Promise<void> {
        const result = await this.authFetch('register', { name: data.name, department: data.department, password: data.password });
        if (result.ok) {
            await this.applyAuthResult(result.data);
            this.view?.webview.postMessage({ type: 'authSuccess', data: { ...result.data, mode: 'register' } });
            await this.refreshDashboard(true);
        } else {
            const msg = result.data?.detail ?? '注册失败';
            this.view?.webview.postMessage({ type: 'authError', data: { message: msg } });
        }
    }

    private async handleSetPassword(data: { employeeId: string; name: string; password: string }): Promise<void> {
        const result = await this.authFetch('set-password', { employee_id: data.employeeId, name: data.name, password: data.password });
        if (result.ok) {
            await this.applyAuthResult(result.data);
            this.view?.webview.postMessage({ type: 'authSuccess', data: { ...result.data, mode: 'setPassword' } });
            await this.refreshDashboard(true);
        } else {
            const msg = result.status === 403 ? '姓名与服务器记录不匹配' :
                        result.status === 409 ? '该账号已设置过密码，请直接登录' :
                        (result.data?.detail ?? '设置密码失败');
            this.view?.webview.postMessage({ type: 'authError', data: { message: msg } });
        }
    }

    private async handleLogout(): Promise<void> {
        await this.secrets.delete('authToken');
        this.tracker.setAuthToken(undefined);
        const cfg = vscode.workspace.getConfiguration('aiTokenMonitor');
        await cfg.update('userId', '', vscode.ConfigurationTarget.Global);
        await cfg.update('userName', '', vscode.ConfigurationTarget.Global);
        await cfg.update('department', '', vscode.ConfigurationTarget.Global);
        this.config = getConfig();
        this.tracker.updateConfig(this.config);
        this.view?.webview.postMessage({ type: 'authLoggedOut' });
        await this.refreshDashboard();
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

    private postLinkCheck(data: LinkCheckData): void {
        this.view?.webview.postMessage({
            type: 'linkCheck',
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
        // 已登录（有 auth token）时无需检查身份
        const token = await this.secrets.get('authToken');
        if (token && this.config.userId && this.config.userName) {
            return { status: 'matched', message: '已登录认证，身份已确认。' };
        }

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
            const hdrs: Record<string, string> = {};
            if (this.config.apiKey) { hdrs['X-API-Key'] = this.config.apiKey; }
            const authTok = await this.secrets.get('authToken');
            if (authTok) { hdrs['Authorization'] = `Bearer ${authTok}`; }
            const response = await fetch(`${this.config.serverUrl}/api/clients/identity-check?${params.toString()}`, {
                signal: controller.signal,
                headers: hdrs,
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
        const diagnosis = this.proxyManager ? await this.proxyManager.getEnvironmentDiagnosis() : null;
        const reloadRequired = this.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false);
        const blocked = Boolean(this.config.transparentMode && diagnosis && !diagnosis.allowTakeover);
        const blockedReason = blocked && diagnosis
            ? [diagnosis.summary, diagnosis.recommendedAction || diagnosis.detail].filter(Boolean).join(' ')
            : undefined;
        this.view?.webview.postMessage({
            type: 'proxyStatus',
            data: {
                proxyRunning: running,
                reloadRequired,
                blocked,
                blockedReason,
            } satisfies ProxyStatusData,
        });
    }

    private async refreshLinkCheck(force = false): Promise<void> {
        const data = await this.fetchLinkCheck(force);
        this.postLinkCheck(data);
    }

    private async fetchLinkCheck(force = false): Promise<LinkCheckData> {
        const cacheTtlMs = 20_000;
        if (!force && this.lastLinkCheck && (Date.now() - this.lastLinkCheck.fetchedAt) < cacheTtlMs) {
            return this.lastLinkCheck.data;
        }
        if (this.linkCheckInFlight) {
            return this.linkCheckInFlight;
        }

        this.linkCheckInFlight = this.buildLinkCheckData()
            .then(data => {
                this.lastLinkCheck = { fetchedAt: Date.now(), data };
                return data;
            })
            .finally(() => {
                this.linkCheckInFlight = undefined;
            });

        return this.linkCheckInFlight;
    }

    private async buildLinkCheckData(): Promise<LinkCheckData> {
        const [localStatus, serverHealth, diagnosis] = await Promise.all([
            this.proxyManager?.getLocalStatus() ?? Promise.resolve(null),
            this.checkServerHealth(),
            this.proxyManager?.getEnvironmentDiagnosis() ?? Promise.resolve(this.getDefaultDiagnosis()),
        ]);
        const trackerStatus = this.tracker.getRuntimeStatus();
        const items = [
            this.buildLocalProxyItem(localStatus, diagnosis),
            this.buildEnvironmentItem(diagnosis),
            this.buildCertificateItem(),
            this.buildUpstreamItem(localStatus, diagnosis),
            this.buildReportingItem(localStatus, trackerStatus, serverHealth),
        ];

        return {
            overallStatus: this.pickOverallStatus(items),
            checkedAt: new Date().toISOString(),
            items,
        };
    }

    private getDefaultDiagnosis(): ProxyEnvironmentDiagnosis {
        return {
            kind: 'direct',
            level: 'neutral',
            allowTakeover: true,
            summary: '当前未检测到需要特殊处理的代理环境。',
            detail: '如果机器依赖公司代理或桌面代理，请先配置明确的上游代理。',
            detectedDesktopProcesses: [],
            detectedTunAdapters: [],
            checkedAt: new Date().toISOString(),
        };
    }

    private async checkServerHealth(): Promise<{ ok: boolean; detail: string }> {
        if (!this.config.serverUrl.trim()) {
            return { ok: false, detail: '未配置上报地址' };
        }
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`${this.config.serverUrl}/health`, { signal: controller.signal });
            clearTimeout(timer);
            if (!response.ok) {
                return { ok: false, detail: `服务端返回 ${response.status}` };
            }
            return { ok: true, detail: '服务端健康检查正常' };
        } catch (error) {
            return {
                ok: false,
                detail: error instanceof Error ? error.message : '服务端不可达',
            };
        }
    }

    private buildLocalProxyItem(localStatus: LocalProxyStatusSnapshot | null, diagnosis: ProxyEnvironmentDiagnosis): LinkCheckItemData {
        const reloadRequired = this.globalState.get<boolean>(PROXY_RELOAD_PENDING_KEY, false);
        const recentLogs = this.proxyManager?.getRecentOutputLines(3) ?? [];
        if (!this.config.transparentMode) {
            return {
                id: 'local-proxy',
                title: '本地代理',
                status: 'neutral',
                summary: '当前未启用监控代理；只有启用后，Copilot / AI 请求才会经过本地监控链路。',
                detail: '如需开始采集，点击上方“启动”即可。',
            };
        }
        if (!diagnosis.allowTakeover) {
            return {
                id: 'local-proxy',
                title: '本地代理',
                status: 'warning',
                summary: '当前已启用监控代理，但为了保护现有网络环境，本次没有覆盖 VS Code 代理设置。',
                detail: [diagnosis.summary, diagnosis.recommendedAction || diagnosis.detail].filter(Boolean).join(' '),
            };
        }
        if (!localStatus || localStatus.status !== 'running') {
            return {
                id: 'local-proxy',
                title: '本地代理',
                status: 'error',
                summary: '监控代理已启用，但本地 ai-monitor 当前不可用。',
                detail: recentLogs.length > 0 ? recentLogs.join(' | ') : '请检查 Output 面板 AI Token Monitor Proxy。',
            };
        }
        if (reloadRequired) {
            return {
                id: 'local-proxy',
                title: '本地代理',
                status: 'warning',
                summary: `ai-monitor 正在端口 ${localStatus.port || this.config.proxyPort} 运行，但当前窗口仍待重载。`,
                detail: '未重载前，现有 Copilot 连接可能还在走旧链路。',
            };
        }
        return {
            id: 'local-proxy',
            title: '本地代理',
            status: 'ok',
            summary: `ai-monitor 正在端口 ${localStatus.port || this.config.proxyPort} 运行，当前窗口路由已接通。`,
            detail: `版本 ${localStatus.version || '未知'}；本地累计已上报 ${localStatus.stats?.total_reported ?? 0} 条请求。`,
        };
    }

    private buildEnvironmentItem(diagnosis: ProxyEnvironmentDiagnosis): LinkCheckItemData {
        return {
            id: 'environment',
            title: '代理环境',
            status: diagnosis.level,
            summary: diagnosis.summary,
            detail: [diagnosis.detail, diagnosis.recommendedAction].filter(Boolean).join(' '),
        };
    }

    private buildCertificateItem(): LinkCheckItemData {
        const appData = process.env.APPDATA;
        const certPath = appData ? path.join(appData, 'ai-monitor', 'ca.crt') : '';
        const fileExists = certPath ? fs.existsSync(certPath) : false;

        if (process.platform !== 'win32') {
            return {
                id: 'certificate',
                title: '证书安装',
                status: fileExists ? 'warning' : 'neutral',
                summary: fileExists ? '本地 CA 文件已生成；非 Windows 环境需手动确认系统是否已信任。' : '当前平台未提供自动证书检查。',
                detail: certPath || '未找到 CA 文件路径。',
            };
        }

        const trustStatus = this.getWindowsCertificateTrustStatus(certPath, fileExists);
        if (trustStatus.trusted === true) {
            return {
                id: 'certificate',
                title: '证书安装',
                status: 'ok',
                summary: 'AI Monitor Local CA 已安装到当前用户信任存储。',
                detail: trustStatus.trustSource === 'certutil'
                    ? `${certPath}；已通过 certutil 指纹校验确认受信任。`
                    : (fileExists ? certPath : '证书已在系统信任存储中。'),
            };
        }
        if (fileExists) {
            return {
                id: 'certificate',
                title: '证书安装',
                status: 'warning',
                summary: '本地 CA 文件存在，但当前用户信任存储里未检测到受信任证书。',
                detail: trustStatus.detail || certPath,
            };
        }
        return {
            id: 'certificate',
            title: '证书安装',
            status: 'error',
            summary: '未找到本地 CA 证书文件，HTTPS MITM 可能无法正常工作。',
            detail: '启用监控代理时会自动尝试安装当前用户证书。',
        };
    }

    private getWindowsCertificateTrustStatus(certPath: string, fileExists: boolean): WindowsCertificateTrustStatus {
        return getWindowsCertificateTrustStatus(certPath, {
            platform: process.platform,
            fileExists: () => fileExists,
            logger: {
                info: message => console.info(`[dashboard] ${message}`),
                warn: message => console.warn(`[dashboard] ${message}`),
            },
        });
    }

    private buildUpstreamItem(localStatus: LocalProxyStatusSnapshot | null, diagnosis: ProxyEnvironmentDiagnosis): LinkCheckItemData {
        const configured = this.normalizeValue(this.config.upstreamProxy);
        const upstream = this.normalizeValue(localStatus?.upstream_proxy ?? diagnosis.upstreamProxy ?? configured);
        const sourceLabel: Record<NonNullable<ProxyEnvironmentDiagnosis['upstreamSource']>, string> = {
            config: '扩展设置',
            vscode: 'VS Code 代理',
            previous: '历史 VS Code 代理',
            system: '系统代理',
            env: '环境变量',
            'local-discovery': '本机自动发现',
        };
        if (upstream && upstream !== '(direct)') {
            return {
                id: 'upstream',
                title: '上游代理',
                status: 'ok',
                summary: `当前外网转发会继续走上游代理：${upstream}`,
                detail: diagnosis.upstreamSource
                    ? `来源：${sourceLabel[diagnosis.upstreamSource]}。这能兼容已有商业桌面代理或公司代理链路。`
                    : '这能兼容已有商业桌面代理或公司代理链路。',
            };
        }
        if (diagnosis.kind === 'system-pac') {
            return {
                id: 'upstream',
                title: '上游代理',
                status: 'warning',
                summary: '系统当前走 PAC 自动代理，扩展不会直接把 PAC 作为上游。',
                detail: diagnosis.recommendedAction || diagnosis.detail,
            };
        }
        if (diagnosis.kind === 'desktop-proxy' && diagnosis.detectedDesktopProcesses.length > 0) {
            return {
                id: 'upstream',
                title: '上游代理',
                status: diagnosis.allowTakeover ? 'neutral' : 'warning',
                summary: diagnosis.allowTakeover
                    ? `当前依赖桌面代理进程 ${diagnosis.detectedDesktopProcesses.join('、')} 维持外网链路。`
                    : '当前桌面代理未暴露可复用上游，扩展已停止接管。',
                detail: diagnosis.recommendedAction || diagnosis.detail,
            };
        }
        if (localStatus?.upstream_proxy === '(direct)') {
            return {
                id: 'upstream',
                title: '上游代理',
                status: 'neutral',
                summary: '当前外网请求为直连模式，没有额外上游代理。',
                detail: '如果你的环境依赖桌面代理，请检查系统代理是否已开启。',
            };
        }
        if (configured) {
            return {
                id: 'upstream',
                title: '上游代理',
                status: 'warning',
                summary: `已配置上游代理 ${configured}，但本地代理尚未返回运行中的上游信息。`,
                detail: '启动监控代理后会再次自动探测。',
            };
        }
        return {
            id: 'upstream',
            title: '上游代理',
            status: 'neutral',
            summary: '暂未检测到额外上游代理配置。',
            detail: '如果当前网络本来就是直连，这属于正常情况。',
        };
    }

    private buildReportingItem(
        localStatus: LocalProxyStatusSnapshot | null,
        trackerStatus: TrackerRuntimeStatus,
        serverHealth: { ok: boolean; detail: string },
    ): LinkCheckItemData {
        if (!this.config.serverUrl.trim() || !this.config.userId.trim() || !this.config.userName.trim()) {
            return {
                id: 'reporting',
                title: '最近上报',
                status: 'warning',
                summary: '上报地址或身份信息未填写完整，当前无法完成服务器侧校验。',
                detail: '请先在基础设置里填写上报地址、工号和姓名。',
            };
        }

        const queueInfo = `待发送 ${trackerStatus.pendingQueueLength} 条`;
        const lastCollect = trackerStatus.lastCollectSuccessAt
            ? `最近 collect 成功 ${this.formatTimestamp(trackerStatus.lastCollectSuccessAt)}`
            : (localStatus?.stats?.total_reported
                ? `本地代理累计已上报 ${localStatus.stats.total_reported} 条请求`
                : '当前会话还没有新的 collect 成功记录');
        const lastSync = trackerStatus.lastStatsSyncAt
            ? `my-stats 同步 ${this.formatTimestamp(trackerStatus.lastStatsSyncAt)}`
            : '尚未拿到最近一次 my-stats 同步时间';

        if (!serverHealth.ok) {
            return {
                id: 'reporting',
                title: '最近上报',
                status: 'error',
                summary: `服务端检查失败：${serverHealth.detail}`,
                detail: `${queueInfo}；${lastCollect}`,
            };
        }

        if (trackerStatus.lastCollectError) {
            return {
                id: 'reporting',
                title: '最近上报',
                status: trackerStatus.pendingQueueLength > 0 ? 'error' : 'warning',
                summary: `最近一次上报失败：${trackerStatus.lastCollectError}`,
                detail: `${queueInfo}；${lastSync}`,
            };
        }

        return {
            id: 'reporting',
            title: '最近上报',
            status: 'ok',
            summary: `服务端可达，${lastCollect}。`,
            detail: `${lastSync}；${queueInfo}。`,
        };
    }

    private formatTimestamp(value?: string): string {
        if (!value) {
            return '未知时间';
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return date.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    private pickOverallStatus(items: LinkCheckItemData[]): LinkCheckData['overallStatus'] {
        if (items.some(item => item.status === 'error')) {
            return 'error';
        }
        if (items.some(item => item.status === 'warning')) {
            return 'warning';
        }
        if (items.every(item => item.status === 'ok')) {
            return 'ok';
        }
        if (items.some(item => item.status === 'checking')) {
            return 'checking';
        }
        return 'neutral';
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
        await this.refreshLinkCheck();
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
    .auth-btn {
        padding: 8px 14px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: var(--accent-strong, #FF8C57);
        border: 1px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.2s ease, opacity 0.2s ease;
    }
    .auth-btn:hover {
        opacity: 0.88;
    }
    .auth-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .auth-btn-secondary {
        color: var(--text-main);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--border-strong);
    }
    .auth-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.1);
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
    .link-check-card {
        display: grid;
        gap: 12px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
    }
    .link-check-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .link-check-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-main);
    }
    .link-check-subtitle {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-sub);
    }
    .link-check-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }
    .link-check-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text-sub);
        font-size: 10px;
        font-weight: 700;
        white-space: nowrap;
    }
    .link-check-badge::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 8px currentColor;
    }
    .link-check-badge.ok {
        color: var(--success);
        border-color: rgba(56, 217, 139, 0.24);
        background: rgba(56, 217, 139, 0.08);
    }
    .link-check-badge.warning {
        color: #ffb84d;
        border-color: rgba(255, 184, 77, 0.24);
        background: rgba(255, 184, 77, 0.08);
    }
    .link-check-badge.error {
        color: var(--error);
        border-color: rgba(255, 83, 119, 0.26);
        background: rgba(255, 83, 119, 0.1);
    }
    .link-check-badge.checking {
        color: var(--accent-strong);
        border-color: rgba(255, 91, 80, 0.26);
        background: rgba(255, 91, 80, 0.1);
    }
    .link-check-badge.checking::before {
        animation: pulseDot 1.1s ease-in-out infinite;
    }
    .link-check-btn {
        padding: 8px 12px;
        border-radius: 12px;
        border: 1px solid var(--border-strong);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text-main);
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
    }
    .link-check-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.22);
    }
    .link-check-btn:disabled {
        opacity: 0.6;
        cursor: default;
    }
    .link-check-meta {
        font-size: 10px;
        color: rgba(220, 228, 240, 0.48);
    }
    .link-check-list {
        display: grid;
        gap: 10px;
    }
    .link-check-item {
        display: grid;
        gap: 5px;
        padding: 12px 13px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.07);
        background: rgba(255, 255, 255, 0.026);
    }
    .link-check-item.ok {
        border-color: rgba(56, 217, 139, 0.18);
        background: rgba(56, 217, 139, 0.06);
    }
    .link-check-item.warning {
        border-color: rgba(255, 184, 77, 0.18);
        background: rgba(255, 184, 77, 0.07);
    }
    .link-check-item.error {
        border-color: rgba(255, 83, 119, 0.2);
        background: rgba(255, 83, 119, 0.08);
    }
    .link-check-item.checking {
        border-color: rgba(255, 91, 80, 0.16);
        background: rgba(255, 91, 80, 0.07);
    }
    .link-check-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .link-check-item-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--text-main);
    }
    .link-check-item-status {
        font-size: 10px;
        font-weight: 700;
        color: var(--text-sub);
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .link-check-item-summary {
        font-size: 11px;
        line-height: 1.55;
        color: var(--text-main);
    }
    .link-check-item-detail {
        font-size: 10px;
        line-height: 1.55;
        color: var(--text-sub);
        word-break: break-word;
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
                        <div class="section-heading">账号设置</div>
                        <div class="section-caption">上报地址与身份认证</div>
                    </div>
                    <span class="arrow" id="basicArrow">▶</span>
                </div>
                <div class="config-section" id="basicSection">
                    <div class="field field-span-2">
                        <label>上报地址</label>
                        <input id="cfgServer" type="text" data-key="serverUrl" value="${this.esc(cfgData.serverUrl)}" placeholder="例如：https://otw.tech:59889" />
                    </div>

                    <!-- 已登录状态 -->
                    <div id="authLoggedIn" class="field-span-2" style="display:${cfgData.userId ? 'block' : 'none'}">
                        <div class="identity-check-panel ok field-span-2" style="margin-bottom:8px;">
                            <div>已登录：<strong id="authDisplayName">${this.esc(cfgData.userName)}</strong>（工号 <strong id="authDisplayId">${this.esc(cfgData.userId)}</strong>）</div>
                            <div style="font-size:11px;opacity:0.7;margin-top:2px;" id="authDisplayDept">${cfgData.department ? '部门：' + this.esc(cfgData.department) : ''}</div>
                        </div>
                        <button class="auth-btn auth-btn-secondary" id="authLogoutBtn" style="width:100%">退出登录</button>
                    </div>

                    <!-- 登录表单 -->
                    <div id="authLoginForm" class="field-span-2" style="display:${cfgData.userId ? 'none' : 'block'}">
                        <div class="field">
                            <label>工号</label>
                            <input id="authLoginId" type="text" placeholder="输入工号" />
                        </div>
                        <div class="field">
                            <label>密码</label>
                            <input id="authLoginPwd" type="password" placeholder="输入密码" />
                        </div>
                        <div class="field field-span-2" style="display:flex;gap:8px;">
                            <button class="auth-btn" id="authLoginBtn" style="flex:1">登录</button>
                            <button class="auth-btn auth-btn-secondary" id="authShowRegister" style="flex:1">注册新账号</button>
                        </div>
                        <div class="identity-check-panel subtle field-span-2" id="authLoginMsg" style="display:none">
                            <div id="authLoginMsgText"></div>
                        </div>
                    </div>

                    <!-- 注册表单 -->
                    <div id="authRegisterForm" class="field-span-2" style="display:none">
                        <div class="field">
                            <label>姓名</label>
                            <input id="authRegName" type="text" placeholder="真实姓名" />
                        </div>
                        <div class="field">
                            <label>部门</label>
                            <input id="authRegDept" type="text" placeholder="例如：公共技术部" />
                        </div>
                        <div class="field">
                            <label>密码</label>
                            <input id="authRegPwd" type="password" placeholder="至少4位" />
                        </div>
                        <div class="field">
                            <label>确认密码</label>
                            <input id="authRegPwd2" type="password" placeholder="再次输入密码" />
                        </div>
                        <div class="field field-span-2" style="display:flex;gap:8px;">
                            <button class="auth-btn" id="authRegBtn" style="flex:1">注册</button>
                            <button class="auth-btn auth-btn-secondary" id="authShowLogin" style="flex:1">返回登录</button>
                        </div>
                        <div class="identity-check-panel subtle field-span-2" id="authRegMsg" style="display:none">
                            <div id="authRegMsgText"></div>
                        </div>
                    </div>

                    <!-- 设置密码表单（老用户迁移） -->
                    <div id="authSetPwdForm" class="field-span-2" style="display:none">
                        <div class="identity-check-panel warning field-span-2" style="margin-bottom:8px">
                            <div>该工号尚未设置密码，请验证姓名并设置密码。</div>
                        </div>
                        <div class="field" style="display:none">
                            <input id="authSetPwdId" type="hidden" />
                        </div>
                        <div class="field">
                            <label>姓名（需与服务器一致）</label>
                            <input id="authSetPwdName" type="text" placeholder="真实姓名" />
                        </div>
                        <div class="field">
                            <label>设置密码</label>
                            <input id="authSetPwdPwd" type="password" placeholder="至少4位" />
                        </div>
                        <div class="field field-span-2" style="display:flex;gap:8px;">
                            <button class="auth-btn" id="authSetPwdBtn" style="flex:1">确认设置</button>
                            <button class="auth-btn auth-btn-secondary" id="authSetPwdBack" style="flex:1">返回登录</button>
                        </div>
                        <div class="identity-check-panel subtle field-span-2" id="authSetPwdMsg" style="display:none">
                            <div id="authSetPwdMsgText"></div>
                        </div>
                    </div>

                    <div class="identity-check-panel subtle field-span-2" id="identityCheckPanel">
                        <div id="identityCheckText">登录或注册后即可开始上报数据。注册后系统自动分配工号。</div>
                    </div>
                </div>
            </div>

            <div class="section-block glass-panel">
                <div class="section-title" id="advancedToggle" data-section="advanced">
                    <div class="section-copy">
                        <div class="section-heading">高级设置</div>
                        <div class="section-caption">上游代理、Copilot 组织与本地凭据管理</div>
                    </div>
                    <span class="arrow" id="advancedArrow">▶</span>
                </div>
                <div class="config-section" id="advancedSection">
                    <div class="field field-span-2">
                        <label>上游代理（可选）</label>
                        <input id="cfgUpstreamProxy" type="text" data-key="upstreamProxy" value="${this.esc(cfgData.upstreamProxy)}" placeholder="例如：socks5://127.0.0.1:8089 或 http://127.0.0.1:7890" />
                    </div>
                    <div class="field">
                        <label>Copilot 组织</label>
                        <input id="cfgCopilotOrg" type="text" data-key="copilotOrg" value="${this.esc(cfgData.copilotOrg)}" placeholder="例如：your-org" />
                    </div>
                    <div class="field">
                        <label>GitHub PAT（可选）</label>
                        <input id="cfgCopilotPat" type="password" placeholder="例如：ghp_xxxx..." />
                    </div>
                    <div class="info-note field-span-2">
                        若当前网络依赖系统代理、桌面代理或本地 SOCKS/HTTP 端口，可在这里显式填写上游代理。<br>
                        监控数据通过本地代理采集并上报。<br>
                        PAT 仅保存在本机 SecretStorage，不会显示在面板中。
                    </div>
                    <div class="link-check-card field-span-2" id="linkCheckCard">
                        <div class="link-check-head">
                            <div>
                                <div class="link-check-title">链路自检</div>
                                <div class="link-check-subtitle">检查本地代理、证书安装、上游代理和最近上报是否正常。</div>
                            </div>
                            <div class="link-check-tools">
                                <div class="link-check-badge checking" id="linkCheckBadge">检查中</div>
                                <button class="link-check-btn" id="runLinkCheckBtn" type="button">立即自检</button>
                            </div>
                        </div>
                        <div class="link-check-meta" id="linkCheckMeta">正在初始化自检结果…</div>
                        <div class="link-check-list" id="linkCheckList"></div>
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

        const runLinkCheckBtn = document.getElementById('runLinkCheckBtn');
        if (runLinkCheckBtn && runLinkCheckBtn.dataset.boundClick !== '1') {
            runLinkCheckBtn.dataset.boundClick = '1';
            runLinkCheckBtn.addEventListener('click', () => {
                if (runLinkCheckBtn.disabled) return;
                runLinkCheckBtn.disabled = true;
                vscMsg('runLinkCheck');
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
        // Auth fields are now managed through login/register forms, no standalone identity inputs to style
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

    // 未登录时自动展开账号设置区
    (function autoExpandIfNotLoggedIn() {
        const loggedIn = document.getElementById('authLoggedIn');
        const isLoggedIn = loggedIn && loggedIn.style.display !== 'none';
        if (!isLoggedIn) {
            toggleSection('basic');
        }
    })();

    // ── Auth UI logic ──────────────────────────────

    function showAuthForm(formId) {
        ['authLoginForm', 'authRegisterForm', 'authSetPwdForm', 'authLoggedIn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (id === formId) ? 'block' : 'none';
        });
    }

    function showAuthMsg(panelId, textId, message, level) {
        const panel = document.getElementById(panelId);
        const text = document.getElementById(textId);
        if (panel && text) {
            panel.style.display = 'block';
            panel.className = 'identity-check-panel field-span-2 ' + (level || 'error');
            text.textContent = message;
        }
    }

    function hideAuthMsg(panelId) {
        const el = document.getElementById(panelId);
        if (el) el.style.display = 'none';
    }

    // Login button
    const authLoginBtn = document.getElementById('authLoginBtn');
    if (authLoginBtn) {
        authLoginBtn.addEventListener('click', () => {
            const id = document.getElementById('authLoginId')?.value?.trim();
            const pwd = document.getElementById('authLoginPwd')?.value;
            if (!id || !pwd) { showAuthMsg('authLoginMsg', 'authLoginMsgText', '请填写工号和密码', 'warning'); return; }
            hideAuthMsg('authLoginMsg');
            authLoginBtn.disabled = true;
            authLoginBtn.textContent = '登录中…';
            vscode.postMessage({ type: 'authLogin', data: { employeeId: id, password: pwd } });
        });
    }

    // Show register
    const authShowRegister = document.getElementById('authShowRegister');
    if (authShowRegister) {
        authShowRegister.addEventListener('click', () => { showAuthForm('authRegisterForm'); hideAuthMsg('authRegMsg'); });
    }

    // Show login
    const authShowLogin = document.getElementById('authShowLogin');
    if (authShowLogin) {
        authShowLogin.addEventListener('click', () => { showAuthForm('authLoginForm'); hideAuthMsg('authLoginMsg'); });
    }

    // Register button
    const authRegBtn = document.getElementById('authRegBtn');
    if (authRegBtn) {
        authRegBtn.addEventListener('click', () => {
            const name = document.getElementById('authRegName')?.value?.trim();
            const dept = document.getElementById('authRegDept')?.value?.trim() || '';
            const pwd = document.getElementById('authRegPwd')?.value;
            const pwd2 = document.getElementById('authRegPwd2')?.value;
            if (!name) { showAuthMsg('authRegMsg', 'authRegMsgText', '请填写姓名', 'warning'); return; }
            if (!pwd || pwd.length < 4) { showAuthMsg('authRegMsg', 'authRegMsgText', '密码至少4位', 'warning'); return; }
            if (pwd !== pwd2) { showAuthMsg('authRegMsg', 'authRegMsgText', '两次密码不一致', 'warning'); return; }
            hideAuthMsg('authRegMsg');
            authRegBtn.disabled = true;
            authRegBtn.textContent = '注册中…';
            vscode.postMessage({ type: 'authRegister', data: { name, department: dept, password: pwd } });
        });
    }

    // Logout button
    const authLogoutBtn = document.getElementById('authLogoutBtn');
    if (authLogoutBtn) {
        authLogoutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'authLogout' });
        });
    }

    // Set password button
    const authSetPwdBtn = document.getElementById('authSetPwdBtn');
    if (authSetPwdBtn) {
        authSetPwdBtn.addEventListener('click', () => {
            const id = document.getElementById('authSetPwdId')?.value?.trim();
            const name = document.getElementById('authSetPwdName')?.value?.trim();
            const pwd = document.getElementById('authSetPwdPwd')?.value;
            if (!name) { showAuthMsg('authSetPwdMsg', 'authSetPwdMsgText', '请填写姓名', 'warning'); return; }
            if (!pwd || pwd.length < 4) { showAuthMsg('authSetPwdMsg', 'authSetPwdMsgText', '密码至少4位', 'warning'); return; }
            hideAuthMsg('authSetPwdMsg');
            authSetPwdBtn.disabled = true;
            authSetPwdBtn.textContent = '设置中…';
            vscode.postMessage({ type: 'authSetPassword', data: { employeeId: id, name, password: pwd } });
        });
    }

    // Back from set-password
    const authSetPwdBack = document.getElementById('authSetPwdBack');
    if (authSetPwdBack) {
        authSetPwdBack.addEventListener('click', () => { showAuthForm('authLoginForm'); });
    }

    function showToast(text) {
        const t = document.getElementById('toast');
        t.textContent = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    function linkCheckStatusLabel(status) {
        switch (status) {
            case 'ok': return '正常';
            case 'warning': return '注意';
            case 'error': return '异常';
            case 'checking': return '检查中';
            default: return '未启用';
        }
    }

    function formatLinkCheckTime(value) {
        if (!value) return '尚未完成自检';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return '上次自检 ' + date.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function renderLinkCheck(data) {
        const badge = document.getElementById('linkCheckBadge');
        const meta = document.getElementById('linkCheckMeta');
        const list = document.getElementById('linkCheckList');
        const btn = document.getElementById('runLinkCheckBtn');
        if (!badge || !meta || !list || !btn) return;

        const overall = data?.overallStatus || 'neutral';
        badge.className = 'link-check-badge ' + overall;
        badge.textContent = linkCheckStatusLabel(overall);
        meta.textContent = formatLinkCheckTime(data?.checkedAt);
        btn.disabled = overall === 'checking';

        const items = Array.isArray(data?.items) ? data.items : [];
        list.innerHTML = items.map(item => {
            const status = escapeHtml(item.status || 'neutral');
            const title = escapeHtml(item.title || '');
            const summary = escapeHtml(item.summary || '');
            const statusLabel = escapeHtml(linkCheckStatusLabel(item.status || 'neutral'));
            const detail = item.detail
                ? '<div class="link-check-item-detail">' + escapeHtml(item.detail) + '</div>'
                : '';
            return '<div class="link-check-item ' + status + '">'
                + '<div class="link-check-row">'
                + '<div class="link-check-item-title">' + title + '</div>'
                + '<div class="link-check-item-status">' + statusLabel + '</div>'
                + '</div>'
                + '<div class="link-check-item-summary">' + summary + '</div>'
                + detail
                + '</div>';
        }).join('');
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
                    '<span class="breakdown-label">' + escapeHtml(String(key)) + '</span>' +
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
                const cfgUpstreamProxyEl = document.getElementById('cfgUpstreamProxy');
                const cfgCopilotOrgEl = document.getElementById('cfgCopilotOrg');
                if (cfgServerEl) cfgServerEl.value = msg.data.serverUrl || '';
                if (cfgUpstreamProxyEl) cfgUpstreamProxyEl.value = msg.data.upstreamProxy || '';
                if (cfgCopilotOrgEl) cfgCopilotOrgEl.value = msg.data.copilotOrg || '';
                updateUserCard(msg.data || {});
                updateServerAddress((msg.data && msg.data.serverUrl) || '');
                // Update auth display if logged in
                const authNameEl = document.getElementById('authDisplayName');
                const authIdEl = document.getElementById('authDisplayId');
                const authDeptEl = document.getElementById('authDisplayDept');
                if (authNameEl) authNameEl.textContent = msg.data.userName || '';
                if (authIdEl) authIdEl.textContent = msg.data.userId || '';
                if (authDeptEl) authDeptEl.textContent = msg.data.department ? '部门：' + msg.data.department : '';
                // Show/hide auth forms based on login state
                if (msg.data.userId) {
                    showAuthForm('authLoggedIn');
                } else {
                    showAuthForm('authLoginForm');
                }
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
                const blocked = Boolean(msg.data.blocked);
                if (status) {
                    status.textContent = blocked
                        ? '已阻止接管'
                        : (reloadRequired
                            ? (running ? '运行中，待重载' : '待重载')
                            : (running ? '运行中' : '未启动'));
                    status.classList.toggle('pending', reloadRequired);
                }
                if (btn) {
                    btn.textContent = running ? '停止' : (blocked ? '重试' : '启动');
                    btn.disabled = false;
                    btn.classList.toggle('is-active', running);
                }
                if (dot) {
                    if (running) { dot.classList.add('on'); } else { dot.classList.remove('on'); }
                    dot.classList.toggle('pending', reloadRequired);
                }
                if (hint) {
                    hint.textContent = blocked
                        ? (msg.data.blockedReason || '检测到当前代理环境不适合自动接管，已保持原网络链路不变。')
                        : (reloadRequired
                            ? '当前窗口还没有重载，Copilot / AI 请求可能仍走旧连接，所以暂时不会进入 Token 上报。'
                            : (running
                                ? '监控代理已运行，新的 AI 请求会通过本地监控链路上报。'
                                : '监控代理默认关闭；启用时会自动安装当前用户证书，并尽量沿用现有系统或公司代理。'));
                    hint.classList.toggle('warning', reloadRequired || blocked);
                }
                if (reloadBtn) {
                    reloadBtn.classList.toggle('hidden', !reloadRequired);
                }
            }

            if (msg.type === 'linkCheck') {
                renderLinkCheck(msg.data || {});
            }

            if (msg.type === 'authSuccess') {
                const d = msg.data || {};
                showAuthForm('authLoggedIn');
                const nameEl = document.getElementById('authDisplayName');
                const idEl = document.getElementById('authDisplayId');
                const deptEl = document.getElementById('authDisplayDept');
                if (nameEl) nameEl.textContent = d.name || '';
                if (idEl) idEl.textContent = d.employee_id || '';
                if (deptEl) deptEl.textContent = d.department ? '部门：' + d.department : '';
                updateUserCard({ userName: d.name || '', userId: d.employee_id || '', department: d.department || '' });
                if (d.mode === 'register') {
                    showToast('注册成功，工号：' + (d.employee_id || ''));
                } else if (d.mode === 'setPassword') {
                    showToast('密码设置成功');
                } else {
                    showToast('登录成功');
                }
                // Re-enable buttons
                const loginBtn = document.getElementById('authLoginBtn');
                const regBtn = document.getElementById('authRegBtn');
                const setPwdBtn = document.getElementById('authSetPwdBtn');
                if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = '登录'; }
                if (regBtn) { regBtn.disabled = false; regBtn.textContent = '注册'; }
                if (setPwdBtn) { setPwdBtn.disabled = false; setPwdBtn.textContent = '确认设置'; }
                // 登录成功后折叠账号设置区
                var basicSec = document.getElementById('basicSection');
                if (basicSec && basicSec.classList.contains('show')) {
                    toggleSection('basic');
                }
            }

            if (msg.type === 'authError') {
                const errMsg = (msg.data && msg.data.message) || '操作失败';
                // Show error on whichever form is visible
                const loginForm = document.getElementById('authLoginForm');
                const regForm = document.getElementById('authRegisterForm');
                const setPwdForm = document.getElementById('authSetPwdForm');
                if (setPwdForm && setPwdForm.style.display !== 'none') {
                    showAuthMsg('authSetPwdMsg', 'authSetPwdMsgText', errMsg, 'error');
                    const btn = document.getElementById('authSetPwdBtn');
                    if (btn) { btn.disabled = false; btn.textContent = '确认设置'; }
                } else if (regForm && regForm.style.display !== 'none') {
                    showAuthMsg('authRegMsg', 'authRegMsgText', errMsg, 'error');
                    const btn = document.getElementById('authRegBtn');
                    if (btn) { btn.disabled = false; btn.textContent = '注册'; }
                } else {
                    showAuthMsg('authLoginMsg', 'authLoginMsgText', errMsg, 'error');
                    const btn = document.getElementById('authLoginBtn');
                    if (btn) { btn.disabled = false; btn.textContent = '登录'; }
                }
            }

            if (msg.type === 'authNeedSetPassword') {
                const eid = (msg.data && msg.data.employeeId) || '';
                showAuthForm('authSetPwdForm');
                const idInput = document.getElementById('authSetPwdId');
                if (idInput) idInput.value = eid;
                const loginBtn = document.getElementById('authLoginBtn');
                if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = '登录'; }
            }

            if (msg.type === 'authLoggedOut') {
                showAuthForm('authLoginForm');
                hideAuthMsg('authLoginMsg');
                updateUserCard({ userName: '', userId: '', department: '' });
                showToast('已退出登录');
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

