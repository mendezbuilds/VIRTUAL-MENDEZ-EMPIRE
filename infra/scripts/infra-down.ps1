# VIRTUAL MENDEZ EMPIRE — Stop Core Infrastructure Stack
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dockerComposeFile = Join-Path $scriptDir "..\docker\docker-compose.yml"

Write-Host ">>> Stopping Virtual Mendez Empire infrastructure..." -ForegroundColor Yellow
docker compose -f $dockerComposeFile down
Write-Host ">>> Infrastructure stopped." -ForegroundColor Green

