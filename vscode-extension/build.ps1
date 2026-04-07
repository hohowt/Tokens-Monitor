#!/usr/bin/env pwsh
# Build script: validate target-specific proxy binary, compile TypeScript, and package VS Code extension
# Usage: .\build.ps1 [-Platform all|win|mac|mac-arm|linux]
# Note: non-Windows packages require matching client binaries to exist before packaging.

param(
    [ValidateSet('all','win','mac','mac-arm','linux')]
    [string]$Platform = 'all'
)

$ErrorActionPreference = 'Stop'
$EXT = $PSScriptRoot
$REPO = Split-Path $EXT -Parent
$DIST = Join-Path $EXT 'dist'
$BIN = Join-Path $EXT 'bin'
$CLIENT = Join-Path $REPO 'client'
$CLIENT_BUILD = Join-Path $CLIENT 'build.ps1'

$targetSpecs = [ordered]@{
    'win' = @{
        VsceTarget = 'win32-x64'
        PackagedBinary = 'ai-monitor.exe'
        SourceCandidates = @(
            (Join-Path $REPO 'client\ai-monitor.exe'),
            (Join-Path $REPO 'client\dist\ai-monitor.exe')
        )
    }
    'mac' = @{
        VsceTarget = 'darwin-x64'
        PackagedBinary = 'ai-monitor'
        SourceCandidates = @(
            (Join-Path $REPO 'client\ai-monitor-darwin-x64'),
            (Join-Path $REPO 'client\dist\ai-monitor-darwin-x64')
        )
    }
    'mac-arm' = @{
        VsceTarget = 'darwin-arm64'
        PackagedBinary = 'ai-monitor'
        SourceCandidates = @(
            (Join-Path $REPO 'client\ai-monitor-darwin-arm64'),
            (Join-Path $REPO 'client\dist\ai-monitor-darwin-arm64')
        )
    }
    'linux' = @{
        VsceTarget = 'linux-x64'
        PackagedBinary = 'ai-monitor'
        SourceCandidates = @(
            (Join-Path $REPO 'client\ai-monitor-linux-x64'),
            (Join-Path $REPO 'client\dist\ai-monitor-linux-x64')
        )
    }
}

function Resolve-ClientBinary($name) {
    $spec = $targetSpecs[$name]
    foreach ($candidate in $spec.SourceCandidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    if (-not (Test-Path -LiteralPath $CLIENT_BUILD)) {
        throw "Client build script not found: $CLIENT_BUILD"
    }

    Write-Host "  Client binary for '$name' not found. Building it now..." -ForegroundColor Cyan
    & $CLIENT_BUILD -Platform $name
    if ($LASTEXITCODE -ne 0) {
        throw "Client build failed for target '$name'"
    }

    foreach ($candidate in $spec.SourceCandidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $expected = ($spec.SourceCandidates | ForEach-Object { "  - $_" }) -join "`n"
    throw "Missing client binary for target '$name'. Expected one of:`n$expected`nBuild the client for that platform first, otherwise the packaged extension cannot start its bundled proxy."
}

function Clear-StagedBinaries() {
    foreach ($binaryName in @('ai-monitor', 'ai-monitor.exe')) {
        $candidate = Join-Path $BIN $binaryName
        if (Test-Path -LiteralPath $candidate) {
            Remove-Item -LiteralPath $candidate -Force
        }
    }
}

function Build-Extension($name) {
    $spec = $targetSpecs[$name]
    $vsceTarget = $spec.VsceTarget
    $sourceBinary = Resolve-ClientBinary $name
    $outputPath = Join-Path $DIST "ai-token-monitor-$vsceTarget.vsix"
    $oldSource = $env:AI_MONITOR_SOURCE_PATH
    $oldBinaryName = $env:AI_MONITOR_BINARY_NAME
    $pushedLocation = $false

    Write-Host "  Packaging VSIX for $vsceTarget..." -ForegroundColor Cyan
    Write-Host "    using client binary: $sourceBinary" -ForegroundColor DarkGray

    try {
        New-Item -ItemType Directory -Path $BIN -Force | Out-Null
        Clear-StagedBinaries
        $env:AI_MONITOR_SOURCE_PATH = $sourceBinary
        $env:AI_MONITOR_BINARY_NAME = $spec.PackagedBinary

        Push-Location $EXT
        $pushedLocation = $true
        npx vsce package --target $vsceTarget --out $outputPath | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed for $vsceTarget" }
        Write-Host "    ✓ $outputPath" -ForegroundColor Green
        return $outputPath
    } finally {
        if ($pushedLocation) {
            Pop-Location
        }
        Clear-StagedBinaries
        if ($null -ne $oldSource) {
            $env:AI_MONITOR_SOURCE_PATH = $oldSource
        } else {
            Remove-Item Env:AI_MONITOR_SOURCE_PATH -ErrorAction SilentlyContinue
        }
        if ($null -ne $oldBinaryName) {
            $env:AI_MONITOR_BINARY_NAME = $oldBinaryName
        } else {
            Remove-Item Env:AI_MONITOR_BINARY_NAME -ErrorAction SilentlyContinue
        }
    }
}

# ── Main ──
Write-Host "`n  AI Token Monitor - Build Script`n" -ForegroundColor Yellow

# Ensure output dirs
New-Item -ItemType Directory -Path $DIST -Force | Out-Null

# Compile TypeScript
Write-Host "  Compiling TypeScript..." -ForegroundColor Cyan
Push-Location $EXT
try {
    npm run compile
    if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed" }
} finally {
    Pop-Location
}
Write-Host "    ✓ out/" -ForegroundColor Green

# Run tests
Write-Host "  Running tests..." -ForegroundColor Cyan
Push-Location $EXT
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Tests failed" }
} finally {
    Pop-Location
}
Write-Host "    ✓ All tests passed" -ForegroundColor Green

# Package VSIX
$buildList = if ($Platform -eq 'all') { @($targetSpecs.Keys) } else { @($Platform) }
$builtPackages = @()

foreach ($name in $buildList) {
    $builtPackages += Build-Extension $name
}

Write-Host "`n  ✅ Done! VSIX packages:" -ForegroundColor Yellow
foreach ($pkg in $builtPackages) {
    $file = Get-Item -LiteralPath $pkg
    $sizeMB = [math]::Round($file.Length / 1MB, 1)
    Write-Host "    📦 $($file.Name) ($sizeMB MB)" -ForegroundColor Green
}
Write-Host ""

