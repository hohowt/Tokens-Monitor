#!/usr/bin/env pwsh
<#
.SYNOPSIS
    一键：本地编译 client + vscode-extension，再远程部署 backend/frontend（Docker）并上传 VSIX 与 ai-monitor.exe。

.DESCRIPTION
    1. client\build.ps1 -Platform win  → client\dist\ai-monitor.exe
    2. vscode-extension\build.ps1 -Platform win  → dist\*.vsix
    3. python scripts\deploy.py all  → 上传 backend/frontend、构建容器、迁移库、上传分发物

    需要环境变量 SSH_PASS（或执行前由本脚本提示输入）。

.PARAMETER SkipBuild
    跳过本地编译，直接使用已有 dist（仅当已手动构建过时使用）。

.PARAMETER NoArtifacts
    传给 deploy.py --no-artifacts，仅更新 Docker 服务，不上传 VSIX/EXE。

.EXAMPLE
    $env:SSH_PASS = "your-password"
    .\scripts\deploy-all.ps1

.EXAMPLE
    .\scripts\deploy-all.ps1 -SkipBuild
#>

param(
    [switch]$SkipBuild,
    [switch]$NoArtifacts
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command python -ErrorAction SilentlyContinue) -and -not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "未找到 python / py，请先安装 Python 并加入 PATH。"
}


if (-not $env:SSH_PASS -or $env:SSH_PASS.Trim() -eq '') {
    $secure = Read-Host "请输入 SSH 密码 (SSH_PASS，用于 192.168.0.135)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:SSH_PASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
    }
}

Write-Host "`n=== [1/3] 编译 Windows 客户端 ai-monitor.exe ===" -ForegroundColor Yellow
if (-not $SkipBuild) {
    & (Join-Path $RepoRoot 'client\build.ps1') -Platform win
} else {
    Write-Host "  (已跳过 SkipBuild)" -ForegroundColor DarkGray
}
$exeWin = Join-Path $RepoRoot 'client\dist\ai-monitor.exe'
if (-not (Test-Path -LiteralPath $exeWin)) {
    $exeWin = Join-Path $RepoRoot 'client\ai-monitor.exe'
}
if (-not (Test-Path -LiteralPath $exeWin)) {
    throw "未找到 ai-monitor.exe，请先成功执行 client\build.ps1 -Platform win"
}

Write-Host "`n=== [2/3] 打包 VS Code 扩展 VSIX ===" -ForegroundColor Yellow
if (-not $SkipBuild) {
    & (Join-Path $RepoRoot 'vscode-extension\build.ps1') -Platform win
} else {
    Write-Host "  (已跳过 SkipBuild)" -ForegroundColor DarkGray
}
$vsixDir = Join-Path $RepoRoot 'vscode-extension\dist'
$vsix = Get-ChildItem -Path $vsixDir -Filter 'ai-token-monitor-*.vsix' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    throw "未找到 vscode-extension\dist\ai-token-monitor-*.vsix，请先成功执行 vscode-extension\build.ps1 -Platform win"
}

Write-Host "`n=== [3/3] 远程部署 backend + frontend + 分发物 ===" -ForegroundColor Yellow
$deployPy = Join-Path $RepoRoot 'scripts\deploy.py'
Push-Location $RepoRoot
try {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        if ($NoArtifacts) {
            & python $deployPy 'all' '--no-artifacts'
        } else {
            & python $deployPy 'all'
        }
    } else {
        if ($NoArtifacts) {
            & py -3 $deployPy 'all' '--no-artifacts'
        } else {
            & py -3 $deployPy 'all'
        }
    }
    $exit = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($exit -ne 0) {
    exit $exit
}
Write-Host "`n  全部完成。" -ForegroundColor Green
exit 0
