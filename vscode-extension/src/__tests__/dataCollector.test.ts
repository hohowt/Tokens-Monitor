import { EventBus } from '../eventBus';
import { BaseDataCollector } from '../dataCollector';

// ---------------------------------------------------------------------------
// Concrete subclass used for testing the abstract BaseDataCollector
// ---------------------------------------------------------------------------
class TestCollector extends BaseDataCollector {
    readonly name = 'test-collector';

    public started = false;
    public stopped = false;

    async start(): Promise<void> {
        this.started = true;
    }

    async stop(): Promise<void> {
        this.stopped = true;
    }

    /** Expose the protected method for testing */
    public doEmit(data: any): void {
        this.emitTokenUsage(data);
    }
}

describe('BaseDataCollector', () => {
    let eventBus: EventBus;
    let collector: TestCollector;

    beforeEach(() => {
        eventBus = new EventBus();
        collector = new TestCollector(eventBus);
    });

    // -------------------------------------------------------------------
    // name
    // -------------------------------------------------------------------
    test('name is set correctly in subclass', () => {
        expect(collector.name).toBe('test-collector');
    });

    // -------------------------------------------------------------------
    // init()
    // -------------------------------------------------------------------
    test('init() is a no-op by default and resolves', async () => {
        await expect(collector.init()).resolves.toBeUndefined();
    });

    // -------------------------------------------------------------------
    // start() / stop()
    // -------------------------------------------------------------------
    test('start() can be implemented by subclass', async () => {
        await collector.start();
        expect(collector.started).toBe(true);
    });

    test('stop() can be implemented by subclass', async () => {
        await collector.stop();
        expect(collector.stopped).toBe(true);
    });

    // -------------------------------------------------------------------
    // emitTokenUsage()
    // -------------------------------------------------------------------
    test('emitTokenUsage() emits token-usage event to eventBus', () => {
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
            source: 'test-collector',
            sourceApp: 'Visual Studio Code',
        };

        collector.doEmit(tokenData);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(tokenData);
    });

    test('emitTokenUsage() includes optional fields when provided', () => {
        const listener = jest.fn();
        eventBus.on('token-usage', listener);

        const tokenData = {
            vendor: 'anthropic',
            model: 'claude-3-opus',
            endpoint: '/v1/messages',
            promptTokens: 200,
            completionTokens: 100,
            totalTokens: 300,
            requestTime: new Date().toISOString(),
            source: 'test-collector',
            sourceApp: 'Visual Studio Code',
            requestId: 'req-123',
            modelFamily: 'claude',
            modelVersion: '3.0',
        };

        collector.doEmit(tokenData);

        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: 'req-123',
                modelFamily: 'claude',
                modelVersion: '3.0',
            })
        );
    });

    test('emitTokenUsage() works with multiple listeners', () => {
        const listener1 = jest.fn();
        const listener2 = jest.fn();
        eventBus.on('token-usage', listener1);
        eventBus.on('token-usage', listener2);

        const tokenData = {
            vendor: 'openai',
            model: 'gpt-4',
            endpoint: '/v1/chat/completions',
            promptTokens: 50,
            completionTokens: 25,
            totalTokens: 75,
            requestTime: new Date().toISOString(),
            source: 'test-collector',
            sourceApp: 'Visual Studio Code',
        };

        collector.doEmit(tokenData);

        expect(listener1).toHaveBeenCalledTimes(1);
        expect(listener2).toHaveBeenCalledTimes(1);
    });
});
