import * as https from 'https';
import * as vscode from 'vscode';
import { MonitorConfig } from './config';
import { TokenTracker } from './tokenTracker';

interface CopilotUsageDay {
    day: string;
    total_suggestions_count?: number;
    total_acceptances_count?: number;
    total_lines_suggested?: number;
    total_lines_accepted?: number;
    total_active_users?: number;
    breakdown?: CopilotBreakdown[];
}

interface CopilotBreakdown {
    language: string;
    editor: string;
    suggestions_count: number;
    acceptances_count: number;
    lines_suggested: number;
    lines_accepted: number;
    active_users: number;
}

export class CopilotMetrics {
    private config: MonitorConfig;
    private tracker: TokenTracker;
    private secrets: vscode.SecretStorage;
    private timer?: ReturnType<typeof setInterval>;

    constructor(config: MonitorConfig, tracker: TokenTracker, secrets: vscode.SecretStorage) {
        this.config = config;
        this.tracker = tracker;
        this.secrets = secrets;
    }

    startPolling() {
        // Poll every 6 hours (data is delayed ~24h anyway)
        this.timer = setInterval(() => this.fetchAndReport(), 6 * 60 * 60 * 1000);
        // Initial fetch after 30s
        setTimeout(() => this.fetchAndReport(), 30_000);
    }

    stopPolling() {
        if (this.timer) clearInterval(this.timer);
    }

    private async fetchAndReport(): Promise<void> {
        if (!this.config.copilotOrg) return;
        const pat = await this.secrets.get('copilotPat');
        if (!pat) return;

        try {
            const data = await this.fetchCopilotUsage(pat);
            if (!data || data.length === 0) return;

            // Report the latest day's data
            const latest = data[data.length - 1];
            if (!latest.breakdown) return;

            for (const breakdown of latest.breakdown) {
                const suggestions = breakdown.suggestions_count || 0;
                if (suggestions === 0) continue;

                this.tracker.addRecord({
                    vendor: 'github-copilot',
                    model: 'copilot-completions',
                    endpoint: '/copilot/suggestions',
                    promptTokens: breakdown.acceptances_count || 0,
                    completionTokens: suggestions,
                    totalTokens: suggestions + (breakdown.acceptances_count || 0),
                    requestTime: latest.day + 'T00:00:00Z',
                    source: 'copilot-metrics-api',
                    sourceApp: breakdown.editor || 'unknown',
                });
            }
        } catch (err) {
            console.error('[CopilotMetrics] fetch failed:', err);
        }
    }

    private fetchCopilotUsage(pat: string): Promise<CopilotUsageDay[]> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/orgs/${encodeURIComponent(this.config.copilotOrg)}/copilot/usage`,
                method: 'GET',
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'Authorization': `Bearer ${pat}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'ai-token-monitor-vscode/0.1.0',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(body));
                        } catch {
                            reject(new Error('Invalid JSON from Copilot API'));
                        }
                    } else {
                        reject(new Error(`GitHub API returned ${res.statusCode}: ${body.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }
}
