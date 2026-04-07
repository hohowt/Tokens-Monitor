import * as vscode from 'vscode';
import { TokenTracker } from './tokenTracker';
import { getAppName, getNormalizedAppName } from './config';
import { EventBus } from './eventBus';

/** 将单条消息中的文本部分拼成字符串，供 token 估算回退使用 */
function messagePlainText(msg: vscode.LanguageModelChatMessage): string {
    const parts: string[] = [];
    for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        }
    }
    return parts.join('\n');
}

/**
 * 中文友好的 token 粗估：中文字符约 1.5 token，ASCII 约 0.25 token。
 * 仅在 countTokens API 抛出异常时作回退用。
 */
function roughTokenCount(text: string): number {
    let tokens = 0;
    for (const ch of text) {
        tokens += ch.charCodeAt(0) > 127 ? 1.5 : 0.25;
    }
    return Math.ceil(tokens);
}

/**
 * 对即将发给模型的完整消息列表统计输入 token（与仅统计当前句相比，多轮对话时更准确）。
 */
async function countInputTokensForMessages(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
): Promise<number> {
    let total = 0;
    for (const msg of messages) {
        try {
            total += await model.countTokens(msg, token);
        } catch {
            total += roughTokenCount(messagePlainText(msg));
        }
    }
    return total;
}

export function registerChatParticipant(context: vscode.ExtensionContext, tracker: TokenTracker, eventBus?: EventBus) {
    const participant = vscode.chat.createChatParticipant('token-monitor.otw', async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        // Use the model selected by the user in the chat panel
        const model = request.model;

        if (!request.prompt.trim()) {
            response.markdown('请输入你的问题或指令。');
            return;
        }

        // Build messages from history + current request
        const messages: vscode.LanguageModelChatMessage[] = [];

        // Replay history for context
        for (const turn of chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const parts: string[] = [];
                for (const part of turn.response) {
                    if (part instanceof vscode.ChatResponseMarkdownPart) {
                        parts.push(part.value.value);
                    }
                }
                if (parts.length > 0) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(parts.join('')));
                }
            }
        }

        // Current user message
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        const inputTokens = await countInputTokensForMessages(model, messages, token);

        // Send request and stream response
        const requestTime = new Date().toISOString();
        let outputText = '';

        try {
            const chatResponse = await model.sendRequest(messages, {}, token);

            for await (const chunk of chatResponse.text) {
                outputText += chunk;
                response.markdown(chunk);
            }
        } catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                response.markdown(`Error: ${err.message}`);
            }
            throw err;
        }

        // Count output tokens
        let outputTokens = 0;
        try {
            outputTokens = await model.countTokens(outputText);
        } catch {
            // fallback: Chinese-aware rough estimate
            outputTokens = roughTokenCount(outputText);
        }

        // Report usage via EventBus or directly to tracker
        const record = {
            vendor: model.vendor,
            model: model.id,
            endpoint: '/v1/chat/completions',
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
            requestTime,
            source: `${getNormalizedAppName()}-lm`,
            sourceApp: getAppName(),
            modelFamily: model.family,
            modelVersion: (model as any).version as string | undefined,
        };

        if (eventBus) {
            eventBus.emit('token-usage', record);
        } else {
            tracker.addRecord(record);
        }
    });

    participant.iconPath = new vscode.ThemeIcon('pulse');

    context.subscriptions.push(participant);
}
