param(
    [string]$PythonExe,
    [string]$Manifest = (Join-Path $PSScriptRoot 'swap-files-ready.json'),
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
try {
    $plan = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($plan.schemaVersion -ne 2 -or -not $plan.fixedSwap) { throw 'Prepare an identity-bound manifest first.' }
    if (-not $PythonExe) { $PythonExe = $plan.pythonExecutable }
    if (-not $PythonExe -or -not [IO.Path]::IsPathRooted($PythonExe) -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { throw 'Preview must record an existing native Python path, or pass -PythonExe explicitly.' }
    $entry = Join-Path $PSScriptRoot 'windows-wsl-maintenance.py'
    $arguments = @('-u', $entry, '--manifest', $Manifest, '--swap-file', $plan.fixedSwap)
    if ($Execute) {
        $arguments += '--execute'
        # File paths contain no literal double quote; quote each argument for Start-Process.
        $quoted = @($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
        $process = Start-Process -Verb RunAs -FilePath $PythonExe -ArgumentList $quoted -Wait -PassThru
        if ($null -eq $process.ExitCode) { throw 'Child exit status unavailable; inspect the maintenance report.' }
        exit $process.ExitCode
    }
    & $PythonExe @arguments
    exit $LASTEXITCODE
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 3
}
