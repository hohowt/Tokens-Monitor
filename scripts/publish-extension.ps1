#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Publish VSIX to the extension distribution server.

.DESCRIPTION
    Uploads VSIX files to the server's extension directory.
    After upload, employees' extensions will auto-detect the new version on next launch.

.EXAMPLE
    # Publish latest build (auto-detects dist/ files)
    .\publish-extension.ps1

    # Publish a specific file
    .\publish-extension.ps1 -VsixPath .\ai-token-monitor-win32-x64.vsix
#>

param(
    [string]$VsixPath,
    [string]$RemoteHost = $env:SSH_HOST,
    [string]$User = $env:SSH_USER,
    [string]$RemoteDir = '/opt/token-monitor/extensions'
)

$ErrorActionPreference = 'Stop'

if (-not $RemoteHost) { $RemoteHost = '192.168.0.135' }
if (-not $User) { $User = 'root' }

$REPO = Split-Path $PSScriptRoot -Parent
$DIST = Join-Path $REPO 'vscode-extension\dist'
$PKG  = Join-Path $REPO 'vscode-extension\package.json'

# Read version from package.json
$version = (Get-Content $PKG -Raw | ConvertFrom-Json).version
if (-not $version) { throw "Cannot read version from $PKG" }

# Resolve VSIX file(s)
if ($VsixPath) {
    $files = @(Get-Item -LiteralPath $VsixPath)
} else {
    if (-not (Test-Path $DIST)) {
        throw "No dist directory found. Run vscode-extension\build.ps1 first."
    }
    $files = @(Get-ChildItem -Path $DIST -Filter 'ai-token-monitor-*.vsix' | Sort-Object LastWriteTime -Descending)
    if ($files.Count -eq 0) {
        throw "No VSIX files found in $DIST. Run vscode-extension\build.ps1 first."
    }
}

Write-Host "`n  Publishing v$version to ${User}@${RemoteHost}:${RemoteDir}`n" -ForegroundColor Yellow

# Ensure remote dir exists
ssh "${User}@${RemoteHost}" "mkdir -p '$RemoteDir'" 2>&1 | Out-Null

foreach ($f in $files) {
    # Ensure filename contains version: ai-token-monitor-<target>-<version>.vsix
    $remoteName = $f.Name
    if ($remoteName -notmatch '\d+\.\d+\.\d+\.vsix$') {
        # e.g. ai-token-monitor-win32-x64.vsix → ai-token-monitor-win32-x64-0.1.23.vsix
        $remoteName = $remoteName -replace '\.vsix$', "-$version.vsix"
    }

    $sizeMB = [math]::Round($f.Length / 1MB, 1)
    Write-Host "  Uploading $remoteName ($sizeMB MB)..." -ForegroundColor Cyan
    scp $f.FullName "${User}@${RemoteHost}:${RemoteDir}/$remoteName"
    if ($LASTEXITCODE -ne 0) {
        throw "scp failed for $remoteName"
    }
    Write-Host "    uploaded" -ForegroundColor Green
}

Write-Host "`n  Done! v$version published." -ForegroundColor Yellow
Write-Host "  Employees will see the update on next VS Code launch.`n" -ForegroundColor DarkGray
