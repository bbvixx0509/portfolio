$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$pythonCommand = Join-Path $projectRoot "backend\.venv\Scripts\python.exe"
$testMode = $env:NODO_EMULATOR_TEST_MODE

if ([string]::IsNullOrWhiteSpace($testMode)) {
  $testMode = "all"
}

if ($testMode -notin @("all", "concurrency")) {
  throw "Unsupported NoDo Emulator test mode: $testMode"
}

if (-not (Test-Path -LiteralPath $pythonCommand)) {
  throw "NoDo_02 backend virtual environment was not found: $pythonCommand"
}

Push-Location $projectRoot
try {
  & npm --prefix web run test:emulator
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  Push-Location (Join-Path $projectRoot "backend")
  try {
    & $pythonCommand -m app.scripts.seed_emulator
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }

    & $pythonCommand -m app.scripts.seed_emulator
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }

    $env:NODO_RUN_EMULATOR_TESTS = "1"
    $pytestArguments = @("-m", "pytest", "tests/emulator", "-q")
    if ($testMode -eq "concurrency") {
      $pytestArguments += @("-m", "emulator_concurrency")
    }

    & $pythonCommand @pytestArguments
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  Pop-Location
}

Write-Host "NoDo_02 Rules, idempotent seed, and FastAPI Emulator tests passed ($testMode mode)."
