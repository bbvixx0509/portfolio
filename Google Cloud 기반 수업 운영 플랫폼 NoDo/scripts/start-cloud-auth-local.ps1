[CmdletBinding()]
param()

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repoRoot 'backend'
$python = Join-Path $backendRoot '.venv\Scripts\python.exe'
$environmentFile = Join-Path $backendRoot '.env.cloud-auth.local'

if (-not (Test-Path -LiteralPath $python)) {
  throw 'NoDo_02 backend .venv Python을 찾지 못했습니다. backend\.venv를 준비한 뒤 다시 실행해 주세요.'
}
if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw 'backend\.env.cloud-auth.local을 찾지 못했습니다. 로컬 cloud-auth 환경을 확인해 주세요.'
}

$occupiedPorts = Get-NetTCPConnection -LocalPort 5175, 8082 -State Listen -ErrorAction SilentlyContinue
if ($occupiedPorts) {
  $ports = ($occupiedPorts | Select-Object -ExpandProperty LocalPort -Unique) -join ', '
  throw "포트 $ports 이(가) 이미 사용 중입니다. 소유가 확인된 NoDo_02 프로세스인지 확인한 뒤 다시 실행해 주세요."
}

Start-Process -FilePath $python -ArgumentList @(
  '-m', 'uvicorn', 'app.main:app', '--env-file', '.env.cloud-auth.local',
  '--host', '127.0.0.1', '--port', '8082'
) -WorkingDirectory $backendRoot -WindowStyle Hidden
Start-Process -FilePath 'npm.cmd' -ArgumentList @(
  '--prefix', (Join-Path $repoRoot 'web'), 'run', 'dev:cloud-auth'
) -WorkingDirectory $repoRoot -WindowStyle Hidden

Write-Output 'NoDo_02 cloud-auth local servers were started for http://localhost:5175 and http://127.0.0.1:8082.'
