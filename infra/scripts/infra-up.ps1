# VIRTUAL MENDEZ EMPIRE — Start Core Infrastructure Stack
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dockerComposeFile = Join-Path $scriptDir "..\docker\docker-compose.yml"

Write-Host ">>> Starting Virtual Mendez Empire core infrastructure..." -ForegroundColor Cyan
docker compose -f $dockerComposeFile up -d

Write-Host ">>> Waiting for PostgreSQL 16 + pgvector health check..." -ForegroundColor Yellow
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    $status = docker inspect --format='{{json .State.Health.Status}}' vme_postgres 2>$null
    if ($status -eq '"healthy"') {
        $healthy = $true
        Write-Host ">>> PostgreSQL 16 + pgvector is healthy!" -ForegroundColor Green
        break
    }
    Start-Sleep -Seconds 1
}

if (-not $healthy) {
    Write-Warning "PostgreSQL did not report healthy within 30 seconds."
}

docker compose -f $dockerComposeFile ps

