#requires -Version 5.1
<#
.SYNOPSIS
    Publishes the 4TheWild web app and its PHP backend to the local Apache.

.DESCRIPTION
    Copies the static front-end and the PHP API into
    F:\CascadeProjects\mama-razzi\public\apps\wild, which is served at
    http://192.168.178.37/apps/wild/.

    Not copied:
      - apps/wild/db/ (CLI-only importer, must not be web-reachable)
      - config.local.php (created by setup-db.ps1, holds credentials)

.NOTES
    ASCII only (PowerShell 5.1 without BOM).
#>
param(
    [string]$Source = 'F:\oc-projects\4TheWild',
    [string]$Target = 'F:\CascadeProjects\mama-razzi\public\apps\wild'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath (Join-Path $Source 'index.html'))) {
    throw "Source does not look like 4TheWild: $Source"
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Target 'lib') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Target 'icons') -Force | Out-Null

$files = @('index.html', 'app.js', 'style.css', 'manifest.json', 'logo.svg')
foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $Source $f) -Destination $Target -Force
}

Copy-Item -LiteralPath (Join-Path $Source 'lib\maplibre-gl.css') -Destination (Join-Path $Target 'lib') -Force
Copy-Item -LiteralPath (Join-Path $Source 'lib\maplibre-gl.js')  -Destination (Join-Path $Target 'lib') -Force
Get-ChildItem -LiteralPath (Join-Path $Source 'icons') -File |
    Copy-Item -Destination (Join-Path $Target 'icons') -Force

$backend = @('api.php', 'config.php', '.htaccess')
foreach ($f in $backend) {
    Copy-Item -LiteralPath (Join-Path $Source "apps\wild\$f") -Destination $Target -Force
}

$php = 'F:\prg\xampp\php\php.exe'
if (Test-Path -LiteralPath $php) {
    & $php -l (Join-Path $Target 'api.php') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'api.php has a PHP syntax error' }
    & $php -l (Join-Path $Target 'config.php') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'config.php has a PHP syntax error' }
} else {
    Write-Warning "php.exe not found at $php - syntax check skipped"
}

if (-not (Test-Path -LiteralPath (Join-Path $Target 'config.local.php'))) {
    Write-Warning 'config.local.php missing - run scripts/setup-db.ps1'
}

Write-Output "deployed to $Target"
