const fs = require('fs');
const path = 'D:/Repos/token-监控/vscode-extension/src/dashboard.ts';
let code = fs.readFileSync(path, 'utf8');
const splitPoint = 'private getHtml(): string {';
const prefix = code.substring(0, code.indexOf(splitPoint) + splitPoint.length);
fs.writeFileSync('D:/Repos/token-监控/vscode-extension/src/dashboard_prefix.js', prefix);
