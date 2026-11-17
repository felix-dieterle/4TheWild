#requires -Version 5.1
<#
.SYNOPSIS
    Builds a locally signed debug APK for 4TheWild with an increasing versionCode.

.DESCRIPTION
    1. Ensures the Gradle wrapper exists (copied from MyBudgets, Gradle 8.7).
    2. Bundles the web assets into android/app/src/main/assets/www and patches
       APP_BUILD to the resolved versionCode.
    3. Builds :app:assembleDebug with -PversionCode.
    4. Verifies package name and versionCode with aapt2, prints SHA256.

    versionCode = 1000 + git commit count (or -VersionCode <n>).

.NOTES
    ASCII only (PowerShell 5.1 without BOM).
#>
param(
    [string]$Source = 'F:\oc-projects\4TheWild',
    [int]$VersionCode = 0,
    [string]$WrapperSource = 'F:\CascadeProjects\MyBudgets'
)

$ErrorActionPreference = 'Stop'

$androidDir = Join-Path $Source 'android'
$www        = Join-Path $androidDir 'app\src\main\assets\www'
$log        = Join-Path $Source 'build-apk.log'

if (-not (Test-Path -LiteralPath (Join-Path $androidDir 'app\build.gradle'))) {
    throw "Android project missing: $androidDir"
}

if ($VersionCode -le 0) {
    $count = & git -c 'safe.directory=*' -C $Source rev-list --count HEAD
    if ($LASTEXITCODE -ne 0 -or -not $count) { throw 'git rev-list failed' }
    $VersionCode = 1000 + [int]$count
}
if ($VersionCode -lt 1000) { $VersionCode += 1000 }

# Gradle wrapper (repo has none yet)
foreach ($f in @('gradlew', 'gradlew.bat')) {
    $dst = Join-Path $androidDir $f
    if (-not (Test-Path -LiteralPath $dst)) {
        Copy-Item -LiteralPath (Join-Path $WrapperSource $f) -Destination $dst -Force
    }
}
$wrapperDir = Join-Path $androidDir 'gradle\wrapper'
New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null
foreach ($f in @('gradle-wrapper.jar', 'gradle-wrapper.properties')) {
    $dst = Join-Path $wrapperDir $f
    if (-not (Test-Path -LiteralPath $dst)) {
        Copy-Item -LiteralPath (Join-Path $WrapperSource "gradle\wrapper\$f") -Destination $dst -Force
    }
}

# SDK path
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
if (-not (Test-Path -LiteralPath $sdk)) { throw "Android SDK not found: $sdk" }
$sdkProp = $sdk.Replace('\', '/')
[IO.File]::WriteAllText((Join-Path $androidDir 'local.properties'), "sdk.dir=$sdkProp`n", (New-Object Text.UTF8Encoding($false)))
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# Web assets
if (Test-Path -LiteralPath $www) { Remove-Item -LiteralPath $www -Recurse -Force }
New-Item -ItemType Directory -Path $www -Force | Out-Null
foreach ($f in @('index.html', 'app.js', 'style.css', 'manifest.json', 'logo.svg')) {
    Copy-Item -LiteralPath (Join-Path $Source $f) -Destination $www -Force
}
Copy-Item -LiteralPath (Join-Path $Source 'lib')   -Destination $www -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Source 'icons') -Destination $www -Recurse -Force

$appJsPath = Join-Path $www 'app.js'
$appJs = [IO.File]::ReadAllText($appJsPath, [Text.Encoding]::UTF8)
$appJs = [Regex]::Replace($appJs, 'const APP_BUILD\s*=\s*\d+', "const APP_BUILD   = $VersionCode")
[IO.File]::WriteAllText($appJsPath, $appJs, (New-Object Text.UTF8Encoding($false)))

Write-Output "building APK with versionCode $VersionCode ..."

$gradlew = Join-Path $androidDir 'gradlew.bat'
$gradleArgs = @(':app:assembleDebug', "-PversionCode=$VersionCode", '--no-daemon', '--console=plain')
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $gradlew -ArgumentList $gradleArgs -WorkingDirectory $androidDir `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
if (-not $p.WaitForExit(600000)) {
    & taskkill /PID $p.Id /T /F | Out-Null
    throw 'Gradle build timed out'
}

$buildLog = [IO.File]::ReadAllText($log, [Text.Encoding]::UTF8) + [IO.File]::ReadAllText("$log.err", [Text.Encoding]::UTF8)
if ($buildLog -notmatch 'BUILD SUCCESSFUL') {
    $buildLog -split "`n" | Select-Object -Last 25 | Write-Output
    throw 'Gradle build failed (no BUILD SUCCESSFUL)'
}

$apk = Join-Path $androidDir 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "APK not found: $apk" }

$aapt = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Filter 'aapt2.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
if ($aapt) {
    $badging = & $aapt.FullName dump badging $apk 2>&1
    $badging | Where-Object { $_ -match '^package:|^sdkVersion|^targetSdkVersion' } | Write-Output
}

$apksigner = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Filter 'apksigner.bat' -Recurse -ErrorAction SilentlyContinue |
             Sort-Object FullName -Descending | Select-Object -First 1
if ($apksigner) {
    & $apksigner.FullName verify --print-certs $apk 2>&1 |
        Where-Object { $_ -match 'SHA-256|DN:' } | Write-Output
}

$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash
Write-Output "APK:    $apk"
Write-Output "SHA256: $hash"
Write-Output "SIZE:   $((Get-Item -LiteralPath $apk).Length) bytes"
