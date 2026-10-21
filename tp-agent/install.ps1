# tp-agent installer v3 - runs on the TigerPaw server under the owner's Windows account.
# Transport: TAILSCALE ONLY. The agent binds to the server's tailnet IP; there is no
# public URL and no inbound port. The v2 Cloudflare quick tunnel is removed here.
# Two beats: run once (installs Tailscale; owner approves the node), then run the
# SAME one-liner again after approval (binds the agent to the tailnet IP).
# Idempotent: safe to re-run any time.
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AgentUrl = 'https://raw.githubusercontent.com/btoth525/Salesforce-to-Tigerpaw-Converter/main/tp-agent/tp_agent.py'
$PyUrl    = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$TsMsiUrl = 'https://muse.ai/files/1262039693669320/2665658247229484/vgrzs1c72i0imveig59beoh8/tailscale-setup-1.54.1-amd64.msi'
$Port     = 8799

$Base    = Join-Path $env:USERPROFILE 'tp-agent'
$PyDir   = Join-Path $Base 'python'
$Status  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'tp-agent-status.txt'
$CfgPath = Join-Path $Base 'tp_agent_config.json'
$TsExe   = 'C:\Program Files\Tailscale\tailscale.exe'
$wc = New-Object Net.WebClient

function Stat($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $Status -Value $line -Encoding UTF8
  Write-Host $line
}

New-Item -ItemType Directory -Force $Base | Out-Null
Set-Content -Path $Status -Value "tp-agent install v3 started on $env:COMPUTERNAME as $env:USERNAME" -Encoding UTF8
Stat "workdir: $Base"

# --- Remove the v2 public tunnel (safety cleanup) ---
try { Stop-ScheduledTask -TaskName 'tp-tunnel' -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName 'tp-tunnel' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Stat 'old cloudflare tunnel removed (if it existed)'

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

# --- Tailscale: install (pinned 1.54.1, last line that runs on Server 2012 R2) ---
if (-not (Test-Path $TsExe)) {
  try {
    $msi = Join-Path $Base 'tailscale-setup.msi'
    Stat 'downloading tailscale msi (from Papi mirror)...'
    $wc.DownloadFile($TsMsiUrl, $msi)
    $p = Start-Process msiexec -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart' -Wait -PassThru
    Stat "tailscale msi exit code: $($p.ExitCode)"
  } catch { Stat "TAILSCALE INSTALL FAILED: $_" }
} else { Stat 'tailscale already installed' }

# --- Tailscale: bring it up; if it needs sign-in, capture the auth link ---
$tsIp = $null
if (Test-Path $TsExe) {
  $ipOut = (& $TsExe ip -4 2>&1 | Out-String).Trim()
  if ($ipOut -match '^\d+\.\d+\.\d+\.\d+$') {
    $tsIp = $ipOut
    Stat "tailscale already up: $tsIp"
  } else {
    Stat 'tailscale needs sign-in - starting tailscale up (auth link lands below):'
    $upOut = (& $TsExe up 2>&1 | Out-String)
    Stat $upOut.Trim()
    $ipOut = (& $TsExe ip -4 2>&1 | Out-String).Trim()
    if ($ipOut -match '^\d+\.\d+\.\d+\.\d+$') { $tsIp = $ipOut }
  }
}

# --- Config: bind to the tailnet IP when we have one, else localhost for now ---
$bind = '127.0.0.1'
if ($tsIp) { $bind = $tsIp }
@{ token = $token; port = $Port; bind = $bind } | ConvertTo-Json | Set-Content $CfgPath -Encoding ASCII
Stat "config written (bind $bind)"

# --- Agent task: (re)register + start in the interactive session ---
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { Stop-ScheduledTask -TaskName 'tp-agent' -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 1
try {
  $action = New-ScheduledTaskAction -Execute $pyExe -Argument 'tp_agent.py' -WorkingDirectory $Base
  Register-ScheduledTask -TaskName 'tp-agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'tp-agent'
  Stat 'scheduled task tp-agent registered + started'
} catch { Stat "AGENT TASK FAILED: $_" }

Start-Sleep -Seconds 3
try {
  $h = Invoke-WebRequest -UseBasicParsing -Uri "http://${bind}:$Port/health" -TimeoutSec 10
  Stat "agent health on ${bind}: $($h.Content)"
} catch { Stat "AGENT HEALTH CHECK FAILED on ${bind}: $_" }

# --- Final status block ---
Stat '================ HAND THIS TO PAPI ================'
if ($tsIp) {
  Stat "agent url:   http://${tsIp}:$Port/rpc   (tailnet only - nothing public, no open ports)"
} else {
  Stat 'agent url:   PENDING - approve this server in Tailscale (auth link above), then run the same installer line ONE more time.'
}
Stat "agent token: $token"
Stat 'safety: agent binds to the tailnet IP only; every call needs the token; killing the tp-agent task cuts access.'
Stat '===================================================='
Write-Host ''
Write-Host 'tp-agent install v3 finished. Status file: tp-agent-status.txt on your Desktop.'
