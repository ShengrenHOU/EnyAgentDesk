param([Parameter(Mandatory=$true)][string]$Config)

# The launcher owns instance identity, the launch lock and manual stop intent.
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$launcher = if ($settings.launcherPath) { $settings.launcherPath } else { Join-Path $PSScriptRoot 'owner-launcher.py' }
$receiptDirectory = Join-Path $settings.runtime 'watchdog'
New-Item -ItemType Directory -Force -Path $receiptDirectory | Out-Null
try {
  if (-not [IO.Path]::IsPathRooted($launcher) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Configured launcher is unavailable' }
  $output = & $settings.python $launcher --config $Config --start-only --respect-stop 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Launcher failed' }
  $state = ($output -join "`n") | ConvertFrom-Json
  if ($state.manually_stopped) { exit 0 }
  if (-not $state.running) { throw 'No running instance' }
  $listener = Get-NetTCPConnection -State Listen -LocalPort $settings.port -ErrorAction SilentlyContinue | Select-Object -First 1
  # The launcher just validated this listener's identity; a startup receipt can predate an interrupted launch.
  if ($listener) {
    Wait-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  }
  exit 0
} catch {
  $receipt = [ordered]@{ at = (Get-Date).ToString('o'); port = $settings.port; result = 'failed'; detail = 'Launcher failed or did not report a running instance' }
  $path = Join-Path $receiptDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  [System.IO.File]::WriteAllText($path, ($receipt | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  exit 1
}
