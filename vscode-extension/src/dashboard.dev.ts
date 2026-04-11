import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';
import { MonitorConfig, getConfig } from './config';

export class DashboardProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private refreshTimer?: ReturnType<typeof setInterval>;
    private config: MonitorConfig;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly tracker: TokenTracker,
        initialConfig: MonitorConfig,
        private readonly secrets: vscode.SecretStorage,
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
        webviewView.webview.html = this.getHtml();
        void this.refreshDashboard();

        // Update every 10 seconds
        this.refreshTimer = setInterval(() => {
            if (this.view?.visible) {
                void this.refreshDashboard();
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
            }
        });
    }

    private getStats() {
        const breakdown = this.tracker.getBreakdown();
        return {
            todayTokens: this.tracker.todayTokens,
            todayRequests: this.tracker.todayRequests,
            totalReported: this.tracker.totalReported,
            totalFailed: this.tracker.totalFailed,
            breakdown,
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

    private async refreshDashboard(flushPending = false): Promise<void> {
        if (flushPending) {
            await this.tracker.flushOfflineQueue();
        }
        await this.tracker.syncStats();
        this.postStatsUpdate();
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private renderBreakdown(data?: Record<string, number>): string {
        if (!data || Object.keys(data).length === 0) {
            return '<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;">暂无数据</div>';
        }
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, [, v]) => sum + v, 0);
        return entries.map(([key, value]) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return `<div class="breakdown-row">
                <span class="breakdown-label">${this.esc(key)}</span>
                <span class="breakdown-value">${value.toLocaleString()} <small>(${pct}%)</small></span>
                <div class="breakdown-bar"><div class="breakdown-fill" style="width:${pct}%"></div></div>
            </div>`;
        }).join('');
    }

    private getHtml(): string {
        const stats = this.getStats();
        const cfgData = this.getConfigData();
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
    * { box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        padding: 0;
        margin: 0;
    }

    /* ── Header ── */
    .header {
        background: #e83428;
        padding: 16px 14px 14px;
        color: #fff;
        position: relative;
    }
    .header-brand {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.5px;
        opacity: 0.85;
    }
    .header-title {
        font-size: 16px;
        font-weight: 700;
        margin-top: 2px;
    }
    .header-author {
        font-size: 10px;
        opacity: 0.6;
        margin-top: 6px;
    }

    /* ── User Info Card ── */
    .user-card {
        margin: 10px 12px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .user-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: linear-gradient(135deg, #e83428, #d4291d);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: 700;
        color: #fff;
        flex-shrink: 0;
    }
    .user-info {
        flex: 1;
        min-width: 0;
    }
    .user-name {
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .user-meta {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .user-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4caf50;
        flex-shrink: 0;
    }
    .user-status.error { background: #f44336; }
    .user-card-empty {
        margin: 10px 12px;
        background: var(--vscode-editor-background);
        border: 1px dashed var(--vscode-widget-border);
        border-radius: 8px;
        padding: 14px;
        text-align: center;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
    }
    .user-card-empty:hover {
        border-color: var(--vscode-focusBorder);
        color: var(--vscode-foreground);
    }

    /* ── Content area ── */
    .content { padding: 0 12px 12px; }

    /* ── Stats Grid ── */
    .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 10px;
    }
    .card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px;
        padding: 12px;
    }
    .card-title {
        font-size: 10px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
        letter-spacing: 0.5px;
    }
    .card-value {
        font-size: 22px;
        font-weight: 700;
    }
    .card-value.tokens { color: #1db954; }
    .card-value.requests { color: #1177bb; }
    .card-sub {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 4px;
    }

    /* ── Report status ── */
    .report-bar {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 10px;
        padding: 0 2px;
    }
    .report-bar .ok { color: #4caf50; }
    .report-bar .fail { color: #f44336; }

    /* ── Server card ── */
    .server-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 10px;
        display: none;
    }

    /* ── Section divider ── */
    .section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin: 14px 0 8px;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
    }
    .section-title .arrow {
        font-size: 10px;
        transition: transform 0.2s;
    }
    .section-title .arrow.open { transform: rotate(90deg); }

    /* ── Config form ── */
    .config-section {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 10px;
        display: none;
    }
    .config-section.show { display: block; }
    .field {
        margin-bottom: 10px;
    }
    .field:last-of-type { margin-bottom: 0; }
    .field label {
        display: block;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 3px;
    }
    .field input[type="text"],
    .field input[type="number"],
    .field input[type="password"] {
        width: 100%;
        padding: 5px 8px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        border-radius: 4px;
        outline: none;
    }
    .field input:focus {
        border-color: var(--vscode-focusBorder);
    }

    /* ── Toggle switch ── */
    .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
    }
    .toggle-row label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .toggle {
        position: relative;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
    }
    .toggle input {
        opacity: 0;
        width: 0;
        height: 0;
    }
    .toggle .slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 10px;
        transition: 0.2s;
    }
    .toggle .slider:before {
        content: "";
        position: absolute;
        height: 14px;
        width: 14px;
        left: 2px;
        bottom: 2px;
        background: var(--vscode-descriptionForeground);
        border-radius: 50%;
        transition: 0.2s;
    }
    .toggle input:checked + .slider {
        background: #1177bb;
        border-color: #1177bb;
    }
    .toggle input:checked + .slider:before {
        transform: translateX(16px);
        background: #fff;
    }

    /* ── Buttons ── */
    .btn {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        width: 100%;
        margin-top: 8px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-chat {
        background: #e83428;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 12px;
        margin-top: 0;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
    }
    .btn-chat:hover { opacity: 0.9; }
    .btn-chat .kbd {
        font-size: 10px;
        opacity: 0.7;
        background: rgba(255,255,255,0.15);
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
    }

    .toast {
        position: fixed;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        background: #1db954;
        color: #fff;
        font-size: 12px;
        padding: 6px 16px;
        border-radius: 4px;
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
    }
    .toast.show { opacity: 1; }

    .section-sep { margin: 12px 0 6px; border: none; border-top: 1px solid var(--vscode-widget-border); }

    /* ── Breakdown ── */
    .breakdown-list { margin: 4px 0; }
    .breakdown-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        margin-bottom: 6px;
    }
    .breakdown-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--vscode-foreground);
    }
    .breakdown-value {
        text-align: right;
        white-space: nowrap;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
    }
    .breakdown-value small { font-weight: 400; opacity: 0.7; }
    .breakdown-bar {
        grid-column: 1 / -1;
        height: 3px;
        background: var(--vscode-widget-border);
        border-radius: 2px;
        overflow: hidden;
        margin-top: -2px;
    }
    .breakdown-fill {
        height: 100%;
        background: #1db954;
        border-radius: 2px;
        transition: width 0.3s;
    }
