# tp-agent installer - runs on the TigerPaw server under the owner's Windows account.
# Idempotent: safe to re-run. Writes progress to Desktop\tp-agent-status.txt
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AgentUrl = 'https://raw.githubusercontent.com/btoth525/Salesforce-to-Tigerpaw-Converter/main/tp-agent/tp_agent.py'
$PyUrl    = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$TsUrl    = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
$Port     = 8799

$Base   = Join-Path $env:USERPROFILE 'tp-agent'
$PyDir  = Join-Path $Base 'python'
$Status = Join-Path ([Environment]::GetFolderPath('Desktop')) 'tp-agent-status.txt'
$wc = New-Object Net.WebClient

function Stat($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $Status -Value $line
  Write-Host $line
}

New-Item -ItemType Directory -Force $Base | Out-Null
Set-Content -Path $Status -Value "tp-agent install started on $env:COMPUTERNAME as $env:USERNAME"
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
  # Make sure the agent dir is importable by the embeddable python.
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

# --- Agent file ---
try {
  $wc.DownloadFile($AgentUrl, (Join-Path $Base 'tp_agent.py'))
  Stat 'tp_agent.py downloaded'
} catch { Stat "AGENT DOWNLOAD FAILED: $_" }

# --- Config + token (generated once, kept on re-runs) ---
$cfgPath = Join-Path $Base 'tp_agent_config.json'
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $token = $cfg.token
  Stat 'existing token kept'
} else {
  $token = ((New-Guid).Guid -replace '-') + ((New-Guid).Guid -replace '-')
  @{ token = $token; port = $Port } | ConvertTo-Json | Set-Content $cfgPath
  Stat 'new token generated'
}

# --- Scheduled task: run in Brandon's interactive session at logon ---
try {
  $action    = New-ScheduledTaskAction -Execute $pyExe -Argument 'tp_agent.py' -WorkingDirectory $Base
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'tp-agent' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  Stat 'scheduled task tp-agent registered'
  Start-ScheduledTask -TaskName 'tp-agent'
  Stat 'scheduled task started'
} catch { Stat "SCHEDULED TASK FAILED: $_" }

Start-Sleep -Seconds 3
try {
  $h = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/health" -TimeoutSec 10
  Stat "agent health: $($h.Content)"
} catch { Stat "AGENT HEALTH CHECK FAILED: $_" }

# --- Tailscale (needs admin for the MSI; failure is non-fatal) ---
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $tsExe)) {
  try {
    $msi = Join-Path $Base 'tailscale-setup.msi'
    Stat 'downloading tailscale...'
    $wc.DownloadFile($TsUrl, $msi)
    $p = Start-Process msiexec -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart' -Wait -PassThru
    Stat "tailscale msi exit code: $($p.ExitCode)"
  } catch { Stat "TAILSCALE INSTALL FAILED (agent still runs on the LAN): $_" }
}
if (Test-Path $tsExe) {
  $tsOut = & $tsExe status 2>&1 | Out-String
  if ($tsOut -match 'Logged out|NeedsLogin|no current Tailscale IPs') {
    Stat 'tailscale needs sign-in - running tailscale up (auth link below):'
    $upOut = & $tsExe up 2>&1 | Out-String
    Stat $upOut
  } else {
    Stat "tailscale status: $tsOut"
  }
  $tsIp = (& $tsExe ip -4 2>&1 | Out-String).Trim()
  Stat "tailscale ip: $tsIp"
} else {
  Stat 'tailscale not installed'
}

# --- Final status block for Brandon to read to Papi ---
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -like '10.*' -or $_.IPAddress -like '192.168.*' } |
          Select-Object -First 1).IPAddress
Stat '================ HAND THIS TO PAPI ================'
Stat "agent LAN url:     http://${lanIp}:$Port/rpc"
if ($tsIp) { Stat "agent tailnet url: http://${tsIp}:$Port/rpc" }
Stat "agent token:       $token"
Stat '===================================================='
Write-Host ''
Write-Host 'tp-agent install finished. Status file: tp-agent-status.txt on your Desktop.'
