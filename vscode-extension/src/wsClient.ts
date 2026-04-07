/**
 * WebSocket 长连接客户端
 * 用于接收后端推送的指令和数据
 *
 * 后端消息格式：
 * {
 *   type: 'token-usage' | 'config' | 'command',
 *   data: {...}
 * }
 */

import { EventBus } from './eventBus';

export interface WSMessage {
    type: 'token-usage' | 'config-update' | 'command' | 'heartbeat' | 'error';
    data?: any;
    requestId?: string;
}

export class WSClient {
    private url: string;
    private eventBus: EventBus;
    private ws?: WebSocket;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private reconnectDelay = 1000; // Start with 1s
    private maxReconnectDelay = 30000; // Cap at 30s
    private isManuallyDisconnected = false;
    private userId: string = '';
    private clientId: string = '';
    private lastConnectedAt?: string;
    private reconnectAttempts = 0;

    constructor(url: string, eventBus: EventBus, userId?: string) {
        this.url = url;
        this.eventBus = eventBus;
        this.userId = userId || '';
        this.clientId = this.generateClientId();
    }

    private generateClientId(): string {
        // Get hostname from OS rather than window object (VSCode extensions run in Node.js)
        const os = require('os');
        const hostname = os.hostname?.() || 'unknown';
        return `${this.userId || 'unknown'}@${hostname}`;
    }

    /**
     * 尝试连接到 WebSocket 服务器
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    console.log('[WSClient] Connected');
                    this.lastConnectedAt = new Date().toISOString();
                    this.reconnectDelay = 1000; // Reset reconnect delay on success
                    this.reconnectAttempts = 0;
                    this.authenticate();  // Send authentication after connection
                    this.startHeartbeat();
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const msg: WSMessage = JSON.parse(event.data);
                        this.handleMessage(msg);
                    } catch (err) {
                        console.error('[WSClient] Failed to parse message:', err);
                    }
                };

                this.ws.onerror = (event) => {
                    console.error('[WSClient] WebSocket error:', event);
                    reject(new Error('WebSocket connection failed'));
                };

                this.ws.onclose = () => {
                    console.log('[WSClient] Disconnected');
                    this.stopHeartbeat();
                    if (!this.isManuallyDisconnected) {
                        this.scheduleReconnect();
                    }
                };
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        this.isManuallyDisconnected = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.ws) this.ws.close();
    }

    /**
     * 发送消息到服务器
     */
    send(msg: WSMessage): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            console.warn('[WSClient] WebSocket not ready, message dropped');
        }
    }

    /**
     * 处理从服务器收到的消息
     */
    private handleMessage(msg: WSMessage): void {
        switch (msg.type) {
            case 'token-usage':
                // 后端推送的 token 使用数据
                if (msg.data) {
                    this.eventBus.emit('token-usage', msg.data);
                }
                break;
            case 'config-update':
                // 后端推送的配置更新
                console.log('[WSClient] Config update:', msg.data);
                break;
            case 'command':
                // 后端推送的指令
                console.log('[WSClient] Command:', msg.data);
                break;
            case 'heartbeat':
                // Keep-alive ping from server
                this.send({ type: 'heartbeat' });
                break;
            case 'error':
                console.error('[WSClient] Server error:', msg.data);
                break;
            default:
                console.warn('[WSClient] Unknown message type:', (msg as any).type);
        }
    }

    /**
     * 启动心跳机制
     */
    private startHeartbeat(): void {
        // 每 30 秒发送一次心跳
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: 'heartbeat' });
        }, 30_000);
    }

    /**
     * 停止心跳机制
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    /**
     * 计划重新连接
     */
    private scheduleReconnect(): void {
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            console.log(`[WSClient] Reconnecting (attempt ${this.reconnectAttempts})...`);
            this.isManuallyDisconnected = false;
            this.connect().catch(err => {
                console.error('[WSClient] Reconnection failed:', err);
                // Double the delay for next attempt
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
                this.scheduleReconnect();
            });
        }, this.reconnectDelay);
    }

    /**
     * 检查连接状态
     */
    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * 获取详细的连接状态信息
     */
    public getConnectionStatus(): {
        isConnected: boolean;
        url: string;
        retryCount: number;
        lastConnectedAt?: string;
    } {
        return {
            isConnected: this.isConnected(),
            url: this.url,
            retryCount: this.reconnectAttempts,
            lastConnectedAt: this.lastConnectedAt,
        };
    }

    /**
     * 动态更新 WebSocket URL
     */
    public updateUrl(newUrl: string): void {
        if (newUrl !== this.url) {
            console.log(`[WSClient] Updating URL from ${this.url} to ${newUrl}`);
            this.disconnect();
            this.url = newUrl;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
        }
    }

    /**
     * 认证握手
     */
    private authenticate(): void {
        const authMsg: WSMessage = {
            type: 'heartbeat',
            data: {
                action: 'auth',
                userId: this.userId,
                clientId: this.clientId,
                timestamp: new Date().toISOString()
            }
        };
        this.send(authMsg);
        console.log('[WSClient] Authentication message sent');
    }
}
