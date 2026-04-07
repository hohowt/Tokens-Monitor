/**
 * Network Interceptor - 自动拦截所有 AI API 的网络请求
 *
 * 原理：VSCode 所有扩展运行在同一个 Extension Host 进程中，
 * 共享同一个 Node.js 的 http/https 模块。通过 monkey-patch
 * https.request，我们可以捕获所有扩展（Copilot、Cline、Continue 等）
 * 发往 AI API 的请求，并从响应中提取 token 用量。
 */

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { EventBus } from './eventBus';
import { getNormalizedAppName } from './config';

/** 输出通道用于可视化日志 */
let outputChannel: vscode.OutputChannel | undefined;
function log(msg: string): void {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('AI Token 拦截器');
        outputChannel.show(true); // 首次创建时自动打开 Output 面板
    }
    const ts = new Date().toISOString().slice(11, 23);
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

/** AI API 端点识别规则 */
interface ApiEndpoint {
    /** 匹配 hostname（支持通配符前缀 *） */
    host: string;
    /** 厂商标识 */
    vendor: string;
    /** 需要匹配的路径前缀（可选） */
    pathPrefix?: string;
}

const AI_ENDPOINTS: ApiEndpoint[] = [
    // OpenAI
    { host: 'api.openai.com', vendor: 'openai' },
    // Azure OpenAI (*.openai.azure.com)
    { host: '*.openai.azure.com', vendor: 'azure-openai' },
    // Anthropic
    { host: 'api.anthropic.com', vendor: 'anthropic' },
    // GitHub Copilot
    { host: 'api.githubcopilot.com', vendor: 'copilot' },
    { host: 'api-model-lab.githubcopilot.com', vendor: 'copilot' },
    { host: 'copilot-proxy.githubusercontent.com', vendor: 'copilot' },
    { host: '*.githubcopilot.com', vendor: 'copilot' },
    // Google Gemini / Vertex AI
    { host: 'generativelanguage.googleapis.com', vendor: 'google' },
    { host: '*.aiplatform.googleapis.com', vendor: 'google-vertex' },
    // Mistral
    { host: 'api.mistral.ai', vendor: 'mistral' },
    // Cohere
    { host: 'api.cohere.ai', vendor: 'cohere' },
    // DeepSeek
    { host: 'api.deepseek.com', vendor: 'deepseek' },
    // 通义千问 (Alibaba)
    { host: 'dashscope.aliyuncs.com', vendor: 'dashscope' },
    // 百度文心
    { host: 'aip.baidubce.com', vendor: 'wenxin' },
    // 豆包 (ByteDance)
    { host: 'ark.cn-beijing.volces.com', vendor: 'doubao' },
    // Ollama (local)
    { host: 'localhost', vendor: 'ollama', pathPrefix: '/api/' },
    { host: '127.0.0.1', vendor: 'ollama', pathPrefix: '/api/' },
];

/** 匹配 hostname */
function matchHost(hostname: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // e.g. ".openai.azure.com"
        return hostname.endsWith(suffix) || hostname === pattern.slice(2);
    }
    return hostname === pattern;
}

/** 识别请求是否是 AI API 调用 */
function identifyEndpoint(hostname: string, path: string): ApiEndpoint | undefined {
    for (const ep of AI_ENDPOINTS) {
        if (matchHost(hostname, ep.host)) {
            if (ep.pathPrefix && !path.startsWith(ep.pathPrefix)) {
                continue;
            }
            return ep;
        }
    }
    return undefined;
}

/** 从 OpenAI 兼容格式的响应中提取 usage */
function extractOpenAIUsage(body: any): { promptTokens: number; completionTokens: number; totalTokens: number; model: string } | null {
    if (!body || typeof body !== 'object') { return null; }

    const model = body.model || '';
    const usage = body.usage;
    if (!usage) { return null; }

    // OpenAI / Azure / DeepSeek / Mistral format
    if (typeof usage.prompt_tokens === 'number') {
        return {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || (usage.prompt_tokens + (usage.completion_tokens || 0)),
            model,
        };
    }
    // Anthropic format
    if (typeof usage.input_tokens === 'number') {
        return {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens + (usage.output_tokens || 0)),
            model,
        };
    }
    return null;
}