</style>
</head>
<body>
    <!-- Header -->
    <div class="header">
        <div class="header-brand">腾轩旅游集团</div>
        <div class="header-title">AI Token 监控</div>
        <div class="header-author">Powered by Zhi.Chen</div>
    </div>

    <!-- User Info -->
    <div class="user-card" id="userCard" style="${cfgData.userName ? '' : 'display:none'}">
        <div class="user-avatar" id="avatar">${this.esc(cfgData.userName?.charAt(0) || '?')}</div>
        <div class="user-info">
            <div class="user-name" id="displayName">${this.esc(cfgData.userName || '未配置')}</div>
            <div class="user-meta" id="displayMeta">${this.esc(cfgData.department || '')}${cfgData.department && cfgData.userId ? ' · ' : ''}${this.esc(cfgData.userId || '')}</div>
        </div>
        <div class="user-status" id="statusDot"></div>
    </div>
    <div class="user-card-empty" id="userCardEmpty" onclick="toggleSection('basic')" style="${cfgData.userName ? 'display:none' : ''}">
        点击配置个人信息开始使用
    <div class="content">
        <!-- New Chat Button -->
        <button class="btn btn-chat" onclick="newChat()">
            💬 开始监控对话 <span class="kbd">Ctrl+Shift+M</span>
        </button>

        <!-- Stats -->
        <div class="grid">
            <div class="card">
                <div class="card-title">今日 Tokens</div>
                <div class="card-value tokens" id="todayTokens">${stats.todayTokens.toLocaleString()}</div>
            </div>
            <div class="card">
                <div class="card-title">今日请求</div>
                <div class="card-value requests" id="todayRequests">${stats.todayRequests}</div>
            </div>
        </div>

        <!-- Report status -->
        <div class="report-bar">
            <span>已上报: <strong class="ok" id="totalReported">${stats.totalReported}</strong></span>
            <span>失败: <strong class="fail" id="totalFailed">${stats.totalFailed}</strong></span>
        </div>

        <!-- Breakdown panels -->
        <div class="section-title" onclick="toggleSection('breakdown')">
            <span class="arrow" id="breakdownArrow">▶</span> 统计维度
        </div>
        <div class="config-section" id="breakdownSection">
            <div class="card-title">按应用</div>
            <div id="appBreakdown" class="breakdown-list">${this.renderBreakdown(stats.breakdown?.apps)}</div>
            <div class="card-title" style="margin-top:10px">按模型</div>
            <div id="modelBreakdown" class="breakdown-list">${this.renderBreakdown(stats.breakdown?.models)}</div>
            <div class="card-title" style="margin-top:10px">按来源</div>
            <div id="sourceBreakdown" class="breakdown-list">${this.renderBreakdown(stats.breakdown?.sources)}</div>
        </div>

        <button class="btn btn-secondary" onclick="refresh()">刷新数据</button>

        <!-- ── Basic Config ── -->
        <div class="section-title" onclick="toggleSection('basic')">
            <span class="arrow" id="basicArrow">▶</span> 基本设置
        </div>
        <div class="config-section" id="basicSection">
            <div class="field">
                <label>服务器地址</label>
                <input id="cfgServer" type="text" data-key="serverUrl" value="${this.esc(cfgData.serverUrl)}" placeholder="https://otw.tech:59889" />
            </div>
            <div class="field">
                <label>工号 / 用户 ID</label>
                <input id="cfgUserId" type="text" data-key="userId" value="${this.esc(cfgData.userId)}" placeholder="例如: 10001" />
            </div>
            <div class="field">
                <label>姓名</label>
                <input id="cfgUserName" type="text" data-key="userName" value="${this.esc(cfgData.userName)}" placeholder="例如: 张三" />
            </div>
            <div class="field">
                <label>部门</label>
                <input id="cfgDept" type="text" data-key="department" value="${this.esc(cfgData.department)}" placeholder="例如: 技术部" />
            </div>
        </div>

        <!-- ── Advanced Config ── -->
        <div class="section-title" onclick="toggleSection('advanced')">
            <span class="arrow" id="advancedArrow">▶</span> 高级设置
        </div>
        <div class="config-section" id="advancedSection">
            <div class="field">
                <label>GitHub 组织名（Copilot Metrics）</label>
                <input id="cfgCopilotOrg" type="text" data-key="copilotOrg" value="${this.esc(cfgData.copilotOrg)}" placeholder="your-org" />
            </div>
            <div class="field">
                <label>GitHub PAT（加密存储，不写入设置文件）</label>
                <input id="cfgCopilotPat" type="password" placeholder="ghp_xxxx..." />
            </div>
        </div>
    </div>

    <div class="toast" id="toast"></div>

