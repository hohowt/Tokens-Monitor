import { TokenTracker, UsageRecord } from '../tokenTracker';
import { EventBus } from '../eventBus';
import * as vscode from 'vscode';
import * as http from 'http';
import { EventEmitter } from 'events';

// Mock vscode, http, https at module level
jest.mock('http');
jest.mock('https');

describe('TokenTracker', () => {
    let tracker: TokenTracker;
    let eventBus: EventBus;
    let mockGlobalState: any;
    let consoleErrorSpy: jest.SpyInstance;

    const mockConfig = {
        serverUrl: 'http://localhost:8000',
        userId: 'user123',
        userName: 'Test User',
        department: 'Engineering',
        copilotOrg: '',
        transparentMode: true,
        proxyPort: 18090,
        gatewayPort: 18091,
        upstreamProxy: '',
        apiKey: '',
    };

    const getTodayStatsKey = (userId: string, appKey = 'vscode') => `${mockConfig.serverUrl}::${userId}::${appKey}`;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        // Create mock global state
        mockGlobalState = {
            get: jest.fn((key: string, defaultVal: any) => defaultVal),
            update: jest.fn(),
        };

        eventBus = new EventBus();
        tracker = new TokenTracker(mockConfig, mockGlobalState, eventBus);
    });

    afterEach(() => {
        tracker.stop();
        consoleErrorSpy.mockRestore();
        (vscode.env as any).appName = 'Visual Studio Code';
    });

    function mockHttpResponse(statusCode: number, body: string) {
        const requestMock = http.request as unknown as jest.Mock;
        requestMock.mockImplementation((_options: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
            const response = new EventEmitter() as EventEmitter & { statusCode?: number };
            response.statusCode = statusCode;

            const req = new EventEmitter() as EventEmitter & {
                write: jest.Mock;
                end: () => void;
                destroy: jest.Mock;
            };
            req.write = jest.fn();
            req.destroy = jest.fn();
            req.end = () => {
                callback(response);
                response.emit('data', Buffer.from(body, 'utf8'));
                response.emit('end');
            };
            return req;
        });
    }

    test('should initialize with config and global state', () => {
        expect(tracker.todayTokens).toBe(0);
        expect(tracker.todayRequests).toBe(0);
        expect(tracker.totalReported).toBe(0);
        expect(tracker.totalFailed).toBe(0);
    });

    test('should subscribe to token-usage events from EventBus', () => {
        tracker.start();

        const usageRecord: UsageRecord = {
            vendor: 'openai',
            model: 'gpt-4',
            endpoint: '/v1/chat/completions',
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            requestTime: new Date().toISOString(),
            source: 'vscode-lm',
            sourceApp: 'Visual Studio Code',
        };

        // Emit event from EventBus
        eventBus.emit('token-usage', usageRecord);

        // Verify stats were updated
        expect(tracker.todayTokens).toBe(150);
        expect(tracker.todayRequests).toBe(1);
    });

    test('should directly add records', () => {
        tracker.start();

        const usageRecord: UsageRecord = {
            vendor: 'claude',
            model: 'claude-3-opus',
            endpoint: '/v1/messages',
            promptTokens: 200,
            completionTokens: 100,
            totalTokens: 300,
            requestTime: new Date().toISOString(),
            source: 'vscode-lm',
            sourceApp: 'Visual Studio Code',
        };

        tracker.addRecord(usageRecord);

        expect(tracker.todayTokens).toBe(300);
        expect(tracker.todayRequests).toBe(1);
        expect(mockGlobalState.update).toHaveBeenCalledWith(
            `todayStats:${getTodayStatsKey(mockConfig.userId)}`,
            expect.objectContaining({ tokens: 300, requests: 1 })
        );
        expect(mockGlobalState.update).toHaveBeenCalledWith(
            `offlineQueue:${getTodayStatsKey(mockConfig.userId)}`,
            expect.arrayContaining([expect.objectContaining({ totalTokens: 300 })])
        );
    });

    test('should preserve daily stats across instances', () => {
        const todayKey = new Date().toISOString().slice(0, 10);
        mockGlobalState.get.mockImplementation((key: string, defaultVal: any) => {
            if (key === `todayStats:${getTodayStatsKey(mockConfig.userId)}`) {
                return {
                    date: todayKey,
                    tokens: 500,
                    requests: 3,
                };
            }
            return defaultVal;
        });

        const newTracker = new TokenTracker(mockConfig, mockGlobalState, eventBus);

        expect(newTracker.todayTokens).toBe(500);
        expect(newTracker.todayRequests).toBe(3);
    });

    test('should switch to the persisted stats of the new user scope', () => {
        const todayKey = new Date().toISOString().slice(0, 10);
        mockGlobalState.get.mockImplementation((key: string, defaultVal: any) => {
            if (key === `todayStats:${getTodayStatsKey('user123')}`) {
                return { date: todayKey, tokens: 500, requests: 3 };
            }
            if (key === `todayStats:${getTodayStatsKey('user456')}`) {
                return { date: todayKey, tokens: 120, requests: 2 };
            }
            if (key === `offlineQueue:${getTodayStatsKey('user123')}` || key === `offlineQueue:${getTodayStatsKey('user456')}`) {
                return [];
            }
            return defaultVal;
        });

        const scopedTracker = new TokenTracker(mockConfig, mockGlobalState, eventBus);
        expect(scopedTracker.todayTokens).toBe(500);
        expect(scopedTracker.todayRequests).toBe(3);

        scopedTracker.updateConfig({
            ...mockConfig,
            userId: 'user456',
            userName: 'New User',
        });

        expect(scopedTracker.todayTokens).toBe(120);
        expect(scopedTracker.todayRequests).toBe(2);
    });

    test('should update config', () => {
        const newConfig = {
            ...mockConfig,
            userId: 'user456',
            userName: 'New User',
        };

        tracker.updateConfig(newConfig);

        // Verify config was updated (indirectly by checking it doesn't error)
        expect(tracker.todayTokens).toBe(0);
    });

    test('should isolate persisted scope by IDE app name for the same user', () => {
        const todayKey = new Date().toISOString().slice(0, 10);
        mockGlobalState.get.mockImplementation((key: string, defaultVal: any) => {
            if (key === `todayStats:${getTodayStatsKey('user123', 'vscode')}`) {
                return { date: todayKey, tokens: 500, requests: 3 };
            }
            if (key === `todayStats:${getTodayStatsKey('user123', 'cursor')}`) {
                return { date: todayKey, tokens: 120, requests: 2 };
            }
            if (key === `offlineQueue:${getTodayStatsKey('user123', 'vscode')}` || key === `offlineQueue:${getTodayStatsKey('user123', 'cursor')}`) {
                return [];
            }
            return defaultVal;
        });

        (vscode.env as any).appName = 'Visual Studio Code';
        const vscodeTracker = new TokenTracker(mockConfig, mockGlobalState, eventBus);
        expect(vscodeTracker.todayTokens).toBe(500);
        expect(vscodeTracker.todayRequests).toBe(3);
        vscodeTracker.stop();

        (vscode.env as any).appName = 'Cursor';
        const cursorTracker = new TokenTracker(mockConfig, mockGlobalState, eventBus);
        expect(cursorTracker.todayTokens).toBe(120);
        expect(cursorTracker.todayRequests).toBe(2);
        cursorTracker.stop();
    });

    test('should generate unique request IDs', () => {
        tracker.start();

        const usageRecord1: UsageRecord = {
            vendor: 'openai',
            model: 'gpt-4',
            endpoint: '/v1/chat/completions',
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            requestTime: new Date().toISOString(),
            source: 'vscode-lm',
            sourceApp: 'Visual Studio Code',
        };

        const usageRecord2: UsageRecord = {
            ...usageRecord1,
            promptTokens: 200,
            totalTokens: 250,
        };

        tracker.addRecord(usageRecord1);
        tracker.addRecord(usageRecord2);

        // Both records should have different IDs if not specified
        expect(usageRecord1.requestId).toBeDefined();
        expect(usageRecord2.requestId).toBeDefined();
        expect(usageRecord1.requestId).not.toBe(usageRecord2.requestId);
    });

    test('should accumulate stats from multiple events', () => {
        tracker.start();

        const records: UsageRecord[] = [
            {
                vendor: 'openai',
                model: 'gpt-4',
                endpoint: '/v1/chat/completions',
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
                requestTime: new Date().toISOString(),
                source: 'vscode-lm',
                sourceApp: 'Visual Studio Code',
            },
            {
                vendor: 'claude',
                model: 'claude-3-opus',
                endpoint: '/v1/messages',
                promptTokens: 200,
                completionTokens: 100,
                totalTokens: 300,
                requestTime: new Date().toISOString(),
                source: 'vscode-tool',
                sourceApp: 'Visual Studio Code',
            },
            {
                vendor: 'openai',
                model: 'gpt-3.5-turbo',
                endpoint: '/v1/chat/completions',
                promptTokens: 50,
                completionTokens: 25,
                totalTokens: 75,
                requestTime: new Date().toISOString(),
                source: 'vscode-lm',
                sourceApp: 'Visual Studio Code',
            },
        ];

        records.forEach(record => tracker.addRecord(record));

        expect(tracker.todayTokens).toBe(525); // 150 + 300 + 75
        expect(tracker.todayRequests).toBe(3);
    });

    test('marks collect status as config_incomplete when reporting config is missing', async () => {
        const incompleteTracker = new TokenTracker({
            ...mockConfig,
            userName: '',
        }, mockGlobalState, eventBus);

        incompleteTracker.addRecord({
            vendor: 'openai',
            model: 'gpt-4',
            endpoint: '/v1/chat/completions',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            requestTime: new Date().toISOString(),
            source: 'vscode-lm',
            sourceApp: 'Visual Studio Code',
        });

        await incompleteTracker.flushOfflineQueue();

        expect(incompleteTracker.getRuntimeStatus()).toEqual(expect.objectContaining({
            pendingQueueLength: 1,
            lastCollectError: '上报地址、工号或姓名未填写完整',
            lastCollectErrorCategory: 'config_incomplete',
            lastCollectHttpStatus: undefined,
        }));

        incompleteTracker.stop();
    });

    test('parses identity conflict response into structured collect status', async () => {
        mockHttpResponse(409, JSON.stringify({
            detail: {
                code: 'identity_conflict',
                message: '工号 10001 已绑定姓名“张三”，与当前填写的“李四”不一致。',
            },
        }));

        tracker.addRecord({
            vendor: 'openai',
            model: 'gpt-4',
            endpoint: '/v1/chat/completions',
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            requestTime: new Date().toISOString(),
            source: 'vscode-lm',
            sourceApp: 'Visual Studio Code',
        });

        await tracker.flushOfflineQueue();

        expect(tracker.getRuntimeStatus()).toEqual(expect.objectContaining({
            pendingQueueLength: 1,
            lastCollectErrorCategory: 'identity_conflict',
            lastCollectHttpStatus: 409,
            lastCollectErrorCode: 'identity_conflict',
            lastCollectError: '最近一次上报失败：工号 10001 已绑定姓名“张三”，与当前填写的“李四”不一致。',
        }));
    });
});
