import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { MonitorConfig } from './config';
import { EventBus } from './eventBus';

export interface UsageRecord {
    vendor: string;
    model: string;
    endpoint: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requestTime: string;
    source: string;
    sourceApp: string;
    requestId?: string;
    modelFamily?: string;
    modelVersion?: string;
}

interface ApiUsageRecord {
    client_id: string;
    user_name: string;
    user_id: string;
    department: string;
    request_id: string;
    source_app: string;
    vendor: string;
    model: string;
    endpoint: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    request_time: string;
    source: string;
    model_family?: string;
    model_version?: string;
}

interface PersistedTodayStats {
    date: string;
    tokens: number;
    requests: number;
}

const EMPTY_TODAY_STATS: PersistedTodayStats = {
    date: '',
    tokens: 0,
    requests: 0,
};

export class TokenTracker {
    private offlineQueue: UsageRecord[] = [];
    private offlineQueueTimer: ReturnType<typeof setInterval> | null = null;
    private initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private config: MonitorConfig;
    private globalState: vscode.Memento;
    private clientId: string;
    private storageScopeKey: string;
    private isReporting = false;
    private eventBus?: EventBus;

    // Stats (observable by StatusBar)
    public todayTokens = 0;
    public todayRequests = 0;
    public totalReported = 0;
    public totalFailed = 0;
    public selectedDays = 1;

    // Breakdown stats (observable by Dashboard)
    private sourceBreakdown: Map<string, number> = new Map();
    private appBreakdown: Map<string, number> = new Map();
    private modelBreakdown: Map<string, number> = new Map();

    constructor(config: MonitorConfig, globalState: any, eventBus?: EventBus) {
        this.config = config;
        this.globalState = globalState;
        this.clientId = `${config.userId}@${os.hostname()}`;
        this.storageScopeKey = this.getStorageScopeKey(config);
        this.eventBus = eventBus;

        this.restorePersistedState(true);
    }

    private getStorageScopeKey(config: MonitorConfig = this.config): string {
        const serverUrl = (config.serverUrl || '').trim().replace(/\/+$/, '') || 'no-server';
        const userId = (config.userId || '').trim() || 'anonymous';
        return `${serverUrl}::${userId}`;
    }

    private getOfflineQueueStorageKey(scopeKey: string = this.storageScopeKey): string {
        return `offlineQueue:${scopeKey}`;
    }

    private getTodayStatsStorageKey(scopeKey: string = this.storageScopeKey): string {
        return `todayStats:${scopeKey}`;
    }

    private canReport(): boolean {
        return Boolean(this.config.serverUrl && this.config.userId && this.config.userName);
    }

    private resetScopedState(): void {
        this.offlineQueue = [];
        this.todayTokens = 0;
        this.todayRequests = 0;
        this.totalReported = 0;
        this.sourceBreakdown = new Map();
        this.appBreakdown = new Map();
        this.modelBreakdown = new Map();
    }

    private restorePersistedState(allowLegacyFallback = false): void {
        this.resetScopedState();

        const scopedQueue = this.globalState.get(this.getOfflineQueueStorageKey(), undefined as UsageRecord[] | undefined);
        const legacyQueue = allowLegacyFallback
            ? this.globalState.get('offlineQueue', undefined as UsageRecord[] | undefined)
            : undefined;
        const queueToRestore = Array.isArray(scopedQueue)
            ? scopedQueue
            : Array.isArray(legacyQueue)
                ? legacyQueue
                : [];

        if (queueToRestore.length > 0) {
            this.offlineQueue.push(...queueToRestore);
            if (!Array.isArray(scopedQueue) && Array.isArray(legacyQueue)) {
                void this.globalState.update(this.getOfflineQueueStorageKey(), queueToRestore);
                void this.globalState.update('offlineQueue', []);
            }
        }

        const todayKey = new Date().toISOString().slice(0, 10);
        const scopedStats = this.globalState.get(this.getTodayStatsStorageKey(), undefined as PersistedTodayStats | undefined);
        const legacyStats = allowLegacyFallback
            ? this.globalState.get('todayStats', undefined as PersistedTodayStats | undefined)
            : undefined;
        const statsToRestore = scopedStats ?? legacyStats ?? EMPTY_TODAY_STATS;

        if (statsToRestore.date === todayKey) {
            this.todayTokens = statsToRestore.tokens;
            this.todayRequests = statsToRestore.requests;
            if (!scopedStats && legacyStats) {
                void this.globalState.update(this.getTodayStatsStorageKey(), statsToRestore);
                void this.globalState.update('todayStats', EMPTY_TODAY_STATS);
            }
        }
    }

    private persistOfflineQueue(): void {
        void this.globalState.update(this.getOfflineQueueStorageKey(), [...this.offlineQueue]);
    }

    private persistTodayStats(): void {
        const todayKey = new Date().toISOString().slice(0, 10);
        void this.globalState.update(this.getTodayStatsStorageKey(), {
            date: todayKey,
            tokens: this.todayTokens,
            requests: this.todayRequests,
        } satisfies PersistedTodayStats);
    }

    start() {
        // Subscribe to token-usage events from EventBus
        if (this.eventBus) {
            this.eventBus.on('token-usage', (data) => {
                this.addRecord(data);
            });
        }

        // Check offline queue every 60 seconds
        this.offlineQueueTimer = setInterval(() => this.flushOfflineQueue(), 60_000);
        
        // Sync stats with server on start
        if (this.initialSyncTimer) {
            clearTimeout(this.initialSyncTimer);
        }
        this.initialSyncTimer = setTimeout(() => {
            this.initialSyncTimer = null;
            this.syncStats().catch(console.error);
        }, 2000);
    }

