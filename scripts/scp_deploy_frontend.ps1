param(
    [string]$HostIP = "192.168.0.135",
    [string]$User = "root",
    [string]$RemoteDir = "/opt/token-monitor/frontend/dist"
)
Write-Host "Building frontend..." -ForegroundColor Cyan
Set-Location "D:\Repos\token-监控\frontend"
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "`nDeploying to $HostIP via SCP..." -ForegroundColor Cyan
# Clear old files and copy new build (assumes SSH keys are set up, otherwise prompts for password)
scp -r "dist\*" "${User}@${HostIP}:${RemoteDir}"

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDeployment successful!" -ForegroundColor Green
} else {
    Write-Host "`nDeployment failed during SCP." -ForegroundColor Red
}
