const fs = require('fs');
const prefixPath = 'D:/Repos/token-监控/vscode-extension/src/dashboard_prefix.js';
const targetPath = 'D:/Repos/token-监控/vscode-extension/src/dashboard.ts';
let code = fs.readFileSync(prefixPath, 'utf8');

code += 
        const stats = this.getStats();
        const cfgData = this.getConfigData();
        return /* html */ \\\<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
    :root {
        --bg: #0a0a0a;
        --panel: rgba(20, 20, 20, 0.4);
        --border: #2a2a2a;
        --text-main: #e0e0e0;
        --text-sub: #888888;
        --accent: #00e5ff;
        --accent-glow: rgba(0, 229, 255, 0.2);
        --error: #ff4081;
        --error-glow: rgba(255, 64, 129, 0.2);
        --success: #00e676;
        --font-ui: var(--vscode-font-family);
        --font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    }

    * { box-sizing: border-box; }
    body {
        font-family: var(--font-ui);
        color: var(--text-main);
        background: var(--vscode-sideBar-background, var(--bg));
        padding: 0;
        margin: 0;
        overflow-x: hidden;
    }

    .header {
        padding: 18px 16px 14px;
        position: relative;
        background: linear-gradient(135deg, rgba(0,229,255,0.05) 0%, transparent 100%);
        border-bottom: 1px solid var(--border);
    }
    .header::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, var(--accent), transparent);
    }
    .header-brand {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 2px;
        color: var(--accent);
    }
    .header-title {
        font-size: 18px;
        font-weight: 300;
        letter-spacing: 1px;
        margin-top: 4px;
        text-shadow: 0 0 10px var(--accent-glow);
    }
    .header-author {
        font-size: 10px;
        color: var(--text-sub);
        margin-top: 4px;
        font-family: var(--font-mono);
    }

    .glass-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
    }

    .user-card {
        margin: 12px;
        padding: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        position: relative;
        overflow: hidden;
    }
    .user-avatar {
        width: 38px;
        height: 38px;
        border-radius: 5px;
        background: rgba(0,229,255,0.1);
        border: 1px solid var(--accent);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: 600;
        color: var(--accent);
        flex-shrink: 0;
        box-shadow: 0 0 8px var(--accent-glow);
    }
    .user-info { flex: 1; min-width: 0; }
    .user-name {
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .user-meta {
        font-size: 10px;
        color: var(--text-sub);
        margin-top: 3px;
        font-family: var(--font-mono);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .user-status {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--success);
        box-shadow: 0 0 6px var(--success);
        flex-shrink: 0;
    }
    .user-status.error {
        background: var(--error);
        box-shadow: 0 0 6px var(--error);
    }
    
    .user-card-empty {
        margin: 12px;
        border: 1px dashed var(--border);
        background: rgba(17,17,17,0.3);
        border-radius: 6px;
        padding: 18px 16px;
        text-align: center;
        font-size: 11px;
        color: var(--text-sub);
        font-family: var(--font-mono);
        cursor: pointer;
        transition: all 0.3s;
    }
    .user-card-empty:hover {
        border-color: var(--accent);
        color: var(--text-main);
        box-shadow: 0 0 8px var(--accent-glow);
    }

    .content { padding: 0 12px 12px; }

    .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 12px;
    }
    .card {
        padding: 14px 12px;
        position: relative;
    }
    .card::before {
        content: '';
        position: absolute;
        top: 0; left: 0; width: 3px; height: 100%;
        border-radius: 4px 0 0 4px;
        background: var(--border);
        transition: 0.3s;
    }
    .card:first-child::before { background: var(--accent); box-shadow: 0 0 8px var(--accent-glow); }
    .card:last-child::before { background: var(--success); box-shadow: 0 0 8px var(--success); }

    .card-title {
        font-size: 9px;
        text-transform: uppercase;
        color: var(--text-sub);
        letter-spacing: 1px;
        margin-bottom: 6px;
        font-family: var(--font-mono);
    }
    .card-value {
        font-size: 24px;
        font-weight: 300;
        font-family: var(--font-mono);
    }
    .card-value.tokens { color: var(--accent); text-shadow: 0 0 8px var(--accent-glow); }
    .card-value.requests { color: var(--success); text-shadow: 0 0 8px rgba(0, 230, 118, 0.2); }

    .report-bar {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-sub);
        font-family: var(--font-mono);
        padding: 0 4px;
        margin-bottom: 14px;
        background: rgba(0,0,0,0.2);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 6px 10px;
    }
    .report-bar .ok { color: var(--success); font-weight: bold; }
    .report-bar .fail { color: var(--error); font-weight: bold; }

    .server-card {
        padding: 12px;
        margin-bottom: 12px;
        display: none;
        border-left: 2px solid var(--accent);
    }

    .section-title {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-sub);
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin: 18px 0 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
        font-family: var(--font-mono);
        transition: color 0.2s;
    }
    .section-title:hover { color: var(--text-main); }
    .section-title .arrow {
        font-size: 9px;
        transition: transform 0.2s;
    }
    .section-title .arrow.open { transform: rotate(90deg); color: var(--accent); }

    .config-section {
        padding: 12px;
        margin-bottom: 12px;
        display: none;
    }
    .config-section.show { display: block; }
    
    .field { margin-bottom: 12px; }
    .field:last-of-type { margin-bottom: 0; }
    .field label {
        display: block;
        font-size: 10px;
        color: var(--text-sub);
        margin-bottom: 4px;
        font-family: var(--font-mono);
        text-transform: uppercase;
    }
    .field input {
        width: 100%;
        padding: 6px 8px;
        font-size: 11px;
        font-family: var(--font-mono);
        background: rgba(0,0,0,0.3);
        color: var(--text-main);
        border: 1px solid var(--border);
        border-radius: 4px;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
    }
    .field input:focus { border-color: var(--accent); box-shadow: 0 0 6px var(--accent-glow); }

    .breakdown-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        font-size: 11px;
        margin-bottom: 10px;
        font-family: var(--font-mono);
    }
    .breakdown-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-main);
    }
    .breakdown-value {
        color: var(--text-sub);
        font-size: 10px;
    }
    .breakdown-bar {
        width: 100%;
        height: 3px;
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
        margin-top: 4px;
        overflow: hidden;
        position: relative;
    }
    .breakdown-bar .breakdown-fill {
        height: 100%;
        background: var(--accent);
        box-shadow: 0 0 4px var(--accent-glow);
        border-radius: 2px;
    }

    .btn {
        background: rgba(0,229,255,0.1);
        color: var(--accent);
        border: 1px solid var(--accent);
        padding: 10px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        width: 100%;
        transition: 0.3s;
        font-family: var(--font-mono);
        margin-bottom: 14px;
    }
    .btn:hover {
        background: rgba(0,229,255,0.2);
        box-shadow: 0 0 10px var(--accent-glow);
    }
    .btn-secondary {
        background: transparent;
        color: var(--text-sub);
        border-color: var(--border);
    }
    .btn-secondary:hover {
        border-color: var(--text-main);
        color: var(--text-main);
        background: rgba(255,255,255,0.05);
    }

    .toast {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: var(--accent);
        color: #000;
        padding: 6px 14px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: bold;
        opacity: 0;
        visibility: hidden;
        transition: 0.3s;
        font-family: var(--font-mono);
        box-shadow: 0 0 15px var(--accent-glow);
        z-index: 1000;
    }
    .toast.show {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
    }
