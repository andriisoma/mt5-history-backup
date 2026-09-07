$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'backup-run.log'
$cli = 'C:\Cursor\somatrading\mt5-batch-optimizer\src-tauri\target\release\mt5-batch-cli.exe'

function Test-IcBusy {
  $occ = & $cli occupancy | ConvertFrom-Json
  $ic = $occ.terminals | Where-Object {
    $_.installPath -eq 'C:\Program Files\MetaTrader 5 IC Markets Global'
  }
  return [bool]$ic.cliBusy
}

function Write-Log($msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

Write-Log 'waiting for IC Markets cliBusy to clear...'
while (Test-IcBusy) {
  Write-Log 'still cliBusy, sleeping 60s...'
  Start-Sleep 60
}

Write-Log 'starting backup...'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
node (Join-Path $repoRoot 'src/backup.mjs') `
  --dest 'C:\Users\andrs\My Drive\Forex\Ticks history backup' `
  --server ICMarketsSC-MT5 `
  --terminal 010E047102812FC0C18890992854220E `
  2>&1 | ForEach-Object { Write-Log $_ }

Write-Log "backup finished exit=$LASTEXITCODE"