/** 从 SSE 流式响应中提取 usage（在最后的 data 块中） */
function extractStreamingUsage(chunks: string, vendor: string): { promptTokens: number; completionTokens: number; totalTokens: number; model: string } | null {
    // 从流中提取 model（通常在第一个 chunk）
    let model = '';
    const lines = chunks.split('\n');

    for (const line of lines) {
        if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') {
            continue;
        }
        try {
            const data = JSON.parse(line.slice(6));
            if (data.model && !model) {
                model = data.model;
            }
            // OpenAI streaming with include_usage
            if (data.usage) {
                const usage = extractOpenAIUsage(data);
                if (usage) { return usage; }
            }
            // Anthropic message_delta with usage
            if (data.type === 'message_delta' && data.usage) {
                return {
                    promptTokens: data.usage.input_tokens || 0,
                    completionTokens: data.usage.output_tokens || 0,
                    totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
                    model,
                };
            }
            // Anthropic message_start with usage
            if (data.type === 'message_start' && data.message?.usage) {
                // This only has input_tokens, completion comes in message_delta
                // Store for later combination
            }
        } catch {
            // Skip unparseable lines
        }
    }

    // If we found a model but no usage data in streaming, estimate from content
    if (model && chunks.length > 100) {
        return estimateFromStream(chunks, model);
    }
    return null;
}

/** 从流内容估算 token 数量（fallback） */
function estimateFromStream(chunks: string, model: string): { promptTokens: number; completionTokens: number; totalTokens: number; model: string } | null {
    let completionText = '';
    const lines = chunks.split('\n');
    for (const line of lines) {
        if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') { continue; }
        try {
            const data = JSON.parse(line.slice(6));
            // OpenAI format
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) { completionText += delta; }
            // Anthropic format
            if (data.type === 'content_block_delta' && data.delta?.text) {
                completionText += data.delta.text;
            }
        } catch { /* skip */ }
    }

    if (!completionText) { return null; }

    // Rough estimation: avg 4 chars per token for English, 1.5 chars per token for Chinese
    const chineseChars = (completionText.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = completionText.length - chineseChars;
    const estimatedCompletion = Math.ceil(chineseChars / 1.5 + otherChars / 4);

    return {
        promptTokens: 0, // 无法从流中得知 prompt tokens
        completionTokens: estimatedCompletion,
        totalTokens: estimatedCompletion,
        model,
    };
}

export class NetworkInterceptor {
    private originalHttpsRequest: typeof https.request | null = null;
    private originalHttpRequest: typeof http.request | null = null;
    private originalFetch: typeof globalThis.fetch | null = null;
    private originalDispatcher: any = null;
    private eventBus: EventBus;
    private active = false;
    /** 自身后端服务器地址，排除拦截 */
    private excludeHosts: Set<string> = new Set();

    constructor(eventBus: EventBus, selfServerUrl?: string) {
        this.eventBus = eventBus;
        // 排除自身服务器的请求
        if (selfServerUrl) {
            try {
                const url = new URL(selfServerUrl);
                this.excludeHosts.add(url.hostname);
            } catch { /* ignore */ }
        }
    }

    /** 启动拦截 */
    start(): void {
        if (this.active) { return; }
        this.active = true;
        log('Initializing NetworkInterceptor...');

        try { this.patchHttps(); log('✓ https.request hooked'); }
        catch (err) { log(`✗ patchHttps failed: ${err}`); }

        try { this.patchHttp(); log('✓ http.request hooked'); }
        catch (err) { log(`✗ patchHttp failed: ${err}`); }

        try { this.patchFetch(); }
        catch (err) { log(`✗ patchFetch failed: ${err}`); }

        log('Started — monitoring AI API calls (https + fetch)');
    }

    /** 停止拦截，恢复原始方法 */
    stop(): void {
        if (!this.active) { return; }
        this.active = false;
        // Use require() to get the actual module object (not the __importStar proxy)
        const realHttps = require('https');
        const realHttp = require('http');
        if (this.originalHttpsRequest) {
            realHttps.request = this.originalHttpsRequest;
            this.originalHttpsRequest = null;
        }
        if (this.originalHttpRequest) {
            realHttp.request = this.originalHttpRequest;
            this.originalHttpRequest = null;
        }
        if (this.originalFetch) {
            globalThis.fetch = this.originalFetch;
            this.originalFetch = null;
        }
        if (this.originalDispatcher) {
            try {
                const undici = require('undici');
                undici.setGlobalDispatcher(this.originalDispatcher);
            } catch { /* ignore */ }
            this.originalDispatcher = null;
        }
        log('Stopped');
    }

    private patchHttps(): void {
        // Use require() to bypass TypeScript's __importStar readonly proxy
        const realHttps = require('https');
        this.originalHttpsRequest = realHttps.request;
        const self = this;
        const origRequest = this.originalHttpsRequest!;

        realHttps.request = function patchedRequest(
            ...args: any[]
        ): http.ClientRequest {
            const req = (origRequest as Function).apply(realHttps, args);
            try {
                self.interceptRequest(req, args, 'https');
            } catch (err) {
                console.error('[NetworkInterceptor] Error intercepting HTTPS request:', err);
            }
            return req;
        };
    }

