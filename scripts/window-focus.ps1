# Shared Web/PWA window discovery and verified foreground activation.
# C# P/Invoke helpers. Compile once per PowerShell runtime, then reuse the DLL
# so a popup does not pay the Add-Type compile cost every time.
$nativeSource = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshAttentionDpiBoot {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
public static class DshAttentionNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  public static string ListVisibleWindows() {
    var sb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == IntPtr.Zero) return true;
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var buf = new StringBuilder(len + 1);
      GetWindowText(h, buf, buf.Capacity);
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      sb.Append(h.ToInt64());
      sb.Append('\t');
      sb.Append(pid);
      sb.Append('\t');
      sb.Append(buf.ToString().Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '));
      sb.Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@

function Initialize-DshAttentionNative {
  if (('DshAttentionDpiBoot' -as [type]) -and ('DshAttentionNative' -as [type])) { return 'memory' }
  $tag = if ([string]$PSVersionTable.PSEdition -eq 'Core') { 'core' } else { 'desktop' }
  $cacheDir = Join-Path $env:USERPROFILE '.dsh\dsh-attention-work'
  $cacheDll = Join-Path $cacheDir ('DshAttentionNative-v3-' + $tag + '.dll')
  if (Test-Path -LiteralPath $cacheDll) {
    try {
      Add-Type -Path $cacheDll -ErrorAction Stop
      if (('DshAttentionDpiBoot' -as [type]) -and ('DshAttentionNative' -as [type])) { return 'cache' }
    } catch { }
  }
  try {
    if (-not (Test-Path -LiteralPath $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    $tmp = $cacheDll + '.' + $PID + '.tmp.dll'
    Add-Type -TypeDefinition $nativeSource -OutputAssembly $tmp -ErrorAction Stop
    try { Move-Item -LiteralPath $tmp -Destination $cacheDll -Force -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $cacheDll) {
      Add-Type -Path $cacheDll -ErrorAction Stop
      if (('DshAttentionDpiBoot' -as [type]) -and ('DshAttentionNative' -as [type])) { return 'compiled' }
    }
  } catch { }
  Add-Type -TypeDefinition $nativeSource
  return 'memory'
}

function Test-SameHwnd([IntPtr]$A, [IntPtr]$B) {
  if ($A -eq [IntPtr]::Zero -or $B -eq [IntPtr]::Zero) { return $false }
  return ($A.ToInt64() -eq $B.ToInt64())
}

function Activate-Hwnd([IntPtr]$Hwnd) {
  if ($Hwnd -eq [IntPtr]::Zero) { return $false }
  try {
    if ([DshAttentionNative]::IsIconic($Hwnd)) {
      [void][DshAttentionNative]::ShowWindowAsync($Hwnd, 9)
    }
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
      if ($attempt -gt 0) {
        # Release Alt before activation; attaching Chromium input queues can stall focus changes.
        try { [DshAttentionNative]::keybd_event(0x12, 0, 0, 0) }
        finally { [DshAttentionNative]::keybd_event(0x12, 0, 2, 0) }
      }
      [void][DshAttentionNative]::SetForegroundWindow($Hwnd)
      for ($poll = 0; $poll -lt 10; $poll++) {
        if (Test-SameHwnd ([DshAttentionNative]::GetForegroundWindow()) $Hwnd) { return $true }
        Start-Sleep -Milliseconds 20
      }
    }
    Write-ActLog ('activate-denied hwnd=' + $Hwnd.ToInt64())
  } catch { Write-ActLog ('activate-error=' + $_.Exception.Message) }
  return $false
}

function Get-DshNeedles($Data) {
  $needles = New-Object System.Collections.ArrayList
  foreach ($n in @($data.windowTitle, $data.appTitle)) {
    $text = ([string]$n).Trim()
    if ($text) { [void]$needles.Add($text) }
  }
  try {
    $focusFile = Join-Path $env:USERPROFILE '.dsh\dsh-attention-work\ui-focus.json'
    if (Test-Path -LiteralPath $focusFile) {
      $focus = [System.IO.File]::ReadAllText($focusFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $text = ([string]$focus.title).Trim()
      if ($text) { [void]$needles.Add($text) }
    }
  } catch {}
  try {
    $instanceUri = [Uri]([string]$data.webUrl)
    if ($instanceUri.Port -gt 0) {
      [void]$needles.Add($instanceUri.Authority)
      [void]$needles.Add(('localhost:' + $instanceUri.Port))
    }
  } catch {}
  foreach ($n in @('DeepSeek Harness', 'DeepSeek')) {
    [void]$needles.Add($n)
  }
  $unique = New-Object System.Collections.ArrayList
  foreach ($n in $needles) {
    $dup = $false
    foreach ($u in $unique) { if ($u -eq $n) { $dup = $true; break } }
    if (-not $dup) { [void]$unique.Add($n) }
  }
  $arr = @($unique | Sort-Object { ([string]$_).Length } -Descending)
  return $arr
}

function Test-BrowserProcess([string]$Name) {
  return ($Name -match '^(msedge|chrome|firefox|brave|opera|vivaldi|ApplicationFrameHost|msedgewebview2)$')
}

function Score-DshTitle([string]$Title, $Needles) {
  if (-not $Title) { return 0 }
  $score = 0
  foreach ($n in @($Needles)) {
    if (-not $n) { continue }
    if ($Title.Contains([string]$n)) { $score += 100 + ([string]$n).Length; break }
  }
  if ($Title -match 'DeepSeek\s*Harness') { $score += 80 }
  elseif ($Title -match 'DeepSeek|Harness|\bdsh\b') { $score += 25 }
  if ($score -eq 0) { return 0 }
  if ($Title -notmatch 'Microsoft Edge\s*$') { $score += 15 }
  return $score
}

function Find-DshHwnd($Data) {
  $needles = @(Get-DshNeedles $Data)
  $dump = ''
  try { $dump = [DshAttentionNative]::ListVisibleWindows() } catch {
    Write-ActLog ('enum-error=' + $_.Exception.Message)
  }
  $bestHwnd = [IntPtr]::Zero
  $bestScore = 0
  $bestTitle = ''
  $sawBrowser = 0
  if ($dump) {
    foreach ($line in $dump.Split([char]10)) {
      if (-not $line) { continue }
      $parts = $line.Split([char]9)
      if ($parts.Count -lt 3) { continue }
      $hwndNum = 0L
      $pidNum = 0
      if (-not [int64]::TryParse($parts[0], [ref]$hwndNum)) { continue }
      if (-not [int]::TryParse($parts[1], [ref]$pidNum)) { continue }
      $title = [string]$parts[2]
      if (-not $title) { continue }
      $procName = ''
      try { $procName = [string](Get-Process -Id $pidNum -ErrorAction Stop).ProcessName } catch { $procName = '' }
      $browser = Test-BrowserProcess $procName
      if ($browser) { $sawBrowser++ }
      $score = Score-DshTitle $title $needles
      if ($score -le 0) { continue }
      if (-not $browser) { continue }
      if ($browser) { $score += 10 }
      if ($score -gt $bestScore) {
        $bestScore = $score
        $bestHwnd = [IntPtr]$hwndNum
        $bestTitle = $title
      }
    }
  }
  if ($bestScore -gt 0 -and $bestHwnd -ne [IntPtr]::Zero) {
    Write-ActLog ('found score=' + $bestScore + ' title=' + $bestTitle)
    return $bestHwnd
  }
  Write-ActLog ('focus-miss no-title-match browsers=' + $sawBrowser + ' needles=' + $needles.Count)
  return [IntPtr]::Zero
}

function Focus-ExistingDsh($Data) {
  $hwnd = Find-DshHwnd $Data
  if ($hwnd -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 250
    $hwnd = Find-DshHwnd $Data
  }
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $ok = Activate-Hwnd $hwnd
  if ($ok) { Write-ActLog 'focus-ok verified' }
  else { Write-ActLog 'focus-fake SetForegroundWindow ignored' }
  return $ok
}

$nativeMode = Initialize-DshAttentionNative