</style>
</head>
<body>

    <div class="header">
        <div class="header-brand">AI DASHBOARD</div>
        <div class="header-title">Token Telemetry</div>
        <div class="header-author">Tencent Public Tech</div>
    </div>

    <div class="user-card glass-panel" id="userCard" style="\">
        <div class="user-avatar" id="avatar">\</div>
        <div class="user-info">
            <div class="user-name" id="displayName">\</div>
            <div class="user-meta" id="displayMeta">\\\</div>
        </div>
        <div class="user-status" id="statusDot"></div>
    </div>

    <div class="user-card-empty" id="userCardEmpty" onclick="toggleSection('basic')" style="\">
        [ AUTH REQUIRED ]<br>CLICK TO CONFIGURE USER
    </div>

    <div class="content">
        <button class="btn btn-chat" onclick="vscMsg('newChat')">
            START NEW SESSION
        </button>

        <div class="grid">
            <div class="card glass-panel">
                <div class="card-title">DAY TOKENS</div>
                <div class="card-value tokens" id="todayTokens">\</div>
            </div>
            <div class="card glass-panel">
                <div class="card-title">DAY REQ</div>
                <div class="card-value requests" id="todayRequests">\</div>
            </div>
        </div>

        <div class="report-bar">
            <span>UPLINK: <strong class="ok" id="totalReported">\</strong></span>
            <span>DROP: <strong class="fail" id="totalFailed">\</strong></span>
        </div>

        <!-- BREAKDOWN -->
        <div class="section-title" onclick="toggleSection('breakdown')">
            <span class="arrow" id="breakdownArrow">▶</span> METRICS
        </div>
        <div class="config-section glass-panel" id="breakdownSection">
            <div id="appBreakdown" class="breakdown-list">\</div>
            <div id="modelBreakdown" class="breakdown-list">\</div>
            <div id="sourceBreakdown" class="breakdown-list">\</div>
        </div>

        <!-- SERVER -->
        <div class="server-card glass-panel" id="serverStats">
            <div class="card-title" style="color:var(--accent)">SERVER STATS</div>
            <div class="user-meta" id="serverInfo" style="margin-top:8px;"></div>
        </div>

        <!-- BASIC CONFIG -->
        <div class="section-title" onclick="toggleSection('basic')">
            <span class="arrow" id="basicArrow">▶</span> SYS CONFIG
        </div>
        <div class="config-section glass-panel" id="basicSection">
            <div class="field">
                <label>UPLINK HOST</label>
                <input id="cfgServer" type="text" data-key="serverUrl" value="\" placeholder="http://192.168.0.135:8000" />
            </div>
            <div class="field">
                <label>USER ID</label>
                <input id="cfgUserId" type="text" data-key="userId" value="\" placeholder="e.g. 10001" />
            </div>
            <div class="field">
                <label>USER NAME</label>
                <input id="cfgUserName" type="text" data-key="userName" value="\" placeholder="e.g. ZhangSan" />
            </div>
            <div class="field">
                <label>DEPARTMENT</label>
                <input id="cfgDept" type="text" data-key="department" value="\" placeholder="e.g. TechOps" />
            </div>
        </div>

        <!-- ADVANCED CONFIG -->
        <div class="section-title" onclick="toggleSection('advanced')">
            <span class="arrow" id="advancedArrow">▶</span> SECRETS
        </div>
        <div class="config-section glass-panel" id="advancedSection">
            <div class="field">
                <label>COPILOT ORG</label>
                <input id="cfgCopilotOrg" type="text" data-key="copilotOrg" value="\" placeholder="your-org" />
            </div>
            <div class="field">
                <label>GITHUB PAT</label>
                <input id="cfgCopilotPat" type="password" placeholder="ghp_xxxx..." />
            </div>
            <div style="font-size:9px;color:var(--text-sub);margin-top:10px;font-family:var(--font-mono);line-height:1.4;">
                [!] Data telemetry is stored locally. PAT is locally secured.
            </div>
        </div>
        
        <button class="btn btn-secondary" onclick="vscMsg('refresh')" style="margin-top:14px; margin-bottom:20px;">SYNC UPLINK DATA</button>
    </div>

    <div class="toast" id="toast"></div>

