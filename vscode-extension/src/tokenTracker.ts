import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { getNormalizedAppName, MonitorConfig } from './config';
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

export interface TrackerRuntimeStatus {
    pendingQueueLength: number;
    isReporting: boolean;
    lastCollectAttemptAt?: string;
    lastCollectSuccessAt?: string;
    lastCollectError?: string;
    lastCollectErrorCategory?: TrackerErrorCategory;
    lastCollectHttpStatus?: number;
    lastCollectErrorCode?: string;
    lastStatsSyncAt?: string;
    lastStatsSyncError?: string;
    lastStatsSyncErrorCategory?: TrackerErrorCategory;
    lastStatsSyncHttpStatus?: number;
    lastStatsSyncErrorCode?: string;
    totalFailed: number;
    totalReported: number;
}

export type TrackerErrorCategory =
    | 'identity_conflict'
    | 'timeout'
    | 'server_unreachable'
    | 'http_error'
    | 'config_incomplete'
    | 'unknown';

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

class TrackerRequestError extends Error {
    statusCode?: number;
    responseBody?: string;
    errorCode?: string;
    category: TrackerErrorCategory;

    constructor(
        message: string,
        options: {
            statusCode?: number;
            responseBody?: string;
            errorCode?: string;
            category?: TrackerErrorCategory;
        } = {},
    ) {
        super(message);
        this.name = 'TrackerRequestError';
        this.statusCode = options.statusCode;
        this.responseBody = options.responseBody;
        this.errorCode = options.errorCode;
        this.category = options.category ?? 'unknown';
    }
}

interface TrackerFailureSnapshot {
    message: string;
    category: TrackerErrorCategory;
    statusCode?: number;
    errorCode?: string;
}

export class TokenTracker {
    private offlineQueue: UsageRecord[] = [];
    private offlineQueueTimer: ReturnType<typeof setInterval> | null = null;
    private initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private config: MonitorConfig;
    private globalState: vscode.Memento;
    private clientId: string;
    private storageScopeKey: string;
    private readonly appScopeKey: string;
    private isReporting = false;
    private eventBus?: EventBus;
    private tokenUsageListener?: (data: any) => void;
    private lastCollectAttemptAt?: string;
    private lastCollectSuccessAt?: string;
    private lastCollectError?: string;
    private lastStatsSyncAt?: string;
    private lastStatsSyncError?: string;
    private lastCollectErrorCategory?: TrackerErrorCategory;
    private lastCollectHttpStatus?: number;
    private lastCollectErrorCode?: string;
    private lastStatsSyncErrorCategory?: TrackerErrorCategory;
    private lastStatsSyncHttpStatus?: number;
    private lastStatsSyncErrorCode?: string;
    private authToken?: string;

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
        this.appScopeKey = getNormalizedAppName();
        this.clientId = this.buildClientId(config);
        this.storageScopeKey = this.getStorageScopeKey(config);
        this.eventBus = eventBus;

