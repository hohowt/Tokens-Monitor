/**
 * 简单的事件总线实现
 * 用于解耦各个模块（TokenTracker、ChatParticipant、Tools 等）
 */

type EventListener<T = any> = (data: T) => void;

interface EventMap {
    'token-usage': { vendor: string; model: string; endpoint: string; promptTokens: number; completionTokens: number; totalTokens: number; requestTime: string; source: string; sourceApp: string; requestId?: string; modelFamily?: string; modelVersion?: string };
    'stats-updated': void;
}

export class EventBus {
    private listeners: Map<keyof EventMap, Set<EventListener>> = new Map();

    /**
     * 订阅事件
     */
    on<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(listener as EventListener);
    }

    /**
     * 取消订阅
     */
    off<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): void {
        const set = this.listeners.get(event);
        if (set) {
            set.delete(listener as EventListener);
        }
    }

    /**
     * 发送事件（同步）
     */
    emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
        const set = this.listeners.get(event);
        if (set) {
            set.forEach(listener => {
                try {
                    listener(data);
                } catch (err) {
                    console.error(`[EventBus] Error in listener for event ${String(event)}:`, err);
                }
            });
        }
    }

    /**
     * 清空所有监听器
     */
    clear(): void {
        this.listeners.clear();
    }
}

// 全局事件总线实例
export const globalEventBus = new EventBus();
