#!/usr/bin/env pwsh
<#
.SYNOPSIS
    为员工部署 AI Token Monitor 扩展并预配置身份信息。

.DESCRIPTION
    1. 写入 %APPDATA%/ai-monitor/identity.json（身份信息）
    2. 可选安装 VSIX 扩展到 VS Code / Cursor

.EXAMPLE
    # 仅配置身份（员工已自行安装扩展）
    .\deploy.ps1 -UserId "zhangsan" -UserName "张三" -Department "研发部"

    # 配置身份 + 安装扩展
    .\deploy.ps1 -UserId "zhangsan" -UserName "张三" -Department "研发部" -VsixPath .\ai-token-monitor-win32-x64.vsix

    # 安装到 Cursor
    .\deploy.ps1 -UserId "zhangsan" -UserName "张三" -IDE cursor -VsixPath .\ai-token-monitor-win32-x64.vsix
#>

param(
    [Parameter(Mandatory)]
    [string]$UserId,

    [Parameter(Mandatory)]
    [string]$UserName,

    [string]$Department = '',

    [string]$VsixPath,

    [ValidateSet('code', 'cursor')]
    [string]$IDE = 'code'
)

$ErrorActionPreference = 'Stop'

# ── 1. Write identity.json ──
$aiMonitorDir = Join-Path $env:APPDATA 'ai-monitor'
$identityPath = Join-Path $aiMonitorDir 'identity.json'

New-Item -ItemType Directory -Path $aiMonitorDir -Force | Out-Null

$identity = @{
    user_id    = $UserId
    user_name  = $UserName
    department = $Department
}

$identity | ConvertTo-Json -Depth 2 | Set-Content -Path $identityPath -Encoding utf8
Write-Host "  identity.json -> $identityPath" -ForegroundColor Green
Write-Host "    user_id:    $UserId"
Write-Host "    user_name:  $UserName"
Write-Host "    department: $Department"

# ── 2. Install VSIX (optional) ──
if ($VsixPath) {
    if (-not (Test-Path -LiteralPath $VsixPath)) {
        throw "VSIX not found: $VsixPath"
    }

    $cli = $IDE
    if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) {
        Write-Host "  [SKIP] '$cli' not found in PATH, skipping extension install." -ForegroundColor Yellow
    } else {
        Write-Host "  Installing extension via '$cli'..." -ForegroundColor Cyan
        & $cli --install-extension $VsixPath --force 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Extension install failed (exit code $LASTEXITCODE)"
        }
        Write-Host "  Extension installed." -ForegroundColor Green
    }
}

Write-Host "`n  Done! Restart $IDE to apply." -ForegroundColor Yellow
