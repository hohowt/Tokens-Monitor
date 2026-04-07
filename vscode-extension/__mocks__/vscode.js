// Manual mock for the vscode module used by Jest
const workspace = {
    getConfiguration: jest.fn(() => ({
        get: jest.fn((key, defaultVal) => defaultVal),
    })),
    onDidChangeConfiguration: jest.fn(),
};

const env = {
    appName: 'Visual Studio Code',
    machineId: 'test-machine-id',
};

const window = {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn(),
    })),
};

const Uri = {
    parse: jest.fn((str) => ({ toString: () => str })),
    file: jest.fn((path) => ({ toString: () => path, fsPath: path })),
};

module.exports = {
    workspace,
    env,
    window,
    Uri,
};
