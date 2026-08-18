[CmdletBinding()]
param(
  [string]$DatabaseName = "needle-drop-archive",
  [string]$WorkerName = "needle-drop-archive",
  [ValidateSet("weur", "eeur", "apac", "oc", "wnam", "enam")]
  [string]$Location = "apac",
  [string]$AllowedEmail,
  [string]$AccessTeamDomain,
  [string]$AccessAudience,
  [switch]$ReuseExisting,
  [switch]$SkipInstall,
  [switch]$SkipVerification,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
  throw "The assisted installer currently supports Windows only. Use Deploy to Cloudflare on macOS or Linux."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$privateConfig = Join-Path $repoRoot "wrangler.private.jsonc"
$previousBuildConfig = $env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$npx = (Get-Command npx -ErrorAction SilentlyContinue).Source
if (-not $npm -or -not $node -or -not $npx) {
  throw "Node.js, npm and npx must be available in PATH. Install Node.js >= 22.13.0 first."
}

$nodeVersion = (& $node -p "process.versions.node" | Out-String).Trim()
if ([version]$nodeVersion -lt [version]"22.13.0") {
  throw "Node.js $nodeVersion is too old. Install Node.js >= 22.13.0."
}

Push-Location $repoRoot
try {
  if (-not $SkipInstall) {
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  }

  $whoamiOutput = (& $npx wrangler whoami 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    if ($NonInteractive) {
      throw "Cloudflare login is required. Run 'npx wrangler login' and retry."
    }
    & $npx wrangler login | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare login was not completed." }
  }
  else {
    Write-Host "Cloudflare authentication is ready."
  }

  $databaseList = (& $npx wrangler d1 list --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect D1 resources. No deployment was started." }
  $databaseExisted = @($databaseList | ConvertFrom-Json) |
    Where-Object { $_.name -eq $DatabaseName } |
    Select-Object -First 1

  if ($databaseExisted -and -not $ReuseExisting) {
    if ($NonInteractive) {
      throw "D1 '$DatabaseName' already exists. Rerun with -ReuseExisting only after confirming that this is the intended instance."
    }
    $reuseAnswer = Read-Host "D1 '$DatabaseName' already exists. Reuse it and create a Desktop backup before migration? [y/N]"
    if ($reuseAnswer -notmatch '^(?i:y|yes)$') {
      throw "Existing resource reuse was not confirmed; nothing was migrated or deployed."
    }
  }

  & (Join-Path $PSScriptRoot "bootstrap-cloudflare.ps1") `
    -DatabaseName $DatabaseName `
    -WorkerName $WorkerName `
    -Location $Location `
    -Confirm:$false
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $privateConfig)) {
    throw "Cloudflare resource bootstrap did not finish."
  }

  if ($databaseExisted) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $backupDirectory = Join-Path $desktop "needle-drop-archive-backups"
    if (-not (Test-Path -LiteralPath $backupDirectory)) {
      New-Item -ItemType Directory -Path $backupDirectory | Out-Null
    }
    $backupPath = Join-Path $backupDirectory ("{0}-{1}.sql" -f $DatabaseName, (Get-Date -Format "yyyyMMdd-HHmmss"))
    $backupOutput = (& $npx wrangler d1 export DB --remote --output $backupPath --config $privateConfig 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Remote D1 backup failed; deployment was not started. Inspect Cloudflare activity logs for details." }
    Write-Host "Remote D1 backup created on the Desktop."
  }

  $env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = $privateConfig

  if ($SkipVerification) {
    & $npm run build
  }
  else {
    & $npm run verify
  }
  if ($LASTEXITCODE -ne 0) { throw "Project verification or build failed." }

  & $npm run deploy
  if ($LASTEXITCODE -ne 0) { throw "Initial locked deployment failed." }

  if (-not $AllowedEmail -and -not $NonInteractive) {
    $AllowedEmail = Read-Host "Enter the one email address that may access this instance"
  }
  if (-not $AccessTeamDomain -and -not $NonInteractive) {
    Write-Host "Enable Cloudflare Access for the new workers.dev route, allow only the email above, then return here."
    $AccessTeamDomain = Read-Host "Enter the Access team domain (for example, your-team.cloudflareaccess.com)"
  }
  if (-not $AccessAudience -and -not $NonInteractive) {
    $AccessAudience = Read-Host "Enter the Access Application Audience (AUD)"
  }

  if ($AllowedEmail -and $AccessTeamDomain -and $AccessAudience) {
    & (Join-Path $PSScriptRoot "bootstrap-cloudflare.ps1") `
      -DatabaseName $DatabaseName `
      -WorkerName $WorkerName `
      -AllowedEmail $AllowedEmail `
      -AccessTeamDomain $AccessTeamDomain `
      -AccessAudience $AccessAudience `
      -Confirm:$false
    if ($LASTEXITCODE -ne 0) { throw "Access configuration was not saved." }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Access-aware production build failed." }
    & $npm run deploy
    if ($LASTEXITCODE -ne 0) { throw "Final Access-aware deployment failed." }
    Write-Host "Deployment is complete. Open the workers.dev URL, pass the email code, then connect NetEase Cloud Music."
  }
  else {
    Write-Host "The Worker is deployed but remains locked. Complete the Access steps in DEPLOYMENT.md, then rerun this script with the three Access values."
  }
}
finally {
  if ($null -eq $previousBuildConfig) {
    Remove-Item Env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH -ErrorAction SilentlyContinue
  }
  else {
    $env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = $previousBuildConfig
  }
  Pop-Location
}
