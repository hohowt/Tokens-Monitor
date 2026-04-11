#!/usr/bin/env powershell

param(
    [ValidateSet('all','win','mac','mac-arm','linux')]
    [string]$Platform = 'all'
)

$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$DIST = Join-Path $ROOT 'dist'

# ── Resolve version ──
$VERSION_FILE = Join-Path $ROOT 'VERSION'
if (Test-Path -LiteralPath $VERSION_FILE) {
    $VERSION = (Get-Content $VERSION_FILE -Raw).Trim()
} else {
    try {
        $VERSION = (git -C $ROOT describe --tags --always 2>$null)
        if (-not $VERSION) { $VERSION = 'dev' }
    } catch {
        $VERSION = 'dev'
    }
}
$LDFLAGS = "-s -w -X main.Version=$VERSION"
Write-Host "  Version: $VERSION" -ForegroundColor Magenta

$targets = [ordered]@{
    'win' = @{
        Goos = 'windows'
        Goarch = 'amd64'
        Output = 'ai-monitor.exe'
        Mirror = (Join-Path $ROOT 'ai-monitor.exe')
    }
    'mac' = @{
        Goos = 'darwin'
        Goarch = 'amd64'
        Output = 'ai-monitor-darwin-x64'
    }
    'mac-arm' = @{
        Goos = 'darwin'
        Goarch = 'arm64'
        Output = 'ai-monitor-darwin-arm64'
    }
    'linux' = @{
        Goos = 'linux'
        Goarch = 'amd64'
        Output = 'ai-monitor-linux-x64'
    }
}

function Build-Target($name) {
    $spec = $targets[$name]
    $outputPath = Join-Path $DIST $spec.Output
    $oldGoos = $env:GOOS
    $oldGoarch = $env:GOARCH
    $oldCgo = $env:CGO_ENABLED
    $pushedLocation = $false

    Write-Host "  Building client for $($spec.Goos)/$($spec.Goarch)..." -ForegroundColor Cyan

    try {
        $env:GOOS = $spec.Goos
        $env:GOARCH = $spec.Goarch
        $env:CGO_ENABLED = '0'

        Push-Location $ROOT
        $pushedLocation = $true
        go build -ldflags="$LDFLAGS" -o $outputPath .
        if ($LASTEXITCODE -ne 0) {
            throw "go build failed for $($spec.Goos)/$($spec.Goarch)"
        }

        if ($spec.ContainsKey('Mirror')) {
            Copy-Item -LiteralPath $outputPath -Destination $spec.Mirror -Force
        }

        Write-Host "    ✓ $outputPath" -ForegroundColor Green
    } finally {
        if ($pushedLocation) {
            Pop-Location
        }
        if ($null -ne $oldGoos) { $env:GOOS = $oldGoos } else { Remove-Item Env:GOOS -ErrorAction SilentlyContinue }
        if ($null -ne $oldGoarch) { $env:GOARCH = $oldGoarch } else { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue }
        if ($null -ne $oldCgo) { $env:CGO_ENABLED = $oldCgo } else { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue }
    }
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go toolchain not found. Install Go first, then rerun build.ps1.'
}

New-Item -ItemType Directory -Path $DIST -Force | Out-Null
$buildList = if ($Platform -eq 'all') { @($targets.Keys) } else { @($Platform) }

Write-Host "`n  AI Token Monitor Client - Cross Build`n" -ForegroundColor Yellow
foreach ($name in $buildList) {
    Build-Target $name
}

Write-Host "`n  ✅ Done! Client binaries:" -ForegroundColor Yellow
foreach ($name in $buildList) {
    $file = Get-Item -LiteralPath (Join-Path $DIST $targets[$name].Output)
    $sizeMB = [math]::Round($file.Length / 1MB, 1)
    Write-Host "    📦 $($file.Name) ($sizeMB MB)" -ForegroundColor Green
}
Write-Host ""