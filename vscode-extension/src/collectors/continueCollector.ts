/**
 * Continue 数据收集器
 * 通过 Continue 插件的公开 API 或事件获取 Token 使用数据
 */

import * as vscode from 'vscode';
import { BaseDataCollector } from '../dataCollector';

export class ContinueCollector extends BaseDataCollector {
    readonly name = 'continue-collector';
    private continueExtension?: vscode.Extension<any>;
    private continueApi?: any;
    private disposables: vscode.Disposable[] = [];

    async init(): Promise<void> {
        try {
            // 获取 Continue 扩展
            // Continue 的扩展 ID 可能是 'ContinueDev.continue' 或其他
            const possibleIds = [
                'ContinueDev.continue',
                'continue.continue',
                'continue-extension.continue',
            ];

            for (const id of possibleIds) {
                const ext = vscode.extensions.getExtension(id);
                if (ext) {
                    this.continueExtension = ext;
                    console.log(`[ContinueCollector] Found Continue extension: ${id}`);
                    break;
                }
            }

            if (!this.continueExtension) {
                console.log('[ContinueCollector] Continue extension not found');
                return;
            }

            // 如果扩展未激活，激活它
            if (!this.continueExtension.isActive) {
                console.log('[ContinueCollector] Activating Continue extension...');
                await this.continueExtension.activate();
            }

            // 获取扩展的导出 API
            this.continueApi = this.continueExtension.exports;
            console.log('[ContinueCollector] Continue extension API loaded');
        } catch (err) {
            console.warn('[ContinueCollector] Failed to initialize Continue API:', err);
        }
    }

    async start(): Promise<void> {
        if (!this.continueApi) {
            console.log('[ContinueCollector] Continue API not available');
            return;
        }

        try {
            // 尝试监听 Continue 的 Token 使用事件
            if (this.continueApi.onTokenUsage) {
                const disposable = this.continueApi.onTokenUsage((data: any) => {
                    console.log('[ContinueCollector] Received token usage from Continue:', data);
                    this.handleContinueTokenUsage(data);
                });
                this.disposables.push(disposable);
                console.log('[ContinueCollector] Listening for token usage events');
            }

            // 尝试监听 API 调用事件
            if (this.continueApi.onAPICall) {
                const disposable = this.continueApi.onAPICall((data: any) => {
                    console.log('[ContinueCollector] API call from Continue');
                    this.handleContinueAPICall(data);
                });
                this.disposables.push(disposable);
            }
        } catch (err) {
            console.warn('[ContinueCollector] Error starting listener:', err);
        }
    }

    private handleContinueTokenUsage(data: any): void {
        try {
            // 正规化 Continue 数据到标准的 UsageRecord 格式
            const normalizedData = {
                vendor: data.vendor || 'openai',
                model: data.model || data.modelName || 'gpt-4',
                endpoint: data.endpoint || '/v1/chat/completions',
                promptTokens: data.promptTokens || data.input_tokens || 0,
                completionTokens: data.completionTokens || data.output_tokens || 0,
                totalTokens: (data.promptTokens || data.input_tokens || 0) +
                            (data.completionTokens || data.output_tokens || 0),
                requestTime: data.timestamp || new Date().toISOString(),
                source: 'continue-plugin',
                sourceApp: 'Continue',
                requestId: data.requestId || data.id,
                modelFamily: data.modelFamily || data.provider,
                modelVersion: data.modelVersion,
            };

            this.emitTokenUsage(normalizedData);
        } catch (err) {
            console.warn('[ContinueCollector] Error handling Continue token usage:', err);
        }
    }

    private handleContinueAPICall(data: any): void {
        try {
            // Continue 的 API 调用可能包含 Token 统计信息
            if (data.usage) {
                const normalizedData = {
                    vendor: data.model_id?.split('_')[0] || 'openai',
                    model: data.model_id || 'gpt-4',
                    endpoint: data.endpoint || '/v1/chat/completions',
                    promptTokens: data.usage.prompt_tokens || 0,
                    completionTokens: data.usage.completion_tokens || 0,
                    totalTokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0),
                    requestTime: new Date().toISOString(),
                    source: 'continue-api',
                    sourceApp: 'Continue',
                    requestId: data.request_id,
                };

                this.emitTokenUsage(normalizedData);
            }
        } catch (err) {
            console.warn('[ContinueCollector] Error handling Continue API call:', err);
        }
    }

    async stop(): Promise<void> {
        // 清理所有监听器
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        console.log('[ContinueCollector] Stopped');
    }
}
