/**
 * Cursor 数据收集器
 * 通过应用检测 + LM API 监听实现 Cursor 应用的无感监控
 */

import * as vscode from 'vscode';
import { BaseDataCollector } from '../dataCollector';
import { UsageRecord } from '../tokenTracker';

export class CursorCollector extends BaseDataCollector {
    readonly name = 'cursor-collector';
    private pollTimer?: ReturnType<typeof setInterval>;
    private lastMetrics: any = null;

    async init(): Promise<void> {
        // Initialization if needed
    }

    async start(): Promise<void> {
        // 检测是否在 Cursor 环境
        const appName = vscode.env.appName;
        if (appName !== 'Cursor') {
            console.log(`[CursorCollector] Not in Cursor environment (${appName}), skipping`);
            return;
        }

        console.log('[CursorCollector] Cursor environment detected, starting monitoring');

        // 应用名称映射
        // 轮询检查 Cursor 特定的指标（虽然 Cursor 没有公开的 API，但我们可以通过以下方式获取数据）
        // 对于现阶段，主要依赖后端推送和 @monitor
        // 以及通过 EventBus 接收来自其他数据源的数据

        // 可选：轮询检查 vscode.lm API 的模型使用情况
        this.pollTimer = setInterval(() => {
            this.collectMetrics();
        }, 60_000); // 60 秒检查一次

        console.log('[CursorCollector] Started with 60s polling interval');
    }

    private async collectMetrics(): Promise<void> {
        try {
            // 在 Cursor 中，我们可以通过以下方式尝试获取使用统计
            // 注意：Cursor 没有公开的 token 统计 API，所以这里主要是占位符
            // 真实的监控由后端推送和 @monitor 提供

            // 可以尝试访问 Cursor 特定的全局状态或配置
            // 但目前 Cursor API 文档有限，所以我们依赖被动的数据接收
        } catch (err) {
            console.warn('[CursorCollector] Error collecting metrics:', err);
        }
    }

    async stop(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        console.log('[CursorCollector] Stopped');
    }
}
