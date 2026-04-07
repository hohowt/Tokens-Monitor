/**
 * 数据收集器接口
 * 所有数据源（Copilot、WebSocket推送、本地LM等）应实现此接口
 */

import { EventBus } from './eventBus';

export interface DataCollector {
    /**
     * 收集器名称
     */
    readonly name: string;

    /**
     * 初始化收集器
     */
    init(): Promise<void>;

    /**
     * 启动数据收集
     */
    start(): Promise<void>;

    /**
     * 停止数据收集
     */
    stop(): Promise<void>;
}

/**
 * 抽象基类，简化必要实现
 */
export abstract class BaseDataCollector implements DataCollector {
    protected eventBus: EventBus;

    abstract readonly name: string;

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
    }

    async init(): Promise<void> {
        // Override in subclass if needed
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    /**
     * 发送 token 使用事件
     */
    protected emitTokenUsage(data: {
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
    }): void {
        this.eventBus.emit('token-usage', data);
    }
}
