const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const binDir = path.join(extensionRoot, 'bin');
const binaryName = process.env.AI_MONITOR_BINARY_NAME || (process.platform === 'win32' ? 'ai-monitor.exe' : 'ai-monitor');
const sourcePath = process.env.AI_MONITOR_SOURCE_PATH || path.resolve(extensionRoot, '..', 'client', binaryName);
const targetPath = path.join(binDir, binaryName);

if (!fs.existsSync(sourcePath)) {
    console.error(`[prepare-bin] source binary not found at ${sourcePath}`);
    process.exit(1);
}

fs.mkdirSync(binDir, { recursive: true });

for (const staleName of ['ai-monitor', 'ai-monitor.exe']) {
    const stalePath = path.join(binDir, staleName);
    if (stalePath !== targetPath && fs.existsSync(stalePath)) {
        fs.rmSync(stalePath, { force: true });
    }
}

function copyWithRetry(src, dest, attempts = 8, delayMs = 250) {
    const srcStat = fs.statSync(src);
    try {
        if (fs.existsSync(dest)) {
            const dstStat = fs.statSync(dest);
            if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs - 2000) {
                console.log(`[prepare-bin] skip copy (already up to date): ${dest}`);
                return;
            }
        }
    } catch {
        // ignore stat issues and attempt copy
    }

    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            fs.copyFileSync(src, dest);
            console.log(`[prepare-bin] copied ${src} -> ${dest}`);
            return;
        } catch (err) {
            lastErr = err;
            const retryable = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
            if (!retryable || i === attempts - 1) {
                throw err;
            }
            const wait = delayMs * (i + 1);
            console.warn(`[prepare-bin] copy busy (${err.code}), retry in ${wait}ms (${i + 1}/${attempts})`);
            const until = Date.now() + wait;
            while (Date.now() < until) {
                /* sync wait for AV / file lock */
            }
        }
    }
    throw lastErr;
}

copyWithRetry(sourcePath, targetPath);
