@echo off
echo.
echo  Building AI Token Monitor Client...
echo.

:: ── Resolve version ──
if exist "%~dp0VERSION" (
    set /p VERSION=<"%~dp0VERSION"
) else (
    set VERSION=dev
)
echo  Version: %VERSION%
set LDFLAGS=-s -w -X main.Version=%VERSION%

:: Build for Windows amd64
set GOOS=windows
set GOARCH=amd64
go build -ldflags="%LDFLAGS%" -o ai-monitor.exe .

if %ERRORLEVEL% NEQ 0 (
    echo  Build FAILED!
    pause
    exit /b 1
)

echo  Build SUCCESS: ai-monitor.exe
echo.

:: Show file size
for %%A in (ai-monitor.exe) do echo  Size: %%~zA bytes
echo.
pause
