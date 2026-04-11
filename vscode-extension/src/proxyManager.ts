import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { MonitorConfig } from './config';

export type ProxyStatus = 'external' | 'internal' | 'off';

export interface ProxyStartResult {
    status: ProxyStatus;
    routingChanged: boolean;
}

export interface LocalProxyStatusSnapshot {
    status?: string;
    version?: string;
    mode?: string;
    pid?: number;
    port?: number;
    uptime_seconds?: number;
    upstream_proxy?: string;
    user?: string;
    department?: string;
    source_app?: string;
    server?: string;
    ai_domains?: number;
    ai_wildcard_patterns?: number;
    extra_monitor_hosts?: number;
    extra_monitor_suffixes?: number;
    stats?: {
        total_reported?: number;
        total_tokens?: number;
    };
}

export class ProxyManager {
    private process: ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private readonly recentOutputLines: string[] = [];
    private partialOutputLine = '';
    private healthCheckTimer?: ReturnType<typeof setInterval>;
    /** When set, overrides config.proxyPort — used when we discover an existing instance on a different port */
    private activePort?: number;

    constructor(
        private config: MonitorConfig,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.outputChannel = vscode.window.createOutputChannel('AI Token Monitor Proxy');
    }

    private pushRecentOutputLine(line: string): void {
        const trimmed = line.trimEnd();
        if (!trimmed) {
            return;
        }
        this.recentOutputLines.push(trimmed);
        if (this.recentOutputLines.length > 200) {
            this.recentOutputLines.splice(0, this.recentOutputLines.length - 200);
        }
    }

    private appendOutput(text: string): void {
        this.outputChannel.append(text);
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const combined = this.partialOutputLine + normalized;
        const lines = combined.split('\n');
        this.partialOutputLine = lines.pop() ?? '';
        for (const line of lines) {
            this.pushRecentOutputLine(line);
        }
    }

    private appendOutputLine(line: string): void {
        this.outputChannel.appendLine(line);
        this.pushRecentOutputLine(line);
    }

    public get isRunning(): boolean {
        return this.process !== null && this.process.exitCode === null;
    }

    public updateConfig(config: MonitorConfig): void {
        this.config = config;
    }

    public getRecentOutputLines(limit = 40): string[] {
        return this.recentOutputLines.slice(-Math.max(1, limit));
    }

