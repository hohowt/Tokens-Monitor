/**
 * Cline 数据收集器
 * 通过跨扩展 API 通信获取 Cline 的 Token 使用数据
 */

import * as vscode from 'vscode';
import { BaseDataCollector } from '../dataCollector';

export class ClineCollector extends BaseDataCollector {
    readonly name = 'cline-collector';
    private clineExtension?: vscode.Extension<any>;
    private clineApi?: any;
    private disposables: vscode.Disposable[] = [];

    async init(): Promise<void> {
        try {
            // 获取 Cline 扩展
            const clineExt = vscode.extensions.getExtension('saoudrizwan.claude-dev');
            if (!clineExt) {
                console.log('[ClineCollector] Cline extension not found');
                return;
            }

            this.clineExtension = clineExt;

            // 如果扩展未激活，激活它
            if (!clineExt.isActive) {
                console.log('[ClineCollector] Activating Cline extension...');
                await clineExt.activate();
            }

            // 获取扩展的导出 API
            this.clineApi = clineExt.exports;
            console.log('[ClineCollector] Cline extension API loaded');
        } catch (err) {
            console.warn('[ClineCollector] Failed to initialize Cline API:', err);
        }
    }

    async start(): Promise<void> {
        if (!this.clineApi) {
            console.log('[ClineCollector] Cline API not available');
            return;
        }

        try {
            // 尝试监听 Cline 的 Token 使用事件
            if (this.clineApi.onTokenUsage) {
                const disposable = this.clineApi.onTokenUsage((data: any) => {
                    console.log('[ClineCollector] Received token usage from Cline:', data);
                    this.handleClineTokenUsage(data);
                });
                this.disposables.push(disposable);
                console.log('[ClineCollector] Listening for token usage events');
            } else {
                console.log('[ClineCollector] Cline API does not expose onTokenUsage event');
            }

            // 尝试监听其他相关事件
            if (this.clineApi.onTaskComplete) {
                const disposable = this.clineApi.onTaskComplete((data: any) => {
                    console.log('[ClineCollector] Task completed from Cline');
                });
                this.disposables.push(disposable);
            }
        } catch (err) {
            console.warn('[ClineCollector] Error starting listener:', err);
        }
    }

    private handleClineTokenUsage(data: any): void {
        try {
            // 正规化 Cline 数据到标准的 UsageRecord 格式
            const normalizedData = {
                vendor: data.vendor || 'claude',
                model: data.model || 'claude-3-opus',
                endpoint: data.endpoint || '/api/messages',
                promptTokens: data.input_tokens || data.promptTokens || 0,
                completionTokens: data.output_tokens || data.completionTokens || 0,
                totalTokens: (data.input_tokens || data.promptTokens || 0) +
                            (data.output_tokens || data.completionTokens || 0),
                requestTime: new Date().toISOString(),
                source: 'cline-extension',
                sourceApp: 'Cline',
                requestId: data.requestId,
                modelFamily: 'claude',
                modelVersion: data.modelVersion,
            };

            this.emitTokenUsage(normalizedData);
        } catch (err) {
            console.warn('[ClineCollector] Error handling Cline token usage:', err);
        }
    }

    async stop(): Promise<void> {
        // 清理所有监听器
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        console.log('[ClineCollector] Stopped');
    }
}