        this.restorePersistedState(true);
    }

    private getStorageScopeKey(config: MonitorConfig = this.config): string {
        const serverUrl = (config.serverUrl || '').trim().replace(/\/+$/, '') || 'no-server';
        const userId = (config.userId || '').trim() || 'anonymous';
        return `${serverUrl}::${userId}::${this.appScopeKey}`;
    }

    private buildClientId(config: MonitorConfig = this.config): string {
        const userId = (config.userId || '').trim() || 'anonymous';
        return `${userId}@${os.hostname()}#${this.appScopeKey}`;
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
            this.tokenUsageListener = (data) => this.addRecord(data);
            this.eventBus.on('token-usage', this.tokenUsageListener);
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
        if (this.eventBus && this.tokenUsageListener) {
            this.eventBus.off('token-usage', this.tokenUsageListener);
            this.tokenUsageListener = undefined;
        }
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
        this.clientId = this.buildClientId(config);

        if (nextScopeKey !== this.storageScopeKey) {
            this.persistOfflineQueue();
            this.persistTodayStats();
            this.storageScopeKey = nextScopeKey;
            this.restorePersistedState();
        }
    }

    setAuthToken(token: string | undefined) {
        this.authToken = token;
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

    public getRuntimeStatus(): TrackerRuntimeStatus {
        return {
            pendingQueueLength: this.offlineQueue.length,
            isReporting: this.isReporting,
            lastCollectAttemptAt: this.lastCollectAttemptAt,
            lastCollectSuccessAt: this.lastCollectSuccessAt,
            lastCollectError: this.lastCollectError,
            lastCollectErrorCategory: this.lastCollectErrorCategory,
            lastCollectHttpStatus: this.lastCollectHttpStatus,
            lastCollectErrorCode: this.lastCollectErrorCode,
            lastStatsSyncAt: this.lastStatsSyncAt,
            lastStatsSyncError: this.lastStatsSyncError,
            lastStatsSyncErrorCategory: this.lastStatsSyncErrorCategory,
            lastStatsSyncHttpStatus: this.lastStatsSyncHttpStatus,
            lastStatsSyncErrorCode: this.lastStatsSyncErrorCode,
            totalFailed: this.totalFailed,
            totalReported: this.totalReported,
        };
    }

    async flushOfflineQueue(): Promise<void> {
        if (this.isReporting || this.offlineQueue.length === 0) return;
        if (!this.canReport()) {
            this.lastCollectErrorCategory = 'config_incomplete';
            this.lastCollectErrorCode = undefined;
            this.lastCollectHttpStatus = undefined;
            this.lastCollectError = '上报地址、工号或姓名未填写完整';
            this.persistOfflineQueue();
            return;
        }
        this.isReporting = true;
        this.lastCollectAttemptAt = new Date().toISOString();

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
            this.lastCollectSuccessAt = new Date().toISOString();
            this.lastCollectError = undefined;
            this.lastCollectErrorCategory = undefined;
            this.lastCollectHttpStatus = undefined;
            this.lastCollectErrorCode = undefined;
            // Clear offline cache on success
            this.persistOfflineQueue();
            
            // Sync authoritative stats from server in the background
            this.syncStats().catch(console.error);
        } catch (err) {
            // Put back for retry
            this.offlineQueue.unshift(...batch);
            this.totalFailed += batch.length;
            const failure = this.summarizeFailure(err, '最近一次上报失败');
            this.lastCollectError = failure.message;
            this.lastCollectErrorCategory = failure.category;
            this.lastCollectHttpStatus = failure.statusCode;
            this.lastCollectErrorCode = failure.errorCode;
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
                this.lastStatsSyncAt = new Date().toISOString();
                this.lastStatsSyncError = undefined;
                this.lastStatsSyncErrorCategory = undefined;
                this.lastStatsSyncHttpStatus = undefined;
                this.lastStatsSyncErrorCode = undefined;
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
            const failure = this.summarizeFailure(e, 'my-stats 同步失败');
            this.lastStatsSyncError = failure.message;
            this.lastStatsSyncErrorCategory = failure.category;
            this.lastStatsSyncHttpStatus = failure.statusCode;
            this.lastStatsSyncErrorCode = failure.errorCode;
            console.error('[TokenTracker] syncStats failed:', e);
        }
    }

    private summarizeFailure(error: unknown, prefix: string): TrackerFailureSnapshot {
        if (error instanceof TrackerRequestError) {
            const detail = this.extractErrorDetail(error.responseBody);
            const errorCode = detail?.code || error.errorCode;
            const category = this.categorizeError(error, errorCode);
            const message = detail?.message
                ? `${prefix}：${detail.message}`
                : `${prefix}：${error.message}`;
            return {
                message,
                category,
                statusCode: error.statusCode,
                errorCode,
            };
        }

        const fallbackMessage = error instanceof Error ? error.message : String(error);
        return {
            message: `${prefix}：${fallbackMessage}`,
            category: this.categorizeError(error),
        };
    }

    private categorizeError(error: unknown, errorCode?: string): TrackerErrorCategory {
        if (errorCode === 'identity_conflict') {
            return 'identity_conflict';
        }
        if (error instanceof TrackerRequestError) {
            if (error.category !== 'unknown') {
                return error.category;
            }
            if (typeof error.statusCode === 'number') {
                return 'http_error';
            }
        }

        const message = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(message)) {
            return 'timeout';
        }
        if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|connect/i.test(message)) {
            return 'server_unreachable';
        }
        if (/HTTP\s+\d+/i.test(message)) {
            return 'http_error';
        }
        return 'unknown';
    }

    private extractErrorDetail(body?: string): { code?: string; message?: string } | undefined {
        if (!body) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(body) as { detail?: string | { code?: string; message?: string } };
            if (typeof parsed.detail === 'string') {
                return { message: parsed.detail };
            }
            if (parsed.detail && typeof parsed.detail === 'object') {
                return {
                    code: parsed.detail.code,
                    message: parsed.detail.message,
                };
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private getJSON<T>(url: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const options: Record<string, any> = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                timeout: 10_000,
                headers: {
                    ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
                    ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
                },
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
                        reject(new TrackerRequestError(`HTTP ${res.statusCode}: ${body}`, {
                            statusCode: res.statusCode,
                            responseBody: body,
                        }));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new TrackerRequestError('GET JSON timeout', { category: 'timeout' }));
            });
            req.end();
        });
    }

    private postJSON(url: string, data: unknown): Promise<void> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(data);
            const parsed = new URL(url);
            const options: Record<string, any> = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body, 'utf8'),
                    ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
                    ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
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
                        reject(new TrackerRequestError(`HTTP ${res.statusCode}: ${body}`, {
                            statusCode: res.statusCode,
                            responseBody: body,
                        }));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new TrackerRequestError('Request timeout', { category: 'timeout' }));
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