<script>
    const vscode = acquireVsCodeApi();
    let saveTimer = null;

    function newChat() {
        vscode.postMessage({ type: 'newChat' });
    }

    function refresh() {
        vscode.postMessage({ type: 'refresh' });
    }

    function toggleSection(name) {
        const sec = document.getElementById(name + 'Section');
        const arrow = document.getElementById(name + 'Arrow');
        const show = !sec.classList.contains('show');
        sec.classList.toggle('show', show);
        arrow.classList.toggle('open', show);
    }

    // ── Auto-save with debounce ──
    function scheduleAutoSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => doSave(), 500);
    }

    function doSave() {
        const data = {};
        // text & number & password inputs
        document.querySelectorAll('.config-section input[data-key]').forEach(el => {
            const key = el.getAttribute('data-key');
            if (el.type === 'checkbox') {
                data[key] = el.checked;
            } else if (el.type === 'number') {
                data[key] = Number(el.value) || 0;
            } else {
                data[key] = el.value.trim();
            }
        });
        vscode.postMessage({ type: 'saveConfig', data });
    }

    // Bind auto-save to all config inputs (excludes PAT which has no data-key)
    document.querySelectorAll('.config-section input[data-key]').forEach(el => {
        if (el.type === 'checkbox') {
            el.addEventListener('change', scheduleAutoSave);
        } else {
            el.addEventListener('input', scheduleAutoSave);
        }
    });

    // PAT: save via SecretStorage on blur (not part of doSave)
    const patInput = document.getElementById('cfgCopilotPat');
    if (patInput) {
        patInput.addEventListener('change', () => {
            const val = patInput.value.trim();
            if (val) vscode.postMessage({ type: 'savePat', pat: val });
        });
    }

    function showToast(text) {
        const t = document.getElementById('toast');
        t.textContent = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    function updateUserCard(cfg) {
        const card = document.getElementById('userCard');
        const empty = document.getElementById('userCardEmpty');
        if (cfg.userName) {
            card.style.display = '';
            empty.style.display = 'none';
            document.getElementById('avatar').textContent = cfg.userName.charAt(0);
            document.getElementById('displayName').textContent = cfg.userName;
            let meta = cfg.department || '';
            if (cfg.department && cfg.userId) meta += ' · ';
            meta += cfg.userId || '';
            document.getElementById('displayMeta').textContent = meta;
        } else {
            card.style.display = 'none';
            empty.style.display = '';
        }
    }

    function updateBreakdown(elementId, data) {
        const el = document.getElementById(elementId);
        if (!el || !data) return;
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, e) => sum + e[1], 0);
        if (entries.length === 0) {
            el.innerHTML = '<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;">暂无数据</div>';
            return;
        }
        el.innerHTML = entries.map(([key, value]) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return '<div class="breakdown-row">' +
                '<span class="breakdown-label">' + key + '</span>' +
                '<span class="breakdown-value">' + value.toLocaleString() + ' <small>(' + pct + '%)</small></span>' +
                '<div class="breakdown-bar"><div class="breakdown-fill" style="width:' + pct + '%"></div></div>' +
                '</div>';
        }).join('');
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
            document.getElementById('todayTokens').textContent = msg.data.todayTokens.toLocaleString();
            document.getElementById('todayRequests').textContent = msg.data.todayRequests;
            document.getElementById('totalReported').textContent = msg.data.totalReported;
            document.getElementById('totalFailed').textContent = msg.data.totalFailed;

            const dot = document.getElementById('statusDot');
            dot.className = msg.data.totalFailed > 0 ? 'user-status error' : 'user-status';

            // Update breakdown panels
            if (msg.data.breakdown) {
                updateBreakdown('appBreakdown', msg.data.breakdown.apps);
                updateBreakdown('modelBreakdown', msg.data.breakdown.models);
                updateBreakdown('sourceBreakdown', msg.data.breakdown.sources);
            }
        }
        if (msg.type === 'configSaved') {
            showToast('✓ 已自动保存');
            const cfg = {
                userName: document.getElementById('cfgUserName').value.trim(),
                userId: document.getElementById('cfgUserId').value.trim(),
                department: document.getElementById('cfgDept').value.trim(),
            };
            updateUserCard(cfg);
        }
        if (msg.type === 'configUpdated') {
            document.getElementById('cfgServer').value = msg.data.serverUrl || '';
            document.getElementById('cfgUserId').value = msg.data.userId || '';
            document.getElementById('cfgUserName').value = msg.data.userName || '';
            document.getElementById('cfgDept').value = msg.data.department || '';
            document.getElementById('cfgCopilotOrg').value = msg.data.copilotOrg || '';
            // PAT is stored in SecretStorage and never sent back to the webview
            updateUserCard(msg.data);
        }
    });
</script>
</body>
</html>`;
    }
}
