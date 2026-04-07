import { EventBus } from '../eventBus';

describe('EventBus', () => {
    let eventBus: EventBus;

    beforeEach(() => {
        eventBus = new EventBus();
    });

    test('should emit and receive events', () => {
        const listener = jest.fn();
        eventBus.on('token-usage', listener);

        const data = {
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

        eventBus.emit('token-usage', data);

        expect(listener).toHaveBeenCalledWith(data);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('should support multiple listeners', () => {
        const listener1 = jest.fn();
        const listener2 = jest.fn();
        eventBus.on('token-usage', listener1);
        eventBus.on('token-usage', listener2);

        const data = {
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

        eventBus.emit('token-usage', data);

        expect(listener1).toHaveBeenCalled();
        expect(listener2).toHaveBeenCalled();
    });

    test('should unsubscribe listeners', () => {
        const listener = jest.fn();
        eventBus.on('token-usage', listener);
        eventBus.off('token-usage', listener);

        const data = {
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

        eventBus.emit('token-usage', data);

        expect(listener).not.toHaveBeenCalled();
    });

    test('should handle listener errors gracefully', () => {
        const errorListener = jest.fn(() => {
            throw new Error('Listener error');
        });
        const normalListener = jest.fn();
        eventBus.on('token-usage', errorListener);
        eventBus.on('token-usage', normalListener);

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const data = {
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

        eventBus.emit('token-usage', data);

        expect(errorListener).toHaveBeenCalled();
        expect(normalListener).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
    });

    test('should clear all listeners', () => {
        const listener1 = jest.fn();
        const listener2 = jest.fn();
        eventBus.on('token-usage', listener1);
        eventBus.on('token-usage', listener2);

        eventBus.clear();

        const data = {
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

        eventBus.emit('token-usage', data);

        expect(listener1).not.toHaveBeenCalled();
        expect(listener2).not.toHaveBeenCalled();
    });
});
