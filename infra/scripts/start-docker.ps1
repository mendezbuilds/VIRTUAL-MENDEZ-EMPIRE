# VIRTUAL MENDEZ EMPIRE — Docker Desktop Launcher & Daemon Verifier
Write-Host ">>> Initializing Docker Desktop for Virtual Mendez Empire..." -ForegroundColor Cyan

$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"

if (-not (Test-Path $dockerDesktopPath)) {
    Write-Error "Docker Desktop executable not found at $dockerDesktopPath"
    exit 1
}

# Start Docker Desktop if not already running
$dockerProcess = Get-Process -Name "*docker*" -ErrorAction SilentlyContinue
if (-not $dockerProcess) {
    Write-Host ">>> Launching Docker Desktop application..." -ForegroundColor Yellow
    Start-Process $dockerDesktopPath
}

Write-Host ">>> Awaiting Docker daemon named pipe readiness..." -ForegroundColor Yellow
$maxAttempts = 30
$attempt = 0
$ready = $false

while ($attempt -lt $maxAttempts -and -not $ready) {
    $attempt++
    Start-Sleep -Seconds 2
    try {
        $null = docker ps 2>&1
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            Write-Host ">>> Docker daemon is active and responsive! (Attempt $attempt)" -ForegroundColor Green
            break
        }
    } catch {
        # continue polling
    }
    Write-Host ">>> Waiting for daemon... ($attempt/$maxAttempts)" -ForegroundColor DarkGray
}

if (-not $ready) {
    Write-Warning "Docker daemon took longer than expected to initialize. Please check Docker Desktop GUI."
    exit 1
}