    private patchHttp(): void {
        const realHttp = require('http');
        this.originalHttpRequest = realHttp.request;
        const self = this;
        const origRequest = this.originalHttpRequest!;

        realHttp.request = function patchedRequest(
            ...args: any[]
        ): http.ClientRequest {
            const req = (origRequest as Function).apply(realHttp, args);
            try {
                self.interceptRequest(req, args, 'http');
            } catch (err) {
                console.error('[NetworkInterceptor] Error intercepting HTTP request:', err);
            }
            return req;
        };
    }

    /**
     * Hook fetch 通过 undici 的 GlobalDispatcher。
     *
     * VSCode Extension Host 的 fetch 调用链：
     *   Copilot → __vscodePatchedFetch（闭包缓存）→ 原始 fetch → undici dispatcher
     *
     * Copilot 在模块加载时就缓存了 fetch 引用，patch globalThis.fetch 无效。
     * 但所有 fetch 调用最终都通过 undici 的 GlobalDispatcher 发出请求。
     * 通过 setGlobalDispatcher 设置自定义 dispatcher，我们可以拦截一切。
     */
    private patchFetch(): void {
        try {
            const undici = require('undici');
            if (!undici.getGlobalDispatcher || !undici.setGlobalDispatcher) {
                console.warn('[NetworkInterceptor] undici dispatcher API not available');
                return;
            }

            const originalDispatcher = undici.getGlobalDispatcher();
            this.originalDispatcher = originalDispatcher;
            const self = this;

            // Create a wrapper dispatcher that intercepts AI API requests
            const handler: ProxyHandler<any> = {
                get(target: any, prop: string, receiver: any) {
                    if (prop === 'dispatch') {
                        return function (opts: any, reqHandler: any) {
                            try {
                                const origin = opts.origin?.toString() || '';
                                const path = opts.path || '/';
                                const method = (opts.method || 'GET').toUpperCase();

                                let hostname = '';
                                try {
                                    hostname = new URL(origin).hostname;
                                } catch { /* skip */ }

                                if (method === 'POST' && hostname && !self.excludeHosts.has(hostname)) {
                                    const endpoint = identifyEndpoint(hostname, path);
                                    if (endpoint) {
                                        log(`dispatch intercepted: ${endpoint.vendor} ${method} ${hostname}${path}`);
                                        // Wrap the handler to capture response body
                                        const wrappedHandler = self.wrapDispatchHandler(reqHandler, endpoint, path);
                                        return target.dispatch(opts, wrappedHandler);
                                    }
                                }
                            } catch (err) {
                                console.error('[NetworkInterceptor] dispatch intercept error:', err);
                            }
                            return target.dispatch(opts, reqHandler);
                        };
                    }
                    return Reflect.get(target, prop, receiver);
                }
            };

            const proxyDispatcher = new Proxy(originalDispatcher, handler);
            undici.setGlobalDispatcher(proxyDispatcher);
            log('undici GlobalDispatcher hooked successfully');
        } catch (err) {
            log(`[WARN] Failed to hook undici dispatcher: ${err}`);
            // Fallback: try patching globalThis.fetch directly
            this.patchFetchFallback();
        }
    }

    /** Wrap undici dispatch handler to capture response body */
    private wrapDispatchHandler(originalHandler: any, endpoint: ApiEndpoint, path: string): any {
        const self = this;
        const responseChunks: Buffer[] = [];
        let headers: string[] = [];

        return {
            onConnect: function (...args: any[]) {
                return originalHandler.onConnect?.(...args);
            },
            onHeaders: function (statusCode: number, rawHeaders: any, resume: any, statusMessage: string) {
                headers = rawHeaders;
                return originalHandler.onHeaders?.(statusCode, rawHeaders, resume, statusMessage);
            },
            onData: function (chunk: Buffer) {
                try {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                } catch { /* ignore */ }
                return originalHandler.onData?.(chunk);
            },
            onComplete: function (trailers: any) {
                try {
                    const body = Buffer.concat(responseChunks).toString('utf8');
                    // Check if streaming from headers
                    const headerStr = headers?.toString() || '';
                    const isStreaming = headerStr.includes('text/event-stream') || headerStr.includes('stream');
                    self.processResponse(endpoint, path, body, isStreaming);
                } catch (err) {
                    console.error('[NetworkInterceptor] Error in onComplete:', err);
                }
                return originalHandler.onComplete?.(trailers);
            },
            onError: function (err: any) {
                return originalHandler.onError?.(err);
            },
            onUpgrade: function (statusCode: number, rawHeaders: any, socket: any) {
                return originalHandler.onUpgrade?.(statusCode, rawHeaders, socket);
            },
        };
    }

