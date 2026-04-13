import { authSessionMatchesConfig, parseAuthSession, serializeAuthSession } from '../authSession';

describe('authSession', () => {
    test('matches only when server and identity are unchanged', () => {
        const raw = serializeAuthSession({
            token: 'secret-token',
            serverUrl: 'http://localhost:8000/',
            employeeId: '10001',
            userName: '张三',
        });

        const session = parseAuthSession(raw);
        expect(authSessionMatchesConfig(session, {
            serverUrl: 'http://localhost:8000',
            userId: '10001',
            userName: '张三',
        } as any)).toBe(true);
        expect(authSessionMatchesConfig(session, {
            serverUrl: 'http://localhost:9000',
            userId: '10001',
            userName: '张三',
        } as any)).toBe(false);
        expect(authSessionMatchesConfig(session, {
            serverUrl: 'http://localhost:8000',
            userId: '10002',
            userName: '张三',
        } as any)).toBe(false);
    });

    test('returns undefined for malformed session payload', () => {
        expect(parseAuthSession('not-json')).toBeUndefined();
        expect(parseAuthSession(JSON.stringify({ token: '' }))).toBeUndefined();
    });
});