    public async getLocalStatus(): Promise<LocalProxyStatusSnapshot | null> {
        return new Promise(resolve => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.getEffectivePort(),
                path: '/status',
                method: 'GET',
                timeout: 1500,
            }, res => {
                let body = '';
                res.on('data', chunk => {
                    body += chunk.toString();
                });
                res.on('end', () => {
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(JSON.parse(body) as LocalProxyStatusSnapshot);
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.end();
        });
    }

    public async start(options?: { skipUpstreamDetect?: boolean }): Promise<ProxyStartResult> {
        if (!this.config.transparentMode) {
            this.appendOutputLine('[proxy] Transparent proxy disabled by configuration.');
            await this.restoreHttpProxyIfMitmUnavailable();
            return { status: 'off', routingChanged: false };
        }

        // NOTE: We intentionally do NOT clear stale MITM routing here.
        // If the proxy is about to (re)start, clearing http.proxy then re-setting it
        // causes ensureVsCodeProxyRouting() to return routingChanged=true, triggering
        // an infinite reload loop. All failure paths below already call
        // restoreHttpProxyIfMitmUnavailable() individually.

        if (this.detectExternalProxy()) {
            const routingChanged = await this.ensureVsCodeProxyRouting();
            this.startHealthCheck();
            return { status: 'external', routingChanged };
        }

        if (this.isRunning || await this.isProxyAvailable()) {
            const routingChanged = await this.ensureVsCodeProxyRouting();
            this.startHealthCheck();
            return { status: this.isRunning ? 'internal' : 'external', routingChanged };
        }

        // Discover an existing ai-monitor instance (another IDE may have started it)
        const existing = await this.discoverRunningInstance();
        if (existing) {
            this.appendOutputLine(`[proxy] Discovered existing ai-monitor on port ${existing.port} — reusing`);
            this.activePort = existing.port;
            const routingChanged = await this.ensureVsCodeProxyRouting();
            this.startHealthCheck();
            return { status: 'external', routingChanged };
        }

        const binaryPath = this.findBinaryPath();
        if (!binaryPath) {
            this.appendOutputLine('[proxy] Binary not found. Falling back to in-process interception only.');
            await this.restoreHttpProxyIfMitmUnavailable();
            return { status: 'off', routingChanged: false };
        }

        const configPath = path.join(this.context.globalStorageUri.fsPath, 'proxy-config.json');
        await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

        let upstreamProxy = options?.skipUpstreamDetect ? '' : this.resolveUpstreamProxy();
        if (upstreamProxy && await this.shouldIgnoreUpstreamProxy(upstreamProxy)) {
            this.appendOutputLine(`[proxy] Ignoring unreachable local upstream proxy: ${upstreamProxy}`);
            upstreamProxy = '';
        }
        const proxyConfig: Record<string, unknown> = {
            server_url: this.config.serverUrl,
            user_name: this.config.userName,
            user_id: this.config.userId,
            department: this.config.department,
            port: this.config.proxyPort,
            gateway_port: this.config.gatewayPort,
            report_opaque_traffic: true,
        };
        if (upstreamProxy) {
            proxyConfig.upstream_proxy = upstreamProxy;
        }

        await fs.promises.writeFile(configPath, JSON.stringify(proxyConfig, null, 2), 'utf8');

        const args = ['--config', configPath];
        this.appendOutputLine(`[proxy] Starting: ${binaryPath} ${args.join(' ')}`);

        const proc = spawn(binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
            windowsHide: true,
            env: { ...process.env, AI_MONITOR_NO_CONSOLE: '1' }
        });
        this.process = proc;

        proc.stdout?.on('data', (data: Buffer) => {
            this.appendOutput(data.toString());
        });
        proc.stderr?.on('data', (data: Buffer) => {
            this.appendOutput(data.toString());
        });
        proc.on('exit', (code) => {
            this.appendOutputLine(`[proxy] Process exited with code ${code}`);
            this.process = null;
            this.activePort = undefined;
            this.stopHealthCheck();
            void this.restoreHttpProxyIfMitmUnavailable();
        });

        const ready = await this.waitForProxyReady(8_000);
        if (!ready) {
            this.appendOutputLine('[proxy] Local proxy did not become ready.');
            await this.restoreHttpProxyIfMitmUnavailable();
            return { status: 'off', routingChanged: false };
        }

        // After process starts, read back the actual port from /status
        const statusAfterStart = await this.getLocalStatus();
        if (statusAfterStart?.port && statusAfterStart.port !== this.config.proxyPort) {
            this.appendOutputLine(`[proxy] Actual port ${statusAfterStart.port} differs from configured ${this.config.proxyPort}`);
            this.activePort = statusAfterStart.port;
        }

        this.appendOutputLine(`[proxy] Running on MITM:${this.getEffectivePort()} Gateway:${this.config.gatewayPort}`);
        const routingChanged = await this.ensureVsCodeProxyRouting();
        this.startHealthCheck();
        return { status: 'internal', routingChanged };
    }

    public async restart(config?: MonitorConfig): Promise<ProxyStartResult> {
        if (config) {
            this.config = config;
        }
        await this.stop();
        return this.start();
    }

    public async stop(): Promise<void> {
        this.stopHealthCheck();
        if (!this.process) {
            this.activePort = undefined;
            return;
        }

        this.appendOutputLine('[proxy] Stopping...');
        this.process.kill('SIGTERM');

        await new Promise<void>((resolve) => {
            const proc = this.process;
            if (!proc) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                if (this.process && this.process.exitCode === null) {
                    this.process.kill('SIGKILL');
                }
                resolve();
            }, 5000);

            proc.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        this.process = null;
        this.activePort = undefined;
        this.appendOutputLine('[proxy] Stopped');
        await this.restoreHttpProxyIfMitmUnavailable();
    }

    public getGatewayUrl(): string {
        return `http://127.0.0.1:${this.config.gatewayPort}`;
    }

    public getEffectivePort(): number {
        return this.activePort ?? this.config.proxyPort;
    }

    public getMitmProxyUrl(): string {
        return `http://127.0.0.1:${this.getEffectivePort()}`;
    }

    public detectExternalProxy(): boolean {
        return process.env['AI_MONITOR_LAUNCH_MODE'] === '1';
    }

