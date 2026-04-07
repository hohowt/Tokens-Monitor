import * as vscode from 'vscode';

interface ConfigResult {
    configured: number;
    skipped: number;
    errors: string[];
}

export class AutoConfig {
    async configureAll(): Promise<ConfigResult> {
        // Auto-configuration of other extensions has been removed.
        // Users can manually configure Continue, Cline, and other tools if needed.
        return { configured: 0, skipped: 0, errors: [] };
    }
}