    /** Fallback: patch globalThis.fetch for non-VSCode or older environments */
    private patchFetchFallback(): void {
        const g = globalThis as any;
        const target = g.fetch;
        if (typeof target !== 'function') { return; }

        this.originalFetch = target;
        const self = this;
        const origFetch: Function = target;

        g.fetch = async function (input: any, init?: any): Promise<Response> {
            let url: URL | undefined;
            let method = 'GET';
            try {
                if (typeof input === 'string') { url = new URL(input); }
                else if (input instanceof URL) { url = input; }
                else if (input && typeof input === 'object') {
                    try { url = new URL(input.url || input.href || String(input)); } catch { /* skip */ }
                    method = input.method || 'GET';
                }
                if (init?.method) { method = init.method; }
            } catch { /* ignore */ }

            if (!url || method.toUpperCase() !== 'POST') {
                return origFetch(input, init);
            }

            const hostname = url.hostname;
            const path = url.pathname;
            if (self.excludeHosts.has(hostname)) { return origFetch(input, init); }

            const endpoint = identifyEndpoint(hostname, path);
            if (!endpoint) { return origFetch(input, init); }

            const response = await origFetch(input, init);
            try {
                const cloned = response.clone();
                const contentType = cloned.headers.get('content-type') || '';
                const isStreaming = contentType.includes('text/event-stream') || contentType.includes('stream');
                cloned.text().then((body: string) => {
                    try { self.processResponse(endpoint, path, body, isStreaming); }
                    catch { /* ignore */ }
                }).catch(() => { /* ignore */ });
            } catch { /* ignore */ }
            return response;
        };
        log('fetch fallback hook installed');
    }

    private interceptRequest(req: http.ClientRequest, args: any[], protocol: string): void {
        // Extract hostname and path from the request options
        let hostname = '';
        let path = '';
        let method = 'GET';

        const options = args[0];
        if (typeof options === 'string' || options instanceof URL) {
            const url = typeof options === 'string' ? new URL(options) : options;
            hostname = url.hostname;
            path = url.pathname;
        } else if (options && typeof options === 'object') {
            hostname = options.hostname || options.host || '';
            // Strip port from host
            if (hostname.includes(':')) {
                hostname = hostname.split(':')[0];
            }
            path = options.path || '/';
            method = options.method || 'GET';
        }

        if (!hostname) { return; }

        // Skip our own backend requests
        if (this.excludeHosts.has(hostname)) { return; }

        const endpoint = identifyEndpoint(hostname, path);
        if (!endpoint) { return; }

        // Only intercept POST requests (API calls)
        if (method.toUpperCase() !== 'POST') { return; }

        const self = this;

        // Listen for the response (passive — does not consume data from other listeners)
        req.on('response', (res: http.IncomingMessage) => {
            const contentType = res.headers['content-type'] || '';
            const isStreaming = contentType.includes('text/event-stream') || contentType.includes('stream');
            const responseChunks: Buffer[] = [];

            res.on('data', (chunk: Buffer) => {
                try {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                } catch { /* ignore */ }
            });

            res.on('end', () => {
                try {
                    const body = Buffer.concat(responseChunks).toString('utf8');
                    self.processResponse(endpoint, path, body, isStreaming);
                } catch (err) {
                    console.error('[NetworkInterceptor] Error processing response:', err);
                }
            });
        });
    }

    private processResponse(endpoint: ApiEndpoint, path: string, responseBody: string, isStreaming: boolean): void {
        let usage: { promptTokens: number; completionTokens: number; totalTokens: number; model: string } | null = null;

        log(`Processing response: ${endpoint.vendor} ${path} streaming=${isStreaming} bodyLen=${responseBody.length}`);

        if (isStreaming) {
            usage = extractStreamingUsage(responseBody, endpoint.vendor);
        } else {
            try {
                const json = JSON.parse(responseBody);
                usage = extractOpenAIUsage(json);
            } catch {
                // Not JSON, skip
            }
        }

        if (!usage || usage.totalTokens === 0) {
            log(`No usage data found for ${endpoint.vendor} ${path}`);
            return;
        }

        const appName = getNormalizedAppName();

        this.eventBus.emit('token-usage', {
            vendor: endpoint.vendor,
            model: usage.model || 'unknown',
            endpoint: path,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            requestTime: new Date().toISOString(),
            source: `interceptor-${endpoint.vendor}`,
            sourceApp: appName,
        });

        log(`✓ Captured: ${endpoint.vendor}/${usage.model} — ${usage.totalTokens} tokens (prompt=${usage.promptTokens} completion=${usage.completionTokens})`);
    }
}
