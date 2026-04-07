import * as vscode from 'vscode';

export interface MonitorConfig {
    serverUrl: string;
    userId: string;
    userName: string;
    department: string;
    copilotOrg: string;
    transparentMode: boolean;
    proxyPort: number;
    gatewayPort: number;
    upstreamProxy: string;
}

function getPort(value: number | undefined, fallback: number): number {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) {
        return value;
    }
    return fallback;
}

export function getConfig(): MonitorConfig {
    const cfg = vscode.workspace.getConfiguration('aiTokenMonitor');
    return {
        serverUrl: cfg.get<string>('serverUrl', 'http://192.168.0.135:8000').replace(/\/+$/, ''),
        userId: cfg.get<string>('userId', ''),
        userName: cfg.get<string>('userName', ''),
        department: cfg.get<string>('department', ''),
        copilotOrg: cfg.get<string>('copilotOrg', ''),
        transparentMode: cfg.get<boolean>('transparentMode', true),
        proxyPort: getPort(cfg.get<number>('proxyPort', 18090), 18090),
        gatewayPort: getPort(cfg.get<number>('gatewayPort', 18091), 18091),
        upstreamProxy: cfg.get<string>('upstreamProxy', '').trim(),
    };
}

/** 返回当前编辑器的原始名称，如 "Visual Studio Code"、"Cursor"、"Kiro" */
export function getAppName(): string {
    return vscode.env.appName;
}

/** 将 appName 映射为简短标识符，用于 source 字段拼接 */
export function getNormalizedAppName(): string {
    const name = vscode.env.appName;
    const map: Record<string, string> = {
        'Visual Studio Code': 'vscode',
        'Visual Studio Code - Insiders': 'vscode-insiders',
        'Cursor': 'cursor',
        'Kiro': 'kiro',
    };
    return map[name] || name.toLowerCase().replace(/\s+/g, '-');
}