    stop() {
        if (this.offlineQueueTimer) {
            clearInterval(this.offlineQueueTimer);
            this.offlineQueueTimer = null;
        }
        if (this.initialSyncTimer) {
            clearTimeout(this.initialSyncTimer);
            this.initialSyncTimer = null;
        }
        // Persist remaining queue for the next session instead of firing an unawaited shutdown flush.
        this.persistOfflineQueue();
    }

    updateConfig(config: MonitorConfig) {
        const nextScopeKey = this.getStorageScopeKey(config);
        this.config = config;
        this.clientId = `${config.userId}@${os.hostname()}`;

        if (nextScopeKey !== this.storageScopeKey) {
            this.persistOfflineQueue();
            this.persistTodayStats();
            this.storageScopeKey = nextScopeKey;
            this.restorePersistedState();
        }
    }

    /**
     * 直接添加记录（用于后向兼容或预处理后的数据）
     */
    addRecord(record: UsageRecord) {
        if (!record.requestId) {
            record.requestId = this.generateRequestId();
        }

        // Update daily stats
        this.todayTokens += record.totalTokens;
        this.todayRequests += 1;

        // Update breakdown stats
        const srcKey = record.source || 'unknown';
        this.sourceBreakdown.set(srcKey, (this.sourceBreakdown.get(srcKey) || 0) + record.totalTokens);

        const appKey = record.sourceApp || 'unknown';
        this.appBreakdown.set(appKey, (this.appBreakdown.get(appKey) || 0) + record.totalTokens);

        const modelKey = record.model || 'unknown';
        this.modelBreakdown.set(modelKey, (this.modelBreakdown.get(modelKey) || 0) + record.totalTokens);

        this.persistTodayStats();

        // Report via queue
        this.offlineQueue.push(record);
        this.persistOfflineQueue();
        this.flushOfflineQueue().catch(err => {
            console.error('[TokenTracker] Failed to flush queue:', err);
        });
    }

    /**
     * 获取统计维度数据（按来源/应用/模型分类）
     */
    public getBreakdown() {
        return {
            sources: Object.fromEntries(this.sourceBreakdown),
            apps: Object.fromEntries(this.appBreakdown),
            models: Object.fromEntries(this.modelBreakdown),
        };
    }

    async flushOfflineQueue(): Promise<void> {
        if (this.isReporting || this.offlineQueue.length === 0) return;
        if (!this.canReport()) {
            this.persistOfflineQueue();
            return;
        }
        this.isReporting = true;

        const batch = this.offlineQueue.splice(0, Math.min(this.offlineQueue.length, 100));
        const apiRecords: ApiUsageRecord[] = batch.map(r => ({
            client_id: this.clientId,
            user_name: this.config.userName,
            user_id: this.config.userId,
            department: this.config.department,
            request_id: r.requestId || this.generateRequestId(),
            source_app: r.sourceApp,
            vendor: r.vendor,
            model: r.model,
            endpoint: r.endpoint,
            prompt_tokens: r.promptTokens,
            completion_tokens: r.completionTokens,
            total_tokens: r.totalTokens,
            request_time: r.requestTime,
            source: r.source,
            model_family: r.modelFamily,
            model_version: r.modelVersion,
        }));

        try {
            await this.postJSON(`${this.config.serverUrl}/api/collect`, apiRecords);
            // Clear offline cache on success
            this.persistOfflineQueue();
            
            // Sync authoritative stats from server in the background
            this.syncStats().catch(console.error);
        } catch (err) {
            // Put back for retry
            this.offlineQueue.unshift(...batch);
            this.totalFailed += batch.length;
            // Persist on failure
            this.persistOfflineQueue();
            console.error('[TokenTracker] Offline queue flush failed:', err);
        } finally {
            this.isReporting = false;
        }
    }

    async flush(): Promise<void> {
        // Legacy method: now just flushes offline queue
        await this.flushOfflineQueue();
    }

    setSelectedDays(days: number): void {
        this.selectedDays = days;
    }

    async syncStats(): Promise<void> {
        try {
            if (!this.config.serverUrl || !this.config.userId || !this.config.userName) return;
            const url = `${this.config.serverUrl}/api/clients/my-stats?user_id=${encodeURIComponent(this.config.userId)}&user_name=${encodeURIComponent(this.config.userName)}&department=${encodeURIComponent(this.config.department || '')}&days=${this.selectedDays}`;
            const res = await this.getJSON<{ today_tokens: number, today_requests: number }>(url);
            if (res && typeof res.today_tokens === 'number') {
                // 仅查看"今日"时加上本地待发送队列；多日范围不加（pending 只影响今天）
                const pendingReqs = this.selectedDays === 1 ? this.offlineQueue.length : 0;
                const pendingTokens = this.selectedDays === 1 ? this.offlineQueue.reduce((sum, r) => sum + r.totalTokens, 0) : 0;

                this.todayTokens = res.today_tokens + pendingTokens;
                this.todayRequests = res.today_requests + pendingReqs;
                this.totalReported = res.today_tokens;
                this.persistTodayStats();

                if (this.eventBus) {
                    this.eventBus.emit('stats-updated', undefined);
                }
            }
        } catch (e) {
            console.error('[TokenTracker] syncStats failed:', e);
        }
    }

    private getJSON<T>(url: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                timeout: 10_000,
            };

            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(e);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('GET JSON timeout'));
            });
            req.end();
        });
    }

    private postJSON(url: string, data: unknown): Promise<void> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(data);
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body, 'utf8'),
                },
                timeout: 15_000,
            };

            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request(options, (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(body);
            req.end();
        });
    }

    private generateRequestId(): string {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
}

