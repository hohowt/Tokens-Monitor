import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';

export class StatusBarManager {
    private item: vscode.StatusBarItem;
    private tracker: TokenTracker;
    private timer?: ReturnType<typeof setInterval>;
    private reloadPending = false;

    constructor(tracker: TokenTracker) {
        this.tracker = tracker;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'tokenMonitor.showDashboard';
        this.item.tooltip = '腾轩 Tokens 监控 — 点击查看数据看板';
    }

    show() {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        this.refresh();
        this.item.show();
        this.timer = setInterval(() => this.refresh(), 5_000);
    }

    setReloadPending(pending: boolean) {
        this.reloadPending = pending;
        this.refresh();
    }

    refresh() {
        if (this.reloadPending) {
            this.item.text = '$(warning) 需重载';
            this.item.tooltip = 'AI Token 监控已接管当前窗口代理，但当前窗口尚未重载；重载后才会开始采集并上报 Token。点击打开监控面板。';
            return;
        }

        const tokens = this.tracker.todayTokens;
        let display: string;
        if (tokens >= 1_000_000) {
            display = `${(tokens / 1_000_000).toFixed(1)}M`;
        } else if (tokens >= 1_000) {
            display = `${(tokens / 1_000).toFixed(1)}K`;
        } else {
            display = `${tokens}`;
        }
        this.item.text = `$(pulse) 今日: ${display} Tokens`;
        this.item.tooltip = '腾轩 Tokens 监控 — 点击查看数据看板';
    }

    dispose() {
        if (this.timer) clearInterval(this.timer);
        this.item.dispose();
    }
}
