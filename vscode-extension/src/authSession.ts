import { MonitorConfig } from './config';

export const AUTH_SESSION_SECRET_KEY = 'authSession';

export interface AuthSession {
    token: string;
    serverUrl: string;
    employeeId: string;
    userName: string;
}

function normalizeServerUrl(serverUrl: string | undefined): string {
    return (serverUrl || '').trim().replace(/\/+$/, '');
}

function normalizeIdentityValue(value: string | undefined): string {
    return (value || '').trim();
}

export function serializeAuthSession(session: AuthSession): string {
    return JSON.stringify({
        token: session.token,
        serverUrl: normalizeServerUrl(session.serverUrl),
        employeeId: normalizeIdentityValue(session.employeeId),
        userName: normalizeIdentityValue(session.userName),
    });
}

export function parseAuthSession(raw: string | undefined): AuthSession | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<AuthSession>;
        if (!parsed.token) {
            return undefined;
        }
        return {
            token: parsed.token,
            serverUrl: normalizeServerUrl(parsed.serverUrl),
            employeeId: normalizeIdentityValue(parsed.employeeId),
            userName: normalizeIdentityValue(parsed.userName),
        };
    } catch {
        return undefined;
    }
}

export function authSessionMatchesConfig(session: AuthSession | undefined, config: Pick<MonitorConfig, 'serverUrl' | 'userId' | 'userName'>): boolean {
    if (!session) {
        return false;
    }
    return session.serverUrl === normalizeServerUrl(config.serverUrl)
        && session.employeeId === normalizeIdentityValue(config.userId)
        && session.userName === normalizeIdentityValue(config.userName);
}