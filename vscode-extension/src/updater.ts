/**
 * Extension self-updater.
 *
 * On activation, checks the backend for a newer VSIX version.
 * If available, prompts the user and installs it in-place.
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LAST_CHECK_KEY = 'aiTokenMonitor.updater.lastCheck';
const DISMISSED_VERSION_KEY = 'aiTokenMonitor.updater.dismissedVersion';

interface LatestInfo {
    version: string;
    download_url: string;
    filename: string;
    target: string;
}

export interface UpdateCheckResult {
    status: 'up-to-date' | 'available' | 'updated' | 'dismissed' | 'cancelled' | 'error';
    message: string;
    version?: string;
    currentVersion?: string;
}

function getTarget(): string {
    const platform = process.platform === 'win32' ? 'win32'
        : process.platform === 'darwin' ? 'darwin'
        : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `${platform}-${arch}`;
}

function currentVersion(context: vscode.ExtensionContext): string {
    return context.extension.packageJSON.version ?? '0.0.0';
}

function isNewer(remote: string, local: string): boolean {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((r[i] ?? 0) > (l[i] ?? 0)) { return true; }
        if ((r[i] ?? 0) < (l[i] ?? 0)) { return false; }
    }
    return false;
}

function fetchJson(url: string): Promise<LatestInfo> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 8000 }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location).then(resolve, reject);
                return;
            }
            if (!res.statusCode || res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 60000 }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location, dest).then(resolve, reject);
                return;
            }
            if (!res.statusCode || res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const stream = fs.createWriteStream(dest);
            res.pipe(stream);
            stream.on('finish', () => { stream.close(); resolve(); });
            stream.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

export async function checkForUpdates(
    context: vscode.ExtensionContext,
    serverUrl: string,
    force = false,
): Promise<UpdateCheckResult> {
    try {
        const base = serverUrl.replace(/\/+$/, '');
        if (!base) {
            const result: UpdateCheckResult = {
                status: 'error',
                message: '请先配置上报地址后再检查更新。',
                currentVersion: currentVersion(context),
            };
            if (force) {
                void vscode.window.showWarningMessage(result.message);
            }
            return result;
        }

        // Throttle: at most once per 24h (skip if force)
        if (!force) {
            const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
            if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
                return {
                    status: 'cancelled',
                    message: '最近已检查过更新。',
                    currentVersion: currentVersion(context),
                };
            }
        }
        await context.globalState.update(LAST_CHECK_KEY, Date.now());

        const target = getTarget();
        const info = force
            ? await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在检查更新...', cancellable: false },
                async () => fetchJson(`${base}/api/extension/latest?target=${encodeURIComponent(target)}`),
            )
            : await fetchJson(`${base}/api/extension/latest?target=${encodeURIComponent(target)}`);

        const local = currentVersion(context);
        if (!isNewer(info.version, local)) {
            const result: UpdateCheckResult = {
                status: 'up-to-date',
                message: `当前已是最新版本 v${local}`,
                version: info.version,
                currentVersion: local,
            };
            if (force) {
                void vscode.window.showInformationMessage(result.message);
            }
            return result;
        }

        // Skip if user already dismissed this version
        const dismissed = context.globalState.get<string>(DISMISSED_VERSION_KEY, '');
        if (!force && dismissed === info.version) {
            return {
                status: 'dismissed',
                message: `已跳过版本 v${info.version}`,
                version: info.version,
                currentVersion: local,
            };
        }

        const action = await vscode.window.showInformationMessage(
            `AI Token 监控有新版本 v${info.version}（当前 v${local}）`,
            '立即更新',
            '跳过此版本',
        );

        if (action === '跳过此版本') {
            await context.globalState.update(DISMISSED_VERSION_KEY, info.version);
            return {
                status: 'dismissed',
                message: `已跳过版本 v${info.version}`,
                version: info.version,
                currentVersion: local,
            };
        }

        if (action !== '立即更新') {
            return {
                status: 'cancelled',
                message: '已取消更新。',
                version: info.version,
                currentVersion: local,
            };
        }

        const availableResult: UpdateCheckResult = {
            status: 'available',
            message: `发现新版本 v${info.version}`,
            version: info.version,
            currentVersion: local,
        };

        // Download VSIX
        const downloadUrl = info.download_url.startsWith('http')
            ? info.download_url
            : `${base}${info.download_url}`;

        const tmpDir = path.join(os.tmpdir(), 'ai-monitor-update');
        fs.mkdirSync(tmpDir, { recursive: true });
        const vsixPath = path.join(tmpDir, info.filename);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `正在下载 v${info.version}...`, cancellable: false },
            async () => { await downloadFile(downloadUrl, vsixPath); },
        );

        // Install
        await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(vsixPath),
        );

        // Clean up
        try { fs.unlinkSync(vsixPath); } catch { /* ignore */ }

        // Clear dismissed cache so future versions can prompt
        await context.globalState.update(DISMISSED_VERSION_KEY, '');

        const reload = await vscode.window.showInformationMessage(
            `AI Token 监控已更新到 v${info.version}，重载窗口以生效。`,
            '立即重载',
        );
        if (reload === '立即重载') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        return {
            status: 'updated',
            message: `已更新到 v${info.version}`,
            version: info.version,
            currentVersion: local,
        };
    } catch (err) {
        console.log('[Updater] Update check failed:', err);
        const message = err instanceof Error ? err.message : '未知错误';
        const result: UpdateCheckResult = {
            status: 'error',
            message: `检查更新失败：${message}`,
            currentVersion: currentVersion(context),
        };
        if (force) {
            void vscode.window.showWarningMessage(result.message);
        }
        return result;
    }
}
