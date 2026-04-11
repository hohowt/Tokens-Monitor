import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';
import { getAppName, getNormalizedAppName } from './config';
import { EventBus } from './eventBus';

/**
 * 中文友好的 token 粘估：中文字符约 1.5 token，ASCII 约 0.25 token。
 * 仅在 countTokens API 抛出异常时作回退用。
 */
function roughTokenCount(text: string): number {
    let tokens = 0;
    for (const ch of text) {
        tokens += ch.charCodeAt(0) > 127 ? 1.5 : 0.25;
    }
    return Math.ceil(tokens);
}

async function safeCountTokens(model: vscode.LanguageModelChat, text: string): Promise<number> {
    try {
        return await model.countTokens(text);
    } catch {
        return roughTokenCount(text);
    }
}

async function runToolWithTracking(
    prompt: string,
    endpoint: string,
    tracker: TokenTracker,
    eventBus: EventBus | undefined,
    token: vscode.CancellationToken,
): Promise<string> {
    const models = await vscode.lm.selectChatModels({});
    if (models.length === 0) return 'No model available.';
    const model = models[0];

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const inputTokens = await safeCountTokens(model, prompt);
    const requestTime = new Date().toISOString();

    let output = '';
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
        output += chunk;
    }

    const outputTokens = await safeCountTokens(model, output);

    const record = {
        vendor: model.vendor,
        model: model.id,
        endpoint,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestTime,
        source: `${getNormalizedAppName()}-tool`,
        sourceApp: getAppName(),
        modelFamily: model.family,
        modelVersion: (model as any).version as string | undefined,
    };

    if (eventBus) {
        eventBus.emit('token-usage', record);
    } else {
        tracker.addRecord(record);
    }

    return output;
}

export function registerTools(context: vscode.ExtensionContext, tracker: TokenTracker, eventBus?: EventBus) {
    try {
        const codeReviewTool = vscode.lm.registerTool('token-monitor-codeReview', {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ code: string }>,
                token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                const code = options.input.code || '';
                const output = await runToolWithTracking(
                    `Review the following code for bugs, performance issues, and best practices:\n\n\`\`\`\n${code}\n\`\`\``,
                    '/tool/code-review', tracker, eventBus, token,
                );
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
            },
            async prepareInvocation() {
                return { invocationMessage: 'Reviewing code...' };
            },
        });

        const explainCodeTool = vscode.lm.registerTool('token-monitor-explainCode', {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ code: string }>,
                token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                const code = options.input.code || '';
                const output = await runToolWithTracking(
                    `Explain what the following code does, step by step:\n\n\`\`\`\n${code}\n\`\`\``,
                    '/tool/explain-code', tracker, eventBus, token,
                );
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
            },
            async prepareInvocation() {
                return { invocationMessage: 'Explaining code...' };
            },
        });

        const generateTestsTool = vscode.lm.registerTool('token-monitor-generateTests', {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ code: string; language?: string }>,
                token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                const code = options.input.code || '';
                const lang = options.input.language || 'the same language';
                const output = await runToolWithTracking(
                    `Generate unit tests for the following code in ${lang}:\n\n\`\`\`\n${code}\n\`\`\``,
                    '/tool/generate-tests', tracker, eventBus, token,
                );
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
            },
            async prepareInvocation() {
                return { invocationMessage: 'Generating tests...' };
            },
        });

        const generateDocsTool = vscode.lm.registerTool('token-monitor-generateDocs', {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ code: string; style?: string }>,
                token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                const code = options.input.code || '';
                const style = options.input.style || 'JSDoc-style';
                const output = await runToolWithTracking(
                    `Generate ${style} documentation for the following code:\n\n\`\`\`\n${code}\n\`\`\``,
                    '/tool/generate-docs', tracker, eventBus, token,
                );
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
            },
            async prepareInvocation() {
                return { invocationMessage: 'Generating documentation...' };
            },
        });

        const refactorSuggestionsTool = vscode.lm.registerTool('token-monitor-refactorSuggestions', {
            async invoke(
                options: vscode.LanguageModelToolInvocationOptions<{ code: string; goal?: string }>,
                token: vscode.CancellationToken
            ): Promise<vscode.LanguageModelToolResult> {
                const code = options.input.code || '';
                const goal = options.input.goal;
                const output = await runToolWithTracking(
                    `Suggest refactoring improvements for the following code${goal ? ' with the goal of ' + goal : ''}:\n\n\`\`\`\n${code}\n\`\`\``,
                    '/tool/refactor-suggestions', tracker, eventBus, token,
                );
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
            },
            async prepareInvocation() {
                return { invocationMessage: 'Analyzing code for refactoring...' };
            },
        });

        context.subscriptions.push(codeReviewTool, explainCodeTool, generateTestsTool, generateDocsTool, refactorSuggestionsTool);
    } catch (err) {
        console.warn('[AI Token Monitor] Failed to register LM tools:', err);
    }
}
