# Silent toast activation for dsh-attention.
# URI is path-based (dsh-attention://do/TOKEN/ACTION) so cmd.exe cannot split on &.
# Simple actions hit loopback GET /act. "compose" opens a small app-window to answer.
param(
  [Parameter(Position = 0)]
  [string]$Uri
)

if (-not $Uri) { $Uri = $env:DSH_ATTENTION_URI }
if (-not $Uri) { $Uri = $args[0] }
if (-not $Uri) { exit 0 }
$Uri = [string]$Uri.Trim().Trim('"')

function Write-ActLog([string]$Line) {
  try {
    $dir = Join-Path $env:USERPROFILE '.dsh'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Add-Content -LiteralPath (Join-Path $dir 'dsh-attention-handler.log') -Value ("{0} {1}" -f (Get-Date -Format o), $Line) -Encoding UTF8
  } catch {}
}

function Get-WebUrl {
  $configPath = Join-Path $env:USERPROFILE '.dsh\dsh-attention-handler.json'
  if (Test-Path $configPath) {
    try {
      $json = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($json.webUrl) { return ([string]$json.webUrl).TrimEnd('/') }
    } catch {}
  }
  return 'http://127.0.0.1:3080'
}

function Get-QueryMap([string]$Raw) {
  $map = @{}
  $stripped = $Raw -replace '^dsh-attention:(//)?', ''
  $path = $stripped
  $query = ''
  $qIndex = $stripped.IndexOf('?')
  if ($qIndex -ge 0) {
    $path = $stripped.Substring(0, $qIndex)
    $query = $stripped.Substring($qIndex + 1)
  }
  $parts = @($path.Split('/') | Where-Object { $_ })
  if ($parts.Count -ge 3 -and ($parts[0] -eq 'do' -or $parts[0] -eq 'act')) {
    $map['t'] = [Uri]::UnescapeDataString($parts[1])
    $map['a'] = [Uri]::UnescapeDataString($parts[2])
  }
  foreach ($pair in $query.Split('&')) {
    if (-not $pair) { continue }
    $kv = $pair.Split('=', 2)
    $key = [Uri]::UnescapeDataString($kv[0])
    $value = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1]) } else { '' }
    if ($key) { $map[$key] = $value }
  }
  return $map
}

function Focus-ProcessWindow($Proc) {
  if (-not $Proc -or $Proc.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
  try {
    $wshell = New-Object -ComObject WScript.Shell
    if ($wshell.AppActivate($Proc.Id)) { return $true }
    if ($Proc.MainWindowTitle) { return [bool]$wshell.AppActivate($Proc.MainWindowTitle) }
  } catch {}
  return $false
}

function Get-CandidateWindows {
  Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
}

function Focus-DshWindow([string]$WebUrl) {
  $hostHint = '127.0.0.1:3080'
  try { $hostHint = ([Uri]$WebUrl).Authority } catch {}
  $port = (($hostHint -split ':')[-1])
  $titlePat = 'DeepSeek|Harness|dsh|' + [regex]::Escape($hostHint) + '|localhost:' + [regex]::Escape($port)

  foreach ($proc in Get-CandidateWindows) {
    $title = [string]$proc.MainWindowTitle
    if ($title -and ($title -match $titlePat)) {
      if (Focus-ProcessWindow $proc) { return $true }
    }
  }

  try {
    $apps = @(Get-StartApps | Where-Object {
      $_.Name -match 'DeepSeek|Harness|dsh' -or
      $_.AppID -match 'DeepSeek|Harness|dsh|3080|127\.0\.0\.1'
    })
    if ($apps.Count -gt 0) {
      Start-Process ("shell:AppsFolder\" + $apps[0].AppID) | Out-Null
      return $true
    }
  } catch {}

  $browserNames = @('msedge', 'chrome', 'brave', 'firefox', 'opera')
  foreach ($proc in Get-CandidateWindows) {
    if ($browserNames -contains $proc.ProcessName) {
      if (Focus-ProcessWindow $proc) { return $true }
    }
  }

  Start-Process $WebUrl | Out-Null
  return $false
}

function Get-AppBrowser {
  $cands = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )
  foreach ($path in $cands) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

function Open-ComposeUi([string]$WebUrl, [string]$Token) {
  $choice = Join-Path $PSScriptRoot 'choice-window.ps1'
  if (Test-Path -LiteralPath $choice) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -ArgumentList @(
      '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', $choice, '-Token', $Token
    ) | Out-Null
    return
  }
  $url = $WebUrl + '/dsh-attention/ui?t=' + [Uri]::EscapeDataString($Token)
  $browser = Get-AppBrowser
  if ($browser) {
    Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--window-size=520,760', '--new-window') | Out-Null
    return
  }
  Start-Process $url | Out-Null
}

function Invoke-Act([string]$WebUrl, $Map) {
  $pairs = New-Object System.Collections.Generic.List[string]
  foreach ($key in $Map.Keys) {
    [void]$pairs.Add(([Uri]::EscapeDataString([string]$key) + '=' + [Uri]::EscapeDataString([string]$Map[$key])))
  }
  $act = $WebUrl + '/dsh-attention/act?' + ($pairs -join '&')
  $req = [System.Net.HttpWebRequest]::Create($act)
  $req.Method = 'GET'
  $req.Timeout = 12000
  $req.AllowAutoRedirect = $false
  $req.Headers.Add('X-Dsh-Attention', '1')
  $req.Accept = 'application/json'
  $resp = $req.GetResponse()
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $text = $reader.ReadToEnd()
  $reader.Close()
  $resp.Close()
  try { return $text | ConvertFrom-Json } catch { return $null }
}

$webUrl = Get-WebUrl
$map = Get-QueryMap $Uri
$action = [string]$map['a']
$token = [string]$map['t']
Write-ActLog ("uri=$Uri t=$token a=$action")

if ($action -eq 'compose') {
  if ($token) { Open-ComposeUi $webUrl $token }
  exit 0
}

$result = $null
try { $result = Invoke-Act $webUrl $map } catch {
  Write-ActLog ("act-error=$($_.Exception.Message)")
  $result = $null
}

$wantFocus = $false
if ($result -and $result.focus -eq $true) { $wantFocus = $true }
elseif ($action -eq 'open' -or -not $action) { $wantFocus = $true }

if ($wantFocus) { Focus-DshWindow $webUrl | Out-Null }
if (-not $result -and $action -ne 'open' -and $action) { exit 1 }
exit 0
