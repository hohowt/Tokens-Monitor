@echo off
echo.
echo  Building AI Token Monitor Client...
echo.

:: Build for Windows amd64
set GOOS=windows
set GOARCH=amd64
go build -ldflags="-s -w" -o ai-monitor.exe .

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
