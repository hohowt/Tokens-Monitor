/**
 * Tests for src/config.ts
 *
 * The 'vscode' module is resolved by the manual mock at <rootDir>/__mocks__/vscode.js
 */

import * as vscode from 'vscode';
import { getConfig, getAppName, getNormalizedAppName } from '../config';

// Helper: cast the mocked workspace.getConfiguration to a jest.Mock
const mockGetConfiguration = vscode.workspace.getConfiguration as jest.Mock;

describe('config', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // -------------------------------------------------------------------
    // getConfig()
    // -------------------------------------------------------------------
    describe('getConfig()', () => {
        test('returns defaults when no settings are configured', () => {
            // The default mock returns `defaultVal` for every get() call
            mockGetConfiguration.mockReturnValue({
                get: jest.fn((_key: string, defaultVal: any) => defaultVal),
            });

            const cfg = getConfig();

            expect(cfg.serverUrl).toBe('https://otw.tech:59889');
            expect(cfg.userId).toBe('');
            expect(cfg.userName).toBe('');
            expect(cfg.department).toBe('');
            expect(cfg.copilotOrg).toBe('');
            expect(cfg.transparentMode).toBe(false);
            expect(cfg.proxyPort).toBe(18090);
            expect(cfg.gatewayPort).toBe(18091);
            expect(cfg.upstreamProxy).toBe('');
        });

        test('strips trailing slashes from serverUrl', () => {
            mockGetConfiguration.mockReturnValue({
                get: jest.fn((key: string, defaultVal: any) => {
                    if (key === 'serverUrl') return 'http://example.com///';
                    return defaultVal;
                }),
            });

            const cfg = getConfig();
            expect(cfg.serverUrl).toBe('http://example.com');
        });

        test('returns user-specified values', () => {
            const values: Record<string, string> = {
                serverUrl: 'https://myserver.com',
                userId: 'u42',
                userName: 'Alice',
                department: 'Dev',
                copilotOrg: 'my-org',
                upstreamProxy: 'http://127.0.0.1:8089',
            };

            mockGetConfiguration.mockReturnValue({
                get: jest.fn((key: string, defaultVal: any) => {
                    if (key === 'transparentMode') return false;
                    if (key === 'proxyPort') return 28090;
                    if (key === 'gatewayPort') return 28091;
                    return key in values ? values[key] : defaultVal;
                }),
            });

            const cfg = getConfig();
            expect(cfg.serverUrl).toBe('https://myserver.com');
            expect(cfg.userId).toBe('u42');
            expect(cfg.userName).toBe('Alice');
            expect(cfg.department).toBe('Dev');
            expect(cfg.copilotOrg).toBe('my-org');
            expect(cfg.transparentMode).toBe(false);
            expect(cfg.proxyPort).toBe(28090);
            expect(cfg.gatewayPort).toBe(28091);
            expect(cfg.upstreamProxy).toBe('http://127.0.0.1:8089');
        });

        test('falls back to default ports when configured values are invalid', () => {
            mockGetConfiguration.mockReturnValue({
                get: jest.fn((key: string, defaultVal: any) => {
                    if (key === 'proxyPort') return -1;
                    if (key === 'gatewayPort') return 70000;
                    return defaultVal;
                }),
            });

            const cfg = getConfig();
            expect(cfg.proxyPort).toBe(18090);
            expect(cfg.gatewayPort).toBe(18091);
        });
    });

    // -------------------------------------------------------------------
    // getAppName()
    // -------------------------------------------------------------------
    describe('getAppName()', () => {
        test('returns vscode.env.appName', () => {
            // The mock sets env.appName to 'Visual Studio Code'
            expect(getAppName()).toBe('Visual Studio Code');
        });

        test('reflects changed appName', () => {
            const original = vscode.env.appName;
            (vscode.env as any).appName = 'Cursor';
            expect(getAppName()).toBe('Cursor');
            (vscode.env as any).appName = original;
        });
    });

    // -------------------------------------------------------------------
    // getNormalizedAppName()
    // -------------------------------------------------------------------
    describe('getNormalizedAppName()', () => {
        afterEach(() => {
            // Restore default
            (vscode.env as any).appName = 'Visual Studio Code';
        });

        test('maps "Visual Studio Code" to "vscode"', () => {
            (vscode.env as any).appName = 'Visual Studio Code';
            expect(getNormalizedAppName()).toBe('vscode');
        });

        test('maps "Visual Studio Code - Insiders" correctly', () => {
            (vscode.env as any).appName = 'Visual Studio Code - Insiders';
            expect(getNormalizedAppName()).toBe('vscode-insiders');
        });

        test('maps "Cursor" to "cursor"', () => {
            (vscode.env as any).appName = 'Cursor';
            expect(getNormalizedAppName()).toBe('cursor');
        });

        test('maps "Kiro" to "kiro"', () => {
            (vscode.env as any).appName = 'Kiro';
            expect(getNormalizedAppName()).toBe('kiro');
        });

        test('lowercases and replaces spaces for unknown app names', () => {
            (vscode.env as any).appName = 'My Custom Editor';
            expect(getNormalizedAppName()).toBe('my-custom-editor');
        });

        test('handles whitespace in fallback path', () => {
            (vscode.env as any).appName = '  Spaced Name  ';
            // The map won't match, so it falls through to toLowerCase().replace(/\s+/g, '-')
            // Leading/trailing whitespace groups are each replaced by a single '-'
            expect(getNormalizedAppName()).toBe('-spaced-name-');
        });
    });
});
