# ZAAFPulse installer for Windows 10 and 11 (PowerShell 5.1 or 7). One command in PowerShell:
#
#   irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1 | iex
#
# With options (server mode, another port, no background task):
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1))) -Server -Port 4777
#
# What it does: uses Node.js 18+ if you have it, else downloads the official Node.js LTS (checksum
# verified) into %LOCALAPPDATA%\ZAAFPulse\node; downloads ZAAFPulse into %LOCALAPPDATA%\ZAAFPulse\app;
# adds the `zaafpulse` command to your user PATH; starts it now and at every logon (a hidden launcher in
# your Startup folder) and adds a Start menu shortcut. No administrator rights needed, except -System
# (a Task Scheduler task at boot, as SYSTEM, for a server that runs without anyone logged on).
param(
  [switch]$Server,          # listen on the network (0.0.0.0); asks for the dashboard admin password
  [string]$HostAddress = '',
  [int]$Port = 0,
  [string]$Version = '',    # a release tag, or main
  [string]$Source = '',     # install from a local copy instead of downloading
  [switch]$System,          # run at boot as SYSTEM, without a logged-on user (elevated PowerShell)
  [switch]$NoService,
  [switch]$Uninstall,
  [switch]$Purge
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'rifqifitriady/ZAAFPulse'
$Root = Join-Path $env:LOCALAPPDATA 'ZAAFPulse'
$BinDir = Join-Path $Root 'bin'
$Launcher = Join-Path $BinDir 'zaafpulse.cmd'
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }

if ($Uninstall) {
  if (Test-Path $Launcher) { & $Launcher service uninstall $(if ($System) { '--system' }) 2>$null }
  Remove-Item -Recurse -Force (Join-Path $Root 'app'), (Join-Path $Root 'node'), $BinDir -ErrorAction SilentlyContinue
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) { [Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $BinDir }) -join ';', 'User') }
  Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Programs')) 'ZAAFPulse.url') -ErrorAction SilentlyContinue
  Say 'ZAAFPulse removed.'
  if ($Purge) { Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'ZAAFPulse'), $Root -ErrorAction SilentlyContinue; Say 'Data removed too.' }
  else { Say "Your data (config, keys, history) in $env:APPDATA\ZAAFPulse was kept. Add -Purge to delete it." }
  return
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
New-Item -ItemType Directory -Force -Path $Root, $BinDir | Out-Null

# ---- Node.js: yours if it is 18 or newer, else the official LTS in $Root\node ----
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $major = [int]((& $cmd.Source -p 'process.versions.node.split(".")[0]') 2>$null); if ($major -ge 18) { $node = $cmd.Source; Say "Using Node.js $(& $node -v) at $node" } }
if (-not $node -and (Test-Path (Join-Path $Root 'node\node.exe'))) { $node = Join-Path $Root 'node\node.exe'; Say "Using bundled Node.js $(& $node -v)" }
if (-not $node) {
  Say "Downloading Node.js LTS for win-$arch"
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "  node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { throw "No official Node.js build for win-$arch" }
  $want, $file = $line.Trim() -split '\s+'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("zp-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile (Join-Path $tmp $file)
  if ((Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()) { throw 'Node.js checksum mismatch' }
  Expand-Archive (Join-Path $tmp $file) -DestinationPath $tmp -Force
  Remove-Item -Recurse -Force (Join-Path $Root 'node') -ErrorAction SilentlyContinue
  Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) (Join-Path $Root 'node')
  Remove-Item -Recurse -Force $tmp
  $node = Join-Path $Root 'node\node.exe'
  Say "Node.js $(& $node -v) installed in $Root\node"
}

# ---- ZAAFPulse: the latest release, or main when there is none ----
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("zp-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
if ($Source) { $src = (Resolve-Path $Source).Path; Say "Installing ZAAFPulse from $src" }
else {
  if (-not $Version) { try { $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name } catch { $Version = 'main' } }
  $ref = if ($Version -in @('main', 'master')) { "refs/heads/$Version" } else { "refs/tags/$Version" }
  Say "Downloading ZAAFPulse ($Version)"
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/$ref" -OutFile (Join-Path $tmp 'app.zip')
  Expand-Archive (Join-Path $tmp 'app.zip') -DestinationPath $tmp -Force
  $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
}
if (-not (Test-Path (Join-Path $src 'bin\zaafpulse.js'))) { throw 'The download does not look like ZAAFPulse' }
# Stop a running copy so its files can be replaced.
if (Test-Path $Launcher) { & $Launcher service uninstall 2>$null | Out-Null }
$app = Join-Path $Root 'app'
Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $app | Out-Null
foreach ($item in 'bin', 'lib', 'public', 'skills', 'scripts', 'server.js', 'mcp.js', 'package.json', 'config.example.json', 'README.md', 'LICENSE') {
  $p = Join-Path $src $item; if (Test-Path $p) { Copy-Item -Recurse -Force $p $app }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

# ---- the zaafpulse command, on the user PATH ----
Set-Content -Path $Launcher -Encoding ASCII -Value "@echo off`r`n`"$node`" `"$app\bin\zaafpulse.js`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($userPath -split ';') + $BinDir) | Where-Object { $_ }) -join ';', 'User')
  Say 'Added the zaafpulse command to your PATH (open a new terminal to use it).'
}
$env:Path = "$BinDir;$env:Path"

# ---- server mode: an admin password before the first start ----
if ($Server -and -not $HostAddress) { $HostAddress = '0.0.0.0' }
if ($HostAddress) { $env:ZAAFPULSE_HOST = $HostAddress }
if ($Port) { $env:ZAAFPULSE_PORT = "$Port" }
$serverMode = $HostAddress -and $HostAddress -notin @('127.0.0.1', 'localhost')
if ($serverMode) {
  if ($env:ZAAFPULSE_ADMIN_PASSWORD) { $env:ZAAFPULSE_ADMIN_PASSWORD | & $Launcher set-password }
  else {
    Say 'Server mode: choose the dashboard admin password (10+ characters)'
    $s = Read-Host -AsSecureString 'Admin password'
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    $plain | & $Launcher set-password
    $plain = $null
  }
}

# ---- background launcher and Start menu shortcut ----
if (-not $NoService) {
  $svcArgs = @('service', 'install'); if ($System) { $svcArgs += '--system' }
  & $Launcher @svcArgs
  if ($LASTEXITCODE -ne 0) { Warn 'Not started in the background; start it yourself with: zaafpulse start' }
}
$p = if ($Port) { $Port } else { 4777 }
Set-Content -Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'ZAAFPulse.url') -Value "[InternetShortcut]`r`nURL=http://localhost:$p/`r`n"

Write-Host ''
Say 'ZAAFPulse is installed.'
if ($serverMode) {
  Write-Host "    Dashboard:  http://$($env:COMPUTERNAME):$p   (sign in with the admin password)"
  Write-Host "    Firewall:   New-NetFirewallRule -DisplayName ZAAFPulse -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow   (elevated)"
  Write-Host '    Use HTTPS in production: a reverse proxy, or ZAAFPULSE_TLS_CERT and ZAAFPULSE_TLS_KEY.'
} else { Write-Host "    Dashboard:  http://localhost:$p   (also in the Start menu)" }
Write-Host '    Commands:   zaafpulse status | doctor | open | service restart | help'
Write-Host "    Uninstall:  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/install.ps1))) -Uninstall"
