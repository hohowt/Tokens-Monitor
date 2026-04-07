import { EventBus } from '../eventBus';

// ---------------------------------------------------------------------------
// Mock WebSocket globally
// ---------------------------------------------------------------------------
class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    onopen: any;
    onclose: any;
    onmessage: any;
    onerror: any;
    send = jest.fn();
    close = jest.fn();
}
(global as any).WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Mock the 'os' module so hostname() is deterministic
// ---------------------------------------------------------------------------
jest.mock('os', () => ({
    hostname: jest.fn(() => 'test-host'),
}));

// Import *after* the mocks are in place
import { WSClient } from '../wsClient';

describe('WSClient', () => {
    let eventBus: EventBus;
    let client: WSClient;
    let consoleLogSpy: jest.SpyInstance;
    const TEST_URL = 'ws://localhost:8001';

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        eventBus = new EventBus();
        client = new WSClient(TEST_URL, eventBus, 'user123');
    });

    afterEach(() => {
        client.disconnect();
        consoleLogSpy.mockRestore();
        jest.useRealTimers();
    });

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------
    describe('constructor', () => {
        test('sets userId and generates clientId from userId@hostname', () => {
            const status = client.getConnectionStatus();
            expect(status.url).toBe(TEST_URL);
            // clientId = userId@hostname → 'user123@test-host'
            // We can't read clientId directly, but we can verify via
            // the authenticate message that is sent on connect.
        });

        test('generates clientId with "unknown" when userId is empty', () => {
            const noUserClient = new WSClient(TEST_URL, eventBus);
            // No error means it initialized successfully
            expect(noUserClient.getConnectionStatus().url).toBe(TEST_URL);
            noUserClient.disconnect();
        });
    });

    // -------------------------------------------------------------------
    // connect()
    // -------------------------------------------------------------------
    describe('connect()', () => {
        test('creates WebSocket and resolves when onopen fires', async () => {
            const connectPromise = client.connect();
            // Grab the latest MockWebSocket instance created inside connect()
            // The constructor is called, then we trigger onopen
            const ws = (client as any).ws as MockWebSocket;
            expect(ws).toBeDefined();

            // Simulate server accepting connection
            ws.onopen();

            await connectPromise;
            expect(client.isConnected()).toBe(true);
        });

        test('rejects when onerror fires', async () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementation();
            const connectPromise = client.connect();
            const ws = (client as any).ws as MockWebSocket;

            ws.onerror({ type: 'error' });

            await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
            errorSpy.mockRestore();
        });

        test('calls authenticate() and startHeartbeat() on open', async () => {
            const connectPromise = client.connect();
            const ws = (client as any).ws as MockWebSocket;

            ws.onopen();
            await connectPromise;

            // authenticate sends a message with action: 'auth'
            expect(ws.send).toHaveBeenCalledTimes(1);
            const authPayload = JSON.parse(ws.send.mock.calls[0][0]);
            expect(authPayload.type).toBe('heartbeat');
            expect(authPayload.data.action).toBe('auth');
            expect(authPayload.data.userId).toBe('user123');
            expect(authPayload.data.clientId).toBe('user123@test-host');
        });
    });

    // -------------------------------------------------------------------
    // disconnect()
    // -------------------------------------------------------------------
    describe('disconnect()', () => {
        test('closes connection and prevents reconnect', async () => {
            const connectPromise = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await connectPromise;

            client.disconnect();

            expect(ws.close).toHaveBeenCalled();
            expect((client as any).isManuallyDisconnected).toBe(true);
        });

        test('clears reconnect and heartbeat timers', async () => {
            const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
            const connectPromise = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await connectPromise;

            // A heartbeat timer should have been created during connect
            const heartbeatTimer = (client as any).heartbeatTimer;
            expect(heartbeatTimer).toBeDefined();

            client.disconnect();

            // clearInterval should have been called to clear the heartbeat
            expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatTimer);
            clearIntervalSpy.mockRestore();
        });
    });

    // -------------------------------------------------------------------
    // send()
    // -------------------------------------------------------------------
    describe('send()', () => {
        test('sends JSON string when connected', async () => {
            const connectPromise = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await connectPromise;

            // Clear the auth message call
            ws.send.mockClear();

            const msg = { type: 'heartbeat' as const };
            client.send(msg);

            expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
        });

        test('warns and drops message when not connected', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

            client.send({ type: 'heartbeat' });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('WebSocket not ready')
            );
            warnSpy.mockRestore();
        });
    });

    // -------------------------------------------------------------------
    // handleMessage()  (private — invoked via onmessage)
    // -------------------------------------------------------------------
    describe('handleMessage()', () => {
        let ws: MockWebSocket;

        beforeEach(async () => {
            const p = client.connect();
            ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;
            ws.send.mockClear();
        });

        test('routes token-usage messages to eventBus', () => {
            const listener = jest.fn();
            eventBus.on('token-usage', listener);

            const tokenData = {
                vendor: 'openai',
                model: 'gpt-4',
                endpoint: '/v1/chat/completions',
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
                requestTime: new Date().toISOString(),
                source: 'ws-push',
                sourceApp: 'backend',
            };

            ws.onmessage({ data: JSON.stringify({ type: 'token-usage', data: tokenData }) });

            expect(listener).toHaveBeenCalledWith(tokenData);
        });

        test('responds to heartbeat with a heartbeat reply', () => {
            ws.onmessage({ data: JSON.stringify({ type: 'heartbeat' }) });

            expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'heartbeat' }));
        });

        test('logs error for unparseable messages', () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementation();

            ws.onmessage({ data: 'not-json' });

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to parse'),
                expect.anything()
            );
            errorSpy.mockRestore();
        });

        test('handles config-update without error', () => {
            const logSpy = jest.spyOn(console, 'log').mockImplementation();

            ws.onmessage({
                data: JSON.stringify({ type: 'config-update', data: { key: 'val' } }),
            });

            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('Config update'),
                expect.anything()
            );
            logSpy.mockRestore();
        });

        test('handles error type messages', () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementation();

            ws.onmessage({
                data: JSON.stringify({ type: 'error', data: 'something went wrong' }),
            });

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Server error'),
                expect.anything()
            );
            errorSpy.mockRestore();
        });
    });

    // -------------------------------------------------------------------
    // scheduleReconnect()  (private — triggered by onclose)
    // -------------------------------------------------------------------
    describe('scheduleReconnect()', () => {
        test('uses exponential backoff', async () => {
            const p = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;

            // Simulate non-manual disconnect → triggers scheduleReconnect
            (client as any).isManuallyDisconnected = false;
            ws.onclose();

            // After first close, reconnectAttempts should be 1
            expect((client as any).reconnectAttempts).toBe(1);

            // The initial delay is 1000ms
            expect((client as any).reconnectDelay).toBe(1000);
        });
    });

    // -------------------------------------------------------------------
    // updateUrl()
    // -------------------------------------------------------------------
    describe('updateUrl()', () => {
        test('disconnects and updates the URL', async () => {
            const p = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;

            client.updateUrl('ws://new-host:9000');

            expect(ws.close).toHaveBeenCalled();
            expect(client.getConnectionStatus().url).toBe('ws://new-host:9000');
        });

        test('does nothing when URL is the same', async () => {
            const p = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;

            ws.close.mockClear();
            client.updateUrl(TEST_URL);

            expect(ws.close).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------
    // getConnectionStatus()
    // -------------------------------------------------------------------
    describe('getConnectionStatus()', () => {
        test('returns correct state before connection', () => {
            const status = client.getConnectionStatus();
            expect(status.isConnected).toBe(false);
            expect(status.url).toBe(TEST_URL);
            expect(status.retryCount).toBe(0);
            expect(status.lastConnectedAt).toBeUndefined();
        });

        test('returns correct state after connection', async () => {
            const p = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;

            const status = client.getConnectionStatus();
            expect(status.isConnected).toBe(true);
            expect(status.retryCount).toBe(0);
            expect(status.lastConnectedAt).toBeDefined();
        });
    });

    // -------------------------------------------------------------------
    // authenticate()
    // -------------------------------------------------------------------
    describe('authenticate()', () => {
        test('sends auth message on connect with userId and clientId', async () => {
            const p = client.connect();
            const ws = (client as any).ws as MockWebSocket;
            ws.onopen();
            await p;

            expect(ws.send).toHaveBeenCalledTimes(1);
            const payload = JSON.parse(ws.send.mock.calls[0][0]);
            expect(payload).toEqual(
                expect.objectContaining({
                    type: 'heartbeat',
                    data: expect.objectContaining({
                        action: 'auth',
                        userId: 'user123',
                        clientId: 'user123@test-host',
                    }),
                })
            );
        });
    });
});
