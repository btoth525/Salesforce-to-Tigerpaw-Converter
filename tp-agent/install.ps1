# tp-agent installer v2 - runs on the TigerPaw server under the owner's Windows account.
# Safe by design: the agent listens on 127.0.0.1 ONLY. No inbound ports are opened.
# Reachability is an OUTBOUND Cloudflare quick tunnel (cloudflared) protected by a
# long random bearer token. Idempotent: safe to re-run; re-running rotates in the
# fixed token/config and restarts both scheduled tasks.
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AgentUrl = 'https://raw.githubusercontent.com/btoth525/Salesforce-to-Tigerpaw-Converter/main/tp-agent/tp_agent.py'
$PyUrl    = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$CfUrl    = 'https://github.com/cloudflare/cloudflared/releases/download/2023.10.0/cloudflared-windows-amd64.exe'
$Port     = 8799

$Base    = Join-Path $env:USERPROFILE 'tp-agent'
$PyDir   = Join-Path $Base 'python'
$Status  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'tp-agent-status.txt'
$CfExe   = Join-Path $Base 'cloudflared.exe'
$CfLog   = Join-Path $Base 'tunnel.log'
$CfgPath = Join-Path $Base 'tp_agent_config.json'
$wc = New-Object Net.WebClient

function Stat($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $Status -Value $line -Encoding UTF8
  Write-Host $line
}

New-Item -ItemType Directory -Force $Base | Out-Null
Set-Content -Path $Status -Value "tp-agent install v2 started on $env:COMPUTERNAME as $env:USERNAME" -Encoding UTF8
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

# --- Config + token ---
# v1 used New-Guid, which does not exist on PowerShell 4 (Server 2012 R2), so the
# v1 token is broken. Regenerate whenever the stored token is missing or short.
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
@{ token = $token; port = $Port; bind = '127.0.0.1' } | ConvertTo-Json | Set-Content $CfgPath -Encoding UTF8
Stat 'config written (bind 127.0.0.1, localhost only)'

# --- cloudflared (single exe, no admin, outbound only) ---
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

# --- Tunnel task ---
try { Stop-ScheduledTask -TaskName 'tp-tunnel' -ErrorAction SilentlyContinue } catch {}
if (Test-Path $CfLog) { Remove-Item $CfLog -Force -ErrorAction SilentlyContinue }
if (Test-Path $CfExe) {
  try {
    $cfArgs = "tunnel --url http://127.0.0.1:$Port --no-autoupdate --logfile `"$CfLog`" --loglevel info"
    $action2 = New-ScheduledTaskAction -Execute $CfExe -Argument $cfArgs -WorkingDirectory $Base
    Register-ScheduledTask -TaskName 'tp-tunnel' -Action $action2 -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'tp-tunnel'
    Stat 'scheduled task tp-tunnel registered + started'
  } catch { Stat "TUNNEL TASK FAILED: $_" }
}

# --- Wait for the tunnel URL to appear in the log ---
$tunnelUrl = $null
for ($i = 0; $i -lt 15 -and -not $tunnelUrl; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $CfLog) {
    $m = Select-String -Path $CfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $tunnelUrl = $m.Matches[0].Value }
  }
}
if ($tunnelUrl) { Stat "tunnel url: $tunnelUrl" } else { Stat 'TUNNEL URL NOT FOUND YET - check tunnel.log in the tp-agent folder' }

# --- Final status block ---
Stat '================ HAND THIS TO PAPI ================'
if ($tunnelUrl) { Stat "agent url:   $tunnelUrl/rpc" } else { Stat 'agent url:   (tunnel pending - see tunnel.log)' }
Stat "agent token: $token"
Stat 'safety: agent listens on 127.0.0.1 only; no inbound ports opened; tunnel is outbound-only; every call needs the token.'
Stat '===================================================='
Write-Host ''
Write-Host 'tp-agent install v2 finished. Status file: tp-agent-status.txt on your Desktop.'