<script>
    const vscode = acquireVsCodeApi();

    function vscMsg(type, data) {
        vscode.postMessage({ type, ...data });
    }

    function toggleSection(id) {
        const sec = document.getElementById(id + 'Section');
        const arr = document.getElementById(id + 'Arrow');
        if (sec.classList.contains('show')) {
            sec.classList.remove('show');
            arr.classList.remove('open');
        } else {
            sec.classList.add('show');
            arr.classList.add('open');
        }
    }

    let saveTimer;
    function scheduleAutoSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(doSave, 800);
    }

    function doSave() {
        const data = {};
        document.querySelectorAll('.config-section input[data-key]').forEach(el => {
            if (el.type === 'checkbox') data[el.getAttribute('data-key')] = el.checked;
            else data[el.getAttribute('data-key')] = el.value.trim();
        });
        vscode.postMessage({ type: 'saveConfig', data });
    }

    document.querySelectorAll('.config-section input[data-key]').forEach(el => {
        el.addEventListener('input', scheduleAutoSave);
    });

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
        const card = document.getElementById('userCard'), empty = document.getElementById('userCardEmpty');
        if (cfg.userName) {
            card.style.display = ''; empty.style.display = 'none';
            document.getElementById('avatar').textContent = cfg.userName.charAt(0);
            document.getElementById('displayName').textContent = cfg.userName;
            let meta = cfg.department || '';
            if (cfg.department && cfg.userId) meta += ' · ';
            meta += cfg.userId || '';
            document.getElementById('displayMeta').textContent = meta;
        } else { card.style.display = 'none'; empty.style.display = ''; }
    }

    function updateBreakdown(elementId, data) {
        const el = document.getElementById(elementId);
        if (!el || !data) return;
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, e) => sum + e[1], 0);
        if (entries.length === 0) { el.innerHTML = '<div style="font-size:10px;color:var(--text-sub);padding:4px 0;font-family:var(--font-mono)">[ NO DATA RECORDED ]</div>'; return; }
        el.innerHTML = entries.map(([key, value]) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return '<div class="breakdown-row">' +
                '<span class="breakdown-label">' + key + '</span>' +
                '<span class="breakdown-value">' + value.toLocaleString() + ' <span style="opacity:0.5;margin-left:4px;">'+pct+'%</span></span>' +
                '<div class="breakdown-bar"><div class="breakdown-fill" style="width:'+pct+'%"></div></div></div>';
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
            if (msg.data.breakdown) {
                updateBreakdown('appBreakdown', msg.data.breakdown.apps);
                updateBreakdown('modelBreakdown', msg.data.breakdown.models);
                updateBreakdown('sourceBreakdown', msg.data.breakdown.sources);
            }
        }
        if (msg.type === 'serverData') {
            const el = document.getElementById('serverStats'); el.style.display = 'block';
            document.getElementById('serverInfo').innerHTML =
                'TOKENS: <span style="color:var(--accent);font-weight:bold;">' + (msg.data.total_tokens || 0).toLocaleString() + '</span><br>' +
                'USERS: <span style="color:var(--accent);font-weight:bold;">' + (msg.data.active_users || 0) + '</span><br>' +
                'COST: <span style="color:var(--accent);font-weight:bold;">¥' + (msg.data.total_cost_cny || 0).toFixed(2) + '</span>';
        }
        if (msg.type === 'configSaved') {
            showToast('SYS.SAVED');
            const cfg = {
                userName: document.getElementById('cfgUserName').value.trim(),
                userId: document.getElementById('cfgUserId').value.trim(),
                department: document.getElementById('cfgDept').value.trim()
            };
            updateUserCard(cfg);
        }
        if (msg.type === 'configUpdated') {
            document.getElementById('cfgServer').value = msg.data.serverUrl || '';
            document.getElementById('cfgUserId').value = msg.data.userId || '';
            document.getElementById('cfgUserName').value = msg.data.userName || '';
            document.getElementById('cfgDept').value = msg.data.department || '';
            document.getElementById('cfgCopilotOrg').value = msg.data.copilotOrg || '';
            updateUserCard(msg.data);
        }
    });
</script>
</body>
</html>\;
    }
}
;
fs.writeFileSync(targetPath, code);
