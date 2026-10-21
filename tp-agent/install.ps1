# tp-agent installer v5 - runs on the TigerPaw server under the owner's Windows account.
# NO ADMIN ANYWHERE. Transport: a NAMED Cloudflare tunnel on the owner's own domain
# (same pattern as his other rigs). The agent binds 127.0.0.1 only; cloudflared runs
# as the owner at logon and dials OUT to Cloudflare. No inbound ports.
# The tunnel token lives in tp-agent\tunnel-token.txt (owner creates it once from the
# Cloudflare Zero Trust dashboard). Idempotent: safe to re-run any time.
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AgentUrl = 'https://raw.githubusercontent.com/btoth525/Salesforce-to-Tigerpaw-Converter/main/tp-agent/tp_agent.py'
$PyUrl    = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$CfUrl    = 'https://github.com/cloudflare/cloudflared/releases/download/2023.10.0/cloudflared-windows-amd64.exe'
$Port     = 8799
$PublicHost = 'tp-x7q4.plexserver525.com'

$Base    = Join-Path $env:USERPROFILE 'tp-agent'
$PyDir   = Join-Path $Base 'python'
$Status  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'tp-agent-status.txt'
$CfgPath = Join-Path $Base 'tp_agent_config.json'
$CfExe   = Join-Path $Base 'cloudflared.exe'
$TokFile = Join-Path $Base 'tunnel-token.txt'
$wc = New-Object Net.WebClient

function Stat($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $Status -Value $line -Encoding UTF8
  Write-Host $line
}

New-Item -ItemType Directory -Force $Base | Out-Null
Set-Content -Path $Status -Value "tp-agent install v4 started on $env:COMPUTERNAME as $env:USERNAME" -Encoding UTF8
Stat "workdir: $Base"

# --- Python (embeddable, no admin needed) ---
$pyExe = Join-Path $PyDir 'python.exe'
if (-not (Test-Path $pyExe)) {
  try {
    $zip = Join-Path $Base 'python-embed.zip'
    Stat 'downloading python embeddable...'
    $wc.DownloadFile($PyUrl, $zip)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $PyDir)
    Stat 'python extracted'
  } catch { Stat "PYTHON DOWNLOAD FAILED: $_" }
} else { Stat 'python already present' }

if (Test-Path $pyExe) {
  $pth = Get-ChildItem $PyDir -Filter 'python*._pth' | Select-Object -First 1
  if ($pth) {
    $c = Get-Content $pth.FullName
    if ($c -notcontains $Base) {
      Add-Content $pth.FullName $Base
      Stat "pth updated: $($pth.Name)"
    }
  }
  Stat "python version: $(& $pyExe --version 2>&1)"
}

# --- Agent file (always refresh) ---
try {
  $wc.DownloadFile($AgentUrl, (Join-Path $Base 'tp_agent.py'))
  Stat 'tp_agent.py downloaded (latest)'
} catch { Stat "AGENT DOWNLOAD FAILED: $_" }

# --- Token (kept across versions once valid) ---
$token = $null
if (Test-Path $CfgPath) {
  try {
    $old = Get-Content $CfgPath -Raw | ConvertFrom-Json
    if ($old.token -and $old.token.Length -ge 32) { $token = $old.token }
  } catch {}
}
if (-not $token) {
  $token = ([guid]::NewGuid().ToString('N')) + ([guid]::NewGuid().ToString('N'))
  Stat 'new token generated'
} else {
  Stat 'existing valid token kept'
}
@{ token = $token; port = $Port; bind = '127.0.0.1' } | ConvertTo-Json | Set-Content $CfgPath -Encoding ASCII
Stat 'config written (bind 127.0.0.1, localhost only)'

# --- cloudflared exe (user-level, no admin) ---
if (-not (Test-Path $CfExe)) {
  try {
    Stat 'downloading cloudflared...'
    $wc.DownloadFile($CfUrl, $CfExe)
    Stat 'cloudflared downloaded'
  } catch { Stat "CLOUDFLARED DOWNLOAD FAILED: $_" }
} else { Stat 'cloudflared already present' }

# --- Scheduled tasks (interactive session, restart on failure) ---
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

try { Stop-ScheduledTask -TaskName 'tp-agent' -ErrorAction SilentlyContinue } catch {}
# Stop-ScheduledTask is ASYNC: if the old python still holds the port, the new
# instance exits on bind (or Start is ignored) and the agent dies minutes after
# a "healthy" check. Wait until the port is really free before re-registering.
$busy = $true
for ($i = 0; $i -lt 20; $i++) {
  $busy = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if (-not $busy) { break }
  Start-Sleep -Seconds 1
}
if ($busy) {
  Stat 'port still busy after stop - killing the stale agent python'
  Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $pyExe } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
try {
  $action = New-ScheduledTaskAction -Execute $pyExe -Argument 'tp_agent.py' -WorkingDirectory $Base
  Register-ScheduledTask -TaskName 'tp-agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'tp-agent'
  Stat 'scheduled task tp-agent registered + started'
} catch { Stat "AGENT TASK FAILED: $_" }

Start-Sleep -Seconds 3
try {
  $h = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/health" -TimeoutSec 10
  Stat "agent health: $($h.Content)"
} catch { Stat "AGENT HEALTH CHECK FAILED: $_" }

# --- Tunnel task (only when the owner has supplied the tunnel token) ---
$tunnelToken = $null
if (Test-Path $TokFile) {
  $tunnelToken = (Get-Content $TokFile -Raw).Trim()
}
try { Stop-ScheduledTask -TaskName 'tp-tunnel' -ErrorAction SilentlyContinue } catch {}
# Same async-stop trap as the agent: wait for the old cloudflared to exit.
for ($i = 0; $i -lt 10; $i++) {
  $cf = Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $CfExe }
  if (-not $cf) { break }
  Start-Sleep -Seconds 1
}
if ($tunnelToken -and $tunnelToken.Length -gt 50 -and (Test-Path $CfExe)) {
  try {
    $cfArgs = "tunnel --no-autoupdate run --token $tunnelToken"
    $action2 = New-ScheduledTaskAction -Execute $CfExe -Argument $cfArgs -WorkingDirectory $Base
    Register-ScheduledTask -TaskName 'tp-tunnel' -Action $action2 -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'tp-tunnel'
    Stat 'scheduled task tp-tunnel registered + started (named tunnel)'
  } catch { Stat "TUNNEL TASK FAILED: $_" }
} else {
  Stat 'NO TUNNEL TOKEN YET - create tunnel-token.txt in the tp-agent folder, then re-run this installer.'
}

# --- Final status block ---
Stat '================ HAND THIS TO PAPI ================'
if ($tunnelToken) {
  Stat "agent url:   https://$PublicHost/rpc   (named tunnel on your domain; agent itself is localhost-only)"
} else {
  Stat 'agent url:   PENDING TUNNEL TOKEN (see Papi instructions)'
}
Stat "agent token: $token"
Stat 'safety: no admin used, no inbound ports; agent binds 127.0.0.1; tunnel dials out to Cloudflare; every call needs the token.'
Stat '===================================================='
Write-Host ''
Write-Host 'tp-agent install v4 finished. Status file: tp-agent-status.txt on your Desktop.'
