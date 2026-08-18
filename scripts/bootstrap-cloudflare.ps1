[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [string]$DatabaseName = "needle-drop-archive",
  [string]$WorkerName = "needle-drop-archive",
  [ValidateSet("weur", "eeur", "apac", "oc", "wnam", "enam")]
  [string]$Location = "apac",
  [string]$AllowedEmail,
  [string]$AccessTeamDomain,
  [string]$AccessAudience
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $repoRoot "wrangler.jsonc"
$configPath = Join-Path $repoRoot "wrangler.private.jsonc"
$npx = (Get-Command npx -ErrorAction SilentlyContinue).Source

if (-not $npx) {
  throw "npx was not found. Install Node.js >= 22.13.0 first."
}
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "wrangler.jsonc was not found at $templatePath"
}
if (($AllowedEmail -or $AccessTeamDomain -or $AccessAudience) -and
    -not ($AllowedEmail -and $AccessTeamDomain -and $AccessAudience)) {
  throw "AllowedEmail, AccessTeamDomain and AccessAudience must be supplied together."
}

function Set-JsoncStringValue {
  param([string]$Text, [string]$Key, [string]$Value)
  $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
  $pattern = '(?m)("' + [regex]::Escape($Key) + '"\s*:\s*)"[^"]*"'
  if ([regex]::IsMatch($Text, $pattern)) {
    return [regex]::Replace($Text, $pattern, ('$1"' + $escaped + '"'), 1)
  }
  $allowPattern = '(?m)("ALLOW_LOCAL_DEV"\s*:\s*"false")'
  if (-not [regex]::IsMatch($Text, $allowPattern)) {
    throw "Could not find the vars section in the private Wrangler configuration."
  }
  return [regex]::Replace($Text, $allowPattern, ('$1,' + [Environment]::NewLine + '    "' + $Key + '": "' + $escaped + '"'), 1)
}

Push-Location $repoRoot
try {
  $whoamiOutput = (& $npx wrangler whoami 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare authentication is unavailable. Run 'npx wrangler login' and retry."
  }
  Write-Host "Cloudflare authentication is ready."

  $databaseId = $null
  if (Test-Path -LiteralPath $configPath) {
    $existingConfig = [IO.File]::ReadAllText($configPath)
    $idMatch = [regex]::Match(
      $existingConfig,
      '(?i)"database_id"\s*:\s*"(?<id>[0-9a-f-]{36})"'
    )
    if ($idMatch.Success) {
      $databaseId = $idMatch.Groups["id"].Value
      Write-Host "Reusing ignored private configuration and D1 binding."
    }
  }

  if (-not $databaseId) {
    $listOutput = (& $npx wrangler d1 list --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      throw "Could not list D1 databases. No configuration was changed."
    }
    $databases = @($listOutput | ConvertFrom-Json)
    $existing = $databases | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1

    if ($existing) {
      $databaseId = [string]$existing.uuid
      $operation = "Bind existing D1 database '$DatabaseName'"
    }
    else {
      $operation = "Create D1 database '$DatabaseName' in '$Location' and bind it to DB"
      if (-not $PSCmdlet.ShouldProcess("Cloudflare account", $operation)) {
        return
      }
      $createOutput = (& $npx wrangler d1 create $DatabaseName --location $Location --update-config=false 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        throw "D1 creation failed; wrangler.private.jsonc was not changed. Inspect Cloudflare activity logs for details."
      }
      $idMatch = [regex]::Match(
        $createOutput,
        '(?i)database_id[\s"'':=]+(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      )
      if (-not $idMatch.Success) {
        throw "D1 was created, but its ID could not be parsed. Use 'wrangler d1 list --json' to recover it."
      }
      $databaseId = $idMatch.Groups["id"].Value
    }

    $parsedGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($databaseId, [ref]$parsedGuid)) {
      throw "Cloudflare returned an invalid D1 UUID."
    }
    if (-not $PSCmdlet.ShouldProcess($configPath, $operation)) {
      return
    }

    $config = [IO.File]::ReadAllText($templatePath)
    $config = [regex]::Replace($config, '(?m)("name"\s*:\s*)"needle-drop-archive"', ('$1"' + $WorkerName + '"'), 1)
    $config = [regex]::Replace(
      $config,
      '(?m)("database_name"\s*:\s*)"needle-drop-archive"',
      ('$1"' + $DatabaseName + '",' + [Environment]::NewLine + '      "database_id": "' + $databaseId + '"'),
      1
    )
    $config = $config.Replace('"name": "needle-drop-archive-sync"', '"name": "' + $WorkerName + '-sync"')
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
    Write-Host "Created ignored private configuration and bound DB to '$DatabaseName'."
  }

  if ($AllowedEmail -and $AccessTeamDomain -and $AccessAudience) {
    $config = [IO.File]::ReadAllText($configPath)
    $updated = Set-JsoncStringValue $config "ALLOWED_EMAIL" $AllowedEmail.ToLowerInvariant()
    $updated = Set-JsoncStringValue $updated "ACCESS_TEAM_DOMAIN" $AccessTeamDomain
    $updated = Set-JsoncStringValue $updated "ACCESS_AUD" $AccessAudience
    if ($updated -ne $config -and $PSCmdlet.ShouldProcess($configPath, "Store private Access identifiers")) {
      $utf8NoBom = [Text.UTF8Encoding]::new($false)
      [IO.File]::WriteAllText($configPath, $updated, $utf8NoBom)
      Write-Host "Updated ignored private Access configuration."
    }
  }

  Write-Host "Private configuration is ready: $configPath"
}
finally {
  Pop-Location
}
