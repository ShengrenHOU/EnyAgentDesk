param(
    [Parameter(Mandatory)][string]$DshHome,
    [Parameter(Mandatory)][string]$DshCli,
    [Parameter(Mandatory)][string]$LarkConfigDir,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'superagent',
    [string]$NodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
foreach ($entry in @($DshHome, $DshCli, $LarkConfigDir, $NodePath)) {
    if (-not [IO.Path]::IsPathFullyQualified($entry) -or -not (Test-Path -LiteralPath $entry)) {
        throw 'Supply existing absolute runtime, CLI, configuration and Node paths.'
    }
}
if (-not $env:DEEPSEEK_API_KEY) { throw 'Start through the approved secret broker with DEEPSEEK_API_KEY mapped.' }
$previous = @{
    DSH_HOME = $env:DSH_HOME
    LARKSUITE_CLI_CONFIG_DIR = $env:LARKSUITE_CLI_CONFIG_DIR
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER = $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER = $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER
}
try {
    $env:DSH_HOME = $DshHome
    $env:LARKSUITE_CLI_CONFIG_DIR = $LarkConfigDir
    $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
    $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
    & $NodePath $DshCli $Profile --no-open
    if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE" }
}
finally {
    foreach ($entry in $previous.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
}
