param(
  [ValidateSet("All", "Concurrency")]
  [string]$Mode = "All",

  [ValidateRange(1, 20)]
  [int]$Repeat = 1
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$firebaseCommand = Join-Path $projectRoot "node_modules\.bin\firebase.cmd"
$initialJavaIds = @(
  Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
    Select-Object -ExpandProperty ProcessId
)
$initialNodeIds = @(
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object -ExpandProperty ProcessId
)
$previousMode = $env:NODO_EMULATOR_TEST_MODE
$testExitCode = 1

function Stop-NoDoEmulatorTestProcesses {
  Start-Sleep -Milliseconds 750

  $ownedJavaProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
      Where-Object {
        $_.ProcessId -notin $initialJavaIds -and
        $_.CommandLine -like "*$projectRoot*" -and
        $_.CommandLine -like "*cloud-firestore-emulator*" -and
        $_.CommandLine -like "*--project_id demo-nodo*"
      }
  )

  foreach ($process in $ownedJavaProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped NoDo_02 Firestore Emulator process $($process.ProcessId)."
  }

  $ownedNodeProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object {
        $_.ProcessId -notin $initialNodeIds -and
        $_.CommandLine -like "*$projectRoot*" -and
        ($_.CommandLine -like "*firebase*" -or $_.CommandLine -like "*vitest*")
      }
  )

  foreach ($process in $ownedNodeProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped NoDo_02 test process $($process.ProcessId)."
  }

  Start-Sleep -Milliseconds 250

  $remainingOwnedJava = @(
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
      Where-Object {
        $_.ProcessId -notin $initialJavaIds -and
        $_.CommandLine -like "*$projectRoot*"
      }
  )

  if ($remainingOwnedJava.Count -gt 0) {
    throw "NoDo_02에서 시작한 Java 프로세스가 종료되지 않았습니다."
  }
}

try {
  $env:NODO_EMULATOR_TEST_MODE = $Mode.ToLowerInvariant()

  for ($iteration = 1; $iteration -le $Repeat; $iteration += 1) {
    Write-Host "NoDo_02 Emulator test run $iteration/$Repeat ($Mode mode)."

    Push-Location $projectRoot
    try {
      & $firebaseCommand emulators:exec `
        --project demo-nodo `
        --only auth,firestore,storage `
        "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-emulator-suite.ps1"
      $testExitCode = $LASTEXITCODE
    }
    finally {
      Pop-Location
    }

    Stop-NoDoEmulatorTestProcesses
    if ($testExitCode -ne 0) {
      break
    }
  }
}
finally {
  Stop-NoDoEmulatorTestProcesses
  if ($null -eq $previousMode) {
    Remove-Item Env:NODO_EMULATOR_TEST_MODE -ErrorAction SilentlyContinue
  }
  else {
    $env:NODO_EMULATOR_TEST_MODE = $previousMode
  }
}

if ($testExitCode -ne 0) {
  exit $testExitCode
}

Write-Host "NoDo_02 Emulator tests passed $Repeat consecutive time(s) in $Mode mode."
Write-Host "NoDo_02 Emulator 통합 테스트와 전용 프로세스 정리를 완료했습니다."