    public isProxyAvailable(): Promise<boolean> {
        return new Promise(resolve => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.getEffectivePort(),
                path: '/status',
                method: 'GET',
            }, res => resolve(res.statusCode === 200));
            req.setTimeout(1000, () => {
                req.destroy();
                resolve(false);
            });
            req.on('error', () => resolve(false));
            req.end();
        });
    }

    public async getProxyStatus(): Promise<ProxyStatus> {
        if (this.detectExternalProxy()) {
            return 'external';
        }
        if (this.isRunning) {
            return 'internal';
        }
        return (await this.isProxyAvailable()) ? 'external' : 'off';
    }

    public findBinaryPath(): string | null {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const binaryName = `ai-monitor${ext}`;

        const bundledPath = path.join(this.context.extensionPath, 'bin', binaryName);
        if (fs.existsSync(bundledPath)) {
            return bundledPath;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolders) {
            const workspaceBin = path.join(folder.uri.fsPath, 'bin', binaryName);
            if (fs.existsSync(workspaceBin)) {
                return workspaceBin;
            }

            const siblingClient = path.resolve(folder.uri.fsPath, '..', 'client', binaryName);
            if (fs.existsSync(siblingClient)) {
                return siblingClient;
            }

            const nestedClient = path.join(folder.uri.fsPath, 'client', binaryName);
            if (fs.existsSync(nestedClient)) {
                return nestedClient;
            }
        }

        const globalPath = path.join(this.context.globalStorageUri.fsPath, 'bin', binaryName);
        if (fs.existsSync(globalPath)) {
            return globalPath;
        }

        return null;
    }

    /**
     * Discover an already-running ai-monitor instance started by another IDE or CLI.
     * Checks: configured port → PID file → port range scan (18090..18099).
     */
    public async discoverRunningInstance(): Promise<{ port: number; status: LocalProxyStatusSnapshot } | null> {
        // 1. Check configured port first (fast path)
        const configStatus = await this.getLocalStatus();
        if (configStatus?.status === 'running') {
            return { port: this.config.proxyPort, status: configStatus };
        }

        // 2. Check PID file (%APPDATA%/ai-monitor/instance.json)
        const pidInfo = await this.readInstanceInfo();
        if (pidInfo?.port && pidInfo.port !== this.config.proxyPort) {
            const pidStatus = await this.probePort(pidInfo.port);
            if (pidStatus?.status === 'running') {
                return { port: pidInfo.port, status: pidStatus };
            }
        }

        // 3. Scan nearby port range
        const basePort = this.config.proxyPort;
        for (let offset = 1; offset <= 10; offset++) {
            const port = basePort + offset;
            const probeStatus = await this.probePort(port);
            if (probeStatus?.status === 'running') {
                return { port, status: probeStatus };
            }
        }

        return null;
    }

    private async readInstanceInfo(): Promise<{ pid: number; port: number; version?: string } | null> {
        const appData = process.env.APPDATA;
        if (!appData) {
            return null;
        }
        const infoPath = path.join(appData, 'ai-monitor', 'instance.json');
        try {
            const content = await fs.promises.readFile(infoPath, 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    private probePort(port: number): Promise<LocalProxyStatusSnapshot | null> {
        return new Promise(resolve => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/status',
                method: 'GET',
                timeout: 1500,
            }, res => {
                let body = '';
                res.on('data', chunk => {
                    body += chunk.toString();
                });
                res.on('end', () => {
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(JSON.parse(body) as LocalProxyStatusSnapshot);
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.end();
        });
    }

    private startHealthCheck(): void {
        this.stopHealthCheck();
        this.healthCheckTimer = setInterval(async () => {
            const proxyUp = await this.isProxyAvailable();
            if (!proxyUp) {
                this.appendOutputLine('[proxy] Health check failed — proxy unreachable');
                const restored = await this.restoreHttpProxyIfMitmUnavailable();
                if (restored) {
                    this.stopHealthCheck();
                }
            }
        }, 30_000);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }
    }

    private normalizeProxyValue(value: string): string {
        return value.trim().replace(/\/+$/, '');
    }

    private isMitmProxyValue(value: string): boolean {
        const normalized = this.normalizeProxyValue(value);
        if (!normalized) {
            return false;
        }

        try {
            const parsed = new URL(normalized);
            const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
            const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
            // Match the configured port, the active port, or the known fallback range (18090..18099)
            const basePort = this.config.proxyPort;
            return isLocal && (
                port === this.getEffectivePort()
                || (port >= basePort && port < basePort + 10)
            );
        } catch {
            return false;
        }
    }

    private async waitForProxyReady(timeoutMs: number): Promise<boolean> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (await this.isProxyAvailable()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }

    private async shouldIgnoreUpstreamProxy(proxyUrl: string): Promise<boolean> {
        try {
            const parsed = new URL(proxyUrl);
            const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
            if (!isLoopback || this.isMitmProxyValue(proxyUrl)) {
                return false;
            }

            const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
            return !(await this.isTcpPortReachable(parsed.hostname, port, 1000));
        } catch {
            return false;
        }
    }

    private isTcpPortReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
        return new Promise(resolve => {
            const socket = net.createConnection({ host, port });
            const finish = (result: boolean) => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(result);
            };

            socket.setTimeout(timeoutMs);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    private resolveUpstreamProxy(): string {
        const configured = this.normalizeProxyValue(this.config.upstreamProxy);
        if (configured && !this.isMitmProxyValue(configured)) {
            return configured;
        }

        const httpProxyConfig = vscode.workspace.getConfiguration('http');
        const currentProxy = this.normalizeProxyValue(httpProxyConfig.get<string>('proxy', ''));
        if (currentProxy && !this.isMitmProxyValue(currentProxy)) {
            return currentProxy;
        }

        const previousProxy = this.normalizeProxyValue(
            this.context.globalState.get<string>('aiTokenMonitor.previousHttpProxy', ''),
        );
        if (previousProxy && !this.isMitmProxyValue(previousProxy)) {
            return previousProxy;
        }

        const configPath = path.join(this.context.globalStorageUri.fsPath, 'proxy-config.json');
        try {
            if (fs.existsSync(configPath)) {
                const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { upstream_proxy?: string };
                const persistedProxy = this.normalizeProxyValue(parsed.upstream_proxy ?? '');
                if (persistedProxy && !this.isMitmProxyValue(persistedProxy)) {
                    return persistedProxy;
                }
            }
        } catch {
            // Ignore unreadable historical config and continue probing.
        }

        for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
            const envProxy = this.normalizeProxyValue(process.env[key] ?? '');
            if (envProxy && !this.isMitmProxyValue(envProxy)) {
                return envProxy;
            }
        }

        return '';
    }

    /**
     * If `http.proxy` points at this extension's MITM port but no proxy is reachable,
     * restore the previously saved user proxy or clear the setting so VS Code networking works.
     */
    public async restoreHttpProxyIfMitmUnavailable(): Promise<boolean> {
        const httpConfig = vscode.workspace.getConfiguration('http');
        const currentProxy = this.normalizeProxyValue(httpConfig.get<string>('proxy', ''));

        if (!this.isMitmProxyValue(currentProxy)) {
            return false;
        }

        const proxyUp = this.isRunning || (await this.isProxyAvailable());
        if (proxyUp) {
            return false;
        }

        const previous = this.normalizeProxyValue(
            this.context.globalState.get<string>('aiTokenMonitor.previousHttpProxy', ''),
        );
        await httpConfig.update('proxy', previous, vscode.ConfigurationTarget.Global);

        // Restore proxyStrictSSL
        const prevStrictSSL = this.context.globalState.get<boolean | undefined>('aiTokenMonitor.previousProxyStrictSSL');
        if (prevStrictSSL !== undefined) {
            await httpConfig.update('proxyStrictSSL', prevStrictSSL, vscode.ConfigurationTarget.Global);
        }

        this.appendOutputLine(
            `[proxy] Restored VS Code http.proxy (MITM not running) -> ${previous || '(empty)'}`,
        );
        return true;
    }

    private async ensureVsCodeProxyRouting(): Promise<boolean> {
        if (!this.config.transparentMode) {
            return false;
        }

        const httpConfig = vscode.workspace.getConfiguration('http');
        const currentProxy = this.normalizeProxyValue(httpConfig.get<string>('proxy', ''));
        const mitmProxy = this.getMitmProxyUrl();

        if (currentProxy && !this.isMitmProxyValue(currentProxy)) {
            await this.context.globalState.update('aiTokenMonitor.previousHttpProxy', currentProxy);
        }

        if (currentProxy === mitmProxy) {
            // Ensure proxyStrictSSL is disabled even if proxy was already set
            const strictSSL = httpConfig.get<boolean>('proxyStrictSSL', true);
            if (strictSSL) {
                await this.context.globalState.update('aiTokenMonitor.previousProxyStrictSSL', strictSSL);
                await httpConfig.update('proxyStrictSSL', false, vscode.ConfigurationTarget.Global);
                this.appendOutputLine('[proxy] Disabled http.proxyStrictSSL for MITM proxy');
                return true;
            }
            return false;
        }

        // Save previous proxyStrictSSL before overriding
        const prevStrictSSL = httpConfig.get<boolean>('proxyStrictSSL', true);
        await this.context.globalState.update('aiTokenMonitor.previousProxyStrictSSL', prevStrictSSL);

        await httpConfig.update('proxy', mitmProxy, vscode.ConfigurationTarget.Global);
        await httpConfig.update('proxyStrictSSL', false, vscode.ConfigurationTarget.Global);
        this.appendOutputLine(`[proxy] Updated VS Code http.proxy -> ${mitmProxy}, proxyStrictSSL -> false`);
        return true;
    }
}