# Compact toast-like picker. ASCII-only for Windows PowerShell 5.1.
# UI is WPF glass (anti-aliased corners). Strings come from pending JSON.
param(
  [Parameter(Mandatory = $true)]
  [string]$Token
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:USERPROFILE '.dsh\dsh-attention-handler.log'
function Write-ActLog([string]$Line) {
  try {
    $dir = Split-Path $logFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Add-Content -LiteralPath $logFile -Value ("{0} choice-window {1}" -f (Get-Date -Format o), $Line) -Encoding UTF8
  } catch {}
}
trap {
  Write-ActLog ('trap=' + $_.Exception.Message)
  continue
}
Write-ActLog ('start token=' + $Token)

if (-not ('DshAttention.DpiBoot' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshAttentionDpiBoot {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
"@
}
try { [void][DshAttentionDpiBoot]::SetProcessDpiAwareness(2) } catch {}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Web.Extensions

if (-not ('DshAttention.Native' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshAttentionNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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
}

$work = Join-Path $env:USERPROFILE '.dsh\dsh-attention-work'
$pendingFile = Join-Path $work ('pending-' + $Token + '.json')
$inboxFile = Join-Path $work 'inbox.jsonl'

if (-not (Test-Path -LiteralPath $pendingFile)) {
  Write-ActLog 'missing-pending'
  exit 0
}

$raw = [System.IO.File]::ReadAllText($pendingFile, [System.Text.Encoding]::UTF8)
$data = $raw | ConvertFrom-Json
$labels = $data.labels
if (-not $labels) { $labels = [pscustomobject]@{} }
$kind = [string]$data.kind
$session = [string]$data.session

function LabelOf([string]$Name, [string]$Fallback) {
  $value = $null
  if ($labels) {
    try {
      $prop = $labels.PSObject.Properties[$Name]
      if ($prop) { $value = $prop.Value }
    } catch {}
  }
  if ($null -ne $value -and [string]$value -ne '') { return [string]$value }
  return $Fallback
}

function U {
  $sb = New-Object System.Text.StringBuilder
  foreach ($n in $args) { [void]$sb.Append([char][int]$n) }
  return $sb.ToString()
}

function ConvertTo-InboxJson($Obj) {
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = 2097152
  return $ser.Serialize($Obj)
}

function Write-Inbox($Obj) {
  if (-not (Test-Path $work)) { New-Item -ItemType Directory -Path $work | Out-Null }
  $json = ConvertTo-InboxJson $Obj
  Add-Content -LiteralPath $inboxFile -Value $json -Encoding UTF8
  Write-ActLog ('inbox a=' + $Obj['a'])
}

function Test-SameHwnd([IntPtr]$A, [IntPtr]$B) {
  if ($A -eq [IntPtr]::Zero -or $B -eq [IntPtr]::Zero) { return $false }
  return ($A.ToInt64() -eq $B.ToInt64())
}

function Activate-Hwnd([IntPtr]$Hwnd) {
  if ($Hwnd -eq [IntPtr]::Zero) { return $false }
  try {
    [void][DshAttentionNative]::AllowSetForegroundWindow(-1)
    if ([DshAttentionNative]::IsIconic($Hwnd)) {
      [void][DshAttentionNative]::ShowWindow($Hwnd, 9)
    } else {
      [void][DshAttentionNative]::ShowWindow($Hwnd, 5)
    }
    $fg = [DshAttentionNative]::GetForegroundWindow()
    $unused = [uint32]0
    $targetTid = [DshAttentionNative]::GetWindowThreadProcessId($Hwnd, [ref]$unused)
    $fgTid = [DshAttentionNative]::GetWindowThreadProcessId($fg, [ref]$unused)
    $curTid = [DshAttentionNative]::GetCurrentThreadId()
    if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
      [void][DshAttentionNative]::AttachThreadInput($curTid, $fgTid, $true)
    }
    if ($targetTid -ne 0 -and $targetTid -ne $curTid) {
      [void][DshAttentionNative]::AttachThreadInput($curTid, $targetTid, $true)
    }
    [DshAttentionNative]::keybd_event(0x12, 0, 0, 0)
    [void][DshAttentionNative]::BringWindowToTop($Hwnd)
    [void][DshAttentionNative]::SetForegroundWindow($Hwnd)
    [DshAttentionNative]::SwitchToThisWindow($Hwnd, $true)
    [DshAttentionNative]::keybd_event(0x12, 0, 2, 0)
    if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
      [void][DshAttentionNative]::AttachThreadInput($curTid, $fgTid, $false)
    }
    if ($targetTid -ne 0 -and $targetTid -ne $curTid) {
      [void][DshAttentionNative]::AttachThreadInput($curTid, $targetTid, $false)
    }
    Start-Sleep -Milliseconds 60
    $now = [DshAttentionNative]::GetForegroundWindow()
    $ok = Test-SameHwnd $now $Hwnd
    Write-ActLog ('activate hwnd=' + $Hwnd.ToInt64() + ' fg=' + $now.ToInt64() + ' ok=' + $ok)
    return $ok
  } catch {
    Write-ActLog ('activate-error=' + $_.Exception.Message)
    return $false
  }
}

function Get-DshNeedles {
  $needles = New-Object System.Collections.ArrayList
  foreach ($n in @($data.windowTitle, $data.appTitle)) {
    $text = ([string]$n).Trim()
    if ($text) { [void]$needles.Add($text) }
  }
  try {
    $focusFile = Join-Path $work 'ui-focus.json'
    if (Test-Path -LiteralPath $focusFile) {
      $focus = [System.IO.File]::ReadAllText($focusFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $text = ([string]$focus.title).Trim()
      if ($text) { [void]$needles.Add($text) }
    }
  } catch {}
  foreach ($n in @('DeepSeek Harness', 'DeepSeek', '127.0.0.1:3080', 'localhost:3080')) {
    [void]$needles.Add($n)
  }
  $unique = New-Object System.Collections.ArrayList
  foreach ($n in $needles) {
    $dup = $false
    foreach ($u in $unique) { if ($u -eq $n) { $dup = $true; break } }
    if (-not $dup) { [void]$unique.Add($n) }
  }
  $arr = @($unique | Sort-Object { ([string]$_).Length } -Descending)
  return , $arr
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
  if ($Title -match '127\.0\.0\.1:3080|localhost:3080') { $score += 40 }
  if ($Title -notmatch 'Microsoft Edge\s*$') { $score += 15 }
  return $score
}

function Find-DshHwnd {
  $needles = @(Get-DshNeedles)
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
      if (-not $browser -and $score -lt 80) { continue }
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

function Focus-ExistingDsh {
  $hwnd = Find-DshHwnd
  if ($hwnd -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 250
    $hwnd = Find-DshHwnd
  }
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $ok = Activate-Hwnd $hwnd
  if ($ok) { Write-ActLog 'focus-ok verified' }
  else { Write-ActLog 'focus-fake SetForegroundWindow ignored' }
  return $ok
}

function Resolve-Theme {
  $t = [string]$data.theme
  if ($t -eq 'dark' -or $t -eq 'light') { return $t }
  try {
    $focusFile = Join-Path $work 'ui-focus.json'
    if (Test-Path -LiteralPath $focusFile) {
      $focus = [System.IO.File]::ReadAllText($focusFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $ft = [string]$focus.theme
      if ($ft -eq 'dark' -or $ft -eq 'light') { return $ft }
    }
  } catch {}
  try {
    $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme
    if ([int]$v -eq 0) { return 'dark' }
  } catch {}
  return 'light'
}

function New-Brush([byte]$A, [byte]$R, [byte]$G, [byte]$B) {
  $c = [System.Windows.Media.Color]::FromArgb($A, $R, $G, $B)
  $br = New-Object System.Windows.Media.SolidColorBrush $c
  if ($br.CanFreeze) { $br.Freeze() }
  return $br
}

function Lerp-Byte([int]$A, [int]$B, [double]$T) {
  if ($T -lt 0) { $T = 0 }
  if ($T -gt 1) { $T = 1 }
  return [byte][Math]::Round($A + ($B - $A) * $T)
}

function Get-TimerBrush([double]$Ratio) {
  $g = @(16, 185, 129)
  $y = @(234, 179, 8)
  $r = @(239, 68, 68)
  if ($Ratio -ge 0.5) {
    $t = (1.0 - $Ratio) / 0.5
    return New-Brush 255 (Lerp-Byte $g[0] $y[0] $t) (Lerp-Byte $g[1] $y[1] $t) (Lerp-Byte $g[2] $y[2] $t)
  }
  $t = (0.5 - $Ratio) / 0.5
  return New-Brush 255 (Lerp-Byte $y[0] $r[0] $t) (Lerp-Byte $y[1] $r[1] $t) (Lerp-Byte $y[2] $r[2] $t)
}

$theme = Resolve-Theme
Write-ActLog ('theme=' + $theme)

$script:focusHwnd = [DshAttentionNative]::GetForegroundWindow()

$cardOpacity = 0.78
try {
  $op = [double]$data.cardOpacity
  if ($op -ge 0.1 -and $op -le 1) { $cardOpacity = $op }
} catch {}
$glassAlpha = [byte][Math]::Round(255 * $cardOpacity)

if ($theme -eq 'dark') {
  $brGlass = New-Brush $glassAlpha 22 28 32
  $brGlassLine = New-Brush 90 180 230 220
  $brChip = New-Brush 150 42 52 54
  $brChipOn = New-Brush 200 18 54 50
  $brFg = New-Brush 255 236 242 240
  $brMuted = New-Brush 255 156 174 170
  $brAccent = New-Brush 255 45 212 191
  $brAccentFg = New-Brush 255 8 32 28
  $brOpen = New-Brush 255 59 130 246
  $brOpenFg = New-Brush 255 255 255 255
  $brDeny = New-Brush 255 244 63 94
  $brDenyFg = New-Brush 255 255 255 255
  $brDanger = New-Brush 255 248 113 113
  $brInput = New-Brush 160 36 44 46
  $brInputLine = New-Brush 150 64 84 80
} else {
  $brGlass = New-Brush $glassAlpha 255 255 255
  $brGlassLine = New-Brush 110 255 255 255
  $brChip = New-Brush 160 236 242 240
  $brChipOn = New-Brush 210 204 241 236
  $brFg = New-Brush 255 28 36 34
  $brMuted = New-Brush 255 90 108 104
  $brAccent = New-Brush 255 15 118 110
  $brAccentFg = New-Brush 255 255 255 255
  $brOpen = New-Brush 255 37 99 235
  $brOpenFg = New-Brush 255 255 255 255
  $brDeny = New-Brush 255 244 63 94
  $brDenyFg = New-Brush 255 255 255 255
  $brDanger = New-Brush 255 220 38 38
  $brInput = New-Brush 170 245 248 247
  $brInputLine = New-Brush 170 176 196 190
}

$script:btnTpl = [Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
  <Border CornerRadius="10" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center" TextElement.Foreground="{TemplateBinding Foreground}"/>
  </Border>
</ControlTemplate>
'@)

$script:closeTpl = [Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
  <Border CornerRadius="10" Background="{TemplateBinding Background}" Width="32" Height="32">
    <Viewbox Width="12" Height="12" HorizontalAlignment="Center" VerticalAlignment="Center">
      <Path Stroke="{TemplateBinding Foreground}" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Data="M 2,2 L 14,14 M 14,2 L 2,14"/>
    </Viewbox>
  </Border>
</ControlTemplate>
'@)

function New-UiButton {
  param(
    [string]$Caption,
    $Bg,
    $Fg,
    [int]$Width = 0,
    [switch]$Left
  )
  $b = New-Object System.Windows.Controls.Button
  $b.Content = $Caption
  $b.Background = $Bg
  $b.Foreground = $Fg
  $b.BorderThickness = 0
  $b.Height = 32
  if ($Width -gt 0) { $b.Width = $Width }
  $b.Cursor = [System.Windows.Input.Cursors]::Hand
  $b.FontWeight = 'SemiBold'
  $b.FontSize = 13
  $b.FontFamily = 'Segoe UI'
  $b.Template = $script:btnTpl
  $b.Padding = New-Object System.Windows.Thickness 12, 0, 12, 0
  if ($Left) { $b.HorizontalContentAlignment = 'Left' }
  else { $b.HorizontalContentAlignment = 'Center' }
  return $b
}

function New-InputBox([string]$Placeholder) {
  $wrap = New-Object System.Windows.Controls.Border
  $wrap.CornerRadius = New-Object System.Windows.CornerRadius 10
  $wrap.Background = $brInput
  $wrap.BorderBrush = $brInputLine
  $wrap.BorderThickness = New-Object System.Windows.Thickness 1
  $wrap.Padding = New-Object System.Windows.Thickness 10, 7, 10, 7
  $wrap.Height = 34
  $grid = New-Object System.Windows.Controls.Grid
  $tb = New-Object System.Windows.Controls.TextBox
  $tb.Background = [System.Windows.Media.Brushes]::Transparent
  $tb.BorderThickness = 0
  $tb.Foreground = $brFg
  $tb.FontSize = 13
  $tb.FontFamily = 'Segoe UI'
  $tb.VerticalContentAlignment = 'Center'
  $tb.CaretBrush = $brFg
  $hint = New-Object System.Windows.Controls.TextBlock
  $hint.Text = $Placeholder
  $hint.Foreground = $brMuted
  $hint.IsHitTestVisible = $false
  $hint.VerticalAlignment = 'Center'
  $hint.FontSize = 13
  $tb.Add_TextChanged({
    param($s, $e)
    $h = $s.Tag
    if ($h) {
      if ([string]$s.Text) { $h.Visibility = 'Collapsed' }
      else { $h.Visibility = 'Visible' }
    }
  })
  $tb.Tag = $hint
  [void]$grid.Children.Add($hint)
  [void]$grid.Children.Add($tb)
  $wrap.Child = $grid
  return @{ Wrap = $wrap; Box = $tb }
}

$timeoutSec = 0
try { $timeoutSec = [int]$data.timeoutSec } catch { $timeoutSec = 0 }
$script:timeoutSec = $timeoutSec
$script:busy = $false
$script:picked = @{}
$script:questions = @()
$script:customBoxes = @{}
$script:idleBox = $null

$wa = [System.Windows.SystemParameters]::WorkArea
# DIP width: same physical size as ~380px on 1080p. Cap so 4K/150% does not balloon.
$cardDip = 380
$maxDip = [Math]::Max(320.0, $wa.Width * 0.16)
if ($cardDip -gt $maxDip) { $cardDip = $maxDip }
Write-ActLog ('cardDip=' + [int]$cardDip + ' wa=' + [int]$wa.Width + 'x' + [int]$wa.Height)

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.ShowInTaskbar = $false
$window.Topmost = $true
$window.ResizeMode = 'NoResize'
$window.Width = $cardDip + 36
$window.SizeToContent = 'Height'
$window.FontFamily = 'Segoe UI'
$script:window = $window

$outer = New-Object System.Windows.Controls.Grid
$outer.Margin = New-Object System.Windows.Thickness 18

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius 18
$card.Background = $brGlass
$card.BorderBrush = $brGlassLine
$card.BorderThickness = 1
$shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
$shadow.BlurRadius = 28
$shadow.ShadowDepth = 0
$shadow.Opacity = 0.32
$shadow.Color = [System.Windows.Media.Colors]::Black
$card.Effect = $shadow
$card.Add_MouseLeftButtonDown({
  try { $script:window.DragMove() } catch {}
})

$dock = New-Object System.Windows.Controls.DockPanel
$timerHost = New-Object System.Windows.Controls.Grid
$timerHost.Height = 6
$timerHost.Margin = New-Object System.Windows.Thickness 14, 0, 14, 10
$timerTrack = New-Object System.Windows.Shapes.Rectangle
$timerTrack.RadiusX = 3
$timerTrack.RadiusY = 3
$timerTrack.Fill = New-Brush 40 0 0 0
$timerFill = New-Object System.Windows.Shapes.Rectangle
$timerFill.RadiusX = 3
$timerFill.RadiusY = 3
$timerFill.HorizontalAlignment = 'Left'
$timerFill.Fill = Get-TimerBrush 1
[void]$timerHost.Children.Add($timerTrack)
[void]$timerHost.Children.Add($timerFill)
[System.Windows.Controls.DockPanel]::SetDock($timerHost, 'Bottom')
[void]$dock.Children.Add($timerHost)
$script:timerHost = $timerHost
$script:timerFill = $timerFill
if ($timeoutSec -le 0) { $timerHost.Visibility = 'Collapsed' }

$body = New-Object System.Windows.Controls.StackPanel
$body.Margin = New-Object System.Windows.Thickness 16, 14, 16, 8
[void]$dock.Children.Add($body)

$header = New-Object System.Windows.Controls.DockPanel
$header.LastChildFill = $true
$header.Margin = New-Object System.Windows.Thickness 0, 0, 0, 8
$close = New-Object System.Windows.Controls.Button
$close.Width = 32
$close.Height = 32
$close.Padding = New-Object System.Windows.Thickness 0
$close.BorderThickness = 0
$close.Background = New-Brush 36 0 0 0
$close.Foreground = $brMuted
$close.Cursor = [System.Windows.Input.Cursors]::Hand
$close.Template = $script:closeTpl
$close.VerticalAlignment = 'Center'
$close.ToolTip = LabelOf 'close' 'Close'
[System.Windows.Controls.DockPanel]::SetDock($close, 'Right')
$close.Add_Click({ $script:window.Close() })
[void]$header.Children.Add($close)

$kickerText = LabelOf 'kicker' 'dsh'
if ($session) { $kickerText = $kickerText + '  ' + $session }
$kicker = New-Object System.Windows.Controls.TextBlock
$kicker.Text = $kickerText
$kicker.Foreground = $brAccent
$kicker.FontSize = 12
$kicker.VerticalAlignment = 'Center'
$kicker.Cursor = [System.Windows.Input.Cursors]::Hand
$kicker.Add_MouseLeftButtonUp({ Open-ExistingSession })
[void]$header.Children.Add($kicker)
[void]$body.Children.Add($header)

$errTb = New-Object System.Windows.Controls.TextBlock
$errTb.Foreground = $brDanger
$errTb.FontSize = 12
$errTb.TextWrapping = 'Wrap'
$errTb.MinHeight = 8
$script:errTb = $errTb

function Close-Soon {
  $script:busy = $true
  $script:errTb.Foreground = $brMuted
  $script:errTb.Text = LabelOf 'done' 'OK'
  $t = New-Object System.Windows.Threading.DispatcherTimer
  $t.Interval = [TimeSpan]::FromMilliseconds(220)
  $t.Add_Tick({
    $this.Stop()
    try { $script:window.Close() } catch {}
  })
  $t.Start()
}

function Open-NewSessionUrl {
  $url = [string]$data.openUrl
  if (-not $url) { $url = [string]$data.webUrl }
  if (-not $url) { $url = 'http://127.0.0.1:3080' }
  Start-Process $url | Out-Null
  Write-ActLog ('open-new url=' + $url)
}

function Test-ReuseSession {
  $mode = [string]$data.openSessionMode
  if ($mode -eq 'new') { return $false }
  if ($data.reuseSession -eq $false) { return $false }
  return $true
}

function Open-ExistingSession {
  try {
    Write-Inbox @{ t = $Token; a = 'open' }
    $script:window.Topmost = $false
    if (-not (Test-ReuseSession)) {
      Open-NewSessionUrl
      $script:window.Hide()
      Close-Soon
      return
    }
    $ok = Focus-ExistingDsh
    if (-not $ok) {
      Write-ActLog 'open-no-window'
      $script:window.Topmost = $true
      $script:errTb.Text = LabelOf 'focusMiss' (U 0x627E 0x4E0D 0x5230 0x5DF2 0x6253 0x5F00 0x7684 0x20 0x64 0x73 0x68 0x20 0x7A97 0x53E3)
      return
    }
    $script:window.Hide()
    Close-Soon
  } catch {
    Write-ActLog ('open-click-error=' + $_.Exception.Message)
  }
}

function Add-Title([string]$Text) {
  if (-not $Text) { return }
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $Text
  $tb.TextWrapping = 'Wrap'
  $tb.Foreground = $brFg
  $tb.FontSize = 14
  $tb.FontWeight = 'SemiBold'
  $tb.Margin = New-Object System.Windows.Thickness 0, 0, 0, 10
  [void]$body.Children.Add($tb)
}

function Add-OpenAndPrimary($PrimaryBtn) {
  $row = New-Object System.Windows.Controls.DockPanel
  $row.LastChildFill = $false
  $row.Margin = New-Object System.Windows.Thickness 0, 8, 0, 4
  $open = New-UiButton -Caption (LabelOf 'openSession' (U 0x56DE 0x5230 0x4F1A 0x8BDD)) -Bg $brOpen -Fg $brOpenFg -Width 96
  $open.Add_Click({ Open-ExistingSession })
  [System.Windows.Controls.DockPanel]::SetDock($open, 'Left')
  [void]$row.Children.Add($open)
  if ($PrimaryBtn) {
    [System.Windows.Controls.DockPanel]::SetDock($PrimaryBtn, 'Right')
    [void]$row.Children.Add($PrimaryBtn)
  }
  [void]$body.Children.Add($row)
}

if ($kind -eq 'question') {
  $script:questions = @($data.questions)
  $title = [string]$script:questions[0].question
  if (-not $title) { $title = [string]$data.heading }
  Add-Title $title

  $optPanel = New-Object System.Windows.Controls.StackPanel
  foreach ($q in $script:questions) {
    $qid = [string]$q.id
    $script:picked[$qid] = New-Object System.Collections.ArrayList
    if ($script:questions.Count -gt 1 -and [string]$q.question -ne $title) {
      $qh = New-Object System.Windows.Controls.TextBlock
      $qh.Text = [string]$q.question
      $qh.Foreground = $brMuted
      $qh.FontSize = 12
      $qh.TextWrapping = 'Wrap'
      $qh.Margin = New-Object System.Windows.Thickness 0, 4, 0, 4
      [void]$optPanel.Children.Add($qh)
    }
    $multi = ($q.multiSelect -eq $true)
    foreach ($opt in @($q.options)) {
      $label = [string]$opt.label
      if (-not $label) { continue }
      $btn = New-UiButton -Caption $label -Bg $brChip -Fg $brFg -Left
      $btn.Height = 36
      $btn.Margin = New-Object System.Windows.Thickness 0, 0, 0, 8
      $btn.HorizontalAlignment = 'Stretch'
      $btn.Tag = @{ qid = $qid; label = $label; multi = $multi; on = $false }
      $btn.Add_Click({
        try {
          if ($script:busy) { return }
          $info = $this.Tag
          $qid = [string]$info.qid
          $label = [string]$info.label
          if ($info.multi) {
            if ($script:picked[$qid].Contains($label)) {
              [void]$script:picked[$qid].Remove($label)
              $this.Background = $brChip
              $this.Foreground = $brFg
            } else {
              [void]$script:picked[$qid].Add($label)
              $this.Background = $brChipOn
              $this.Foreground = $brFg
            }
            return
          }
          $script:busy = $true
          $this.Background = $brChipOn
          Write-Inbox @{
            t = $Token
            a = 'answer'
            answers = @(@{ id = $qid; selected = @($label) })
          }
          Close-Soon
        } catch {
          Write-ActLog ('click-error=' + $_.Exception.Message)
          $script:errTb.Text = [string]$_.Exception.Message
          $script:busy = $false
        }
      })
      [void]$optPanel.Children.Add($btn)
    }

    $ph = LabelOf 'customPlaceholder' (U 0x8F93 0x5165 0x4F60 0x7684 0x7B54 0x6848)
    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text = LabelOf 'customLabel' (U 0x5176 0x4ED6)
    $hint.Foreground = $brMuted
    $hint.FontSize = 12
    $hint.Margin = New-Object System.Windows.Thickness 0, 2, 0, 4
    [void]$optPanel.Children.Add($hint)
    $box = New-InputBox $ph
    [void]$optPanel.Children.Add($box.Wrap)
    $script:customBoxes[$qid] = $box.Box
  }

  $scroll = New-Object System.Windows.Controls.ScrollViewer
  $scroll.VerticalScrollBarVisibility = 'Auto'
  $scroll.HorizontalScrollBarVisibility = 'Disabled'
  $scroll.MaxHeight = 220
  $scroll.Content = $optPanel
  [void]$body.Children.Add($scroll)
  [void]$body.Children.Add($errTb)

  $send = New-UiButton -Caption (LabelOf 'submit' 'OK') -Bg $brAccent -Fg $brAccentFg -Width 72
  $send.Add_Click({
    try {
      if ($script:busy) { return }
      $answers = New-Object System.Collections.ArrayList
      foreach ($q in $script:questions) {
        $qid = [string]$q.id
        $selList = @($script:picked[$qid])
        $custom = ''
        $box = $script:customBoxes[$qid]
        if ($box) { $custom = ([string]$box.Text).Trim() }
        if ($selList.Count -eq 0 -and -not $custom) {
          $script:errTb.Text = LabelOf 'missing' 'pick'
          return
        }
        $item = @{ id = $qid; selected = $selList }
        if ($custom) {
          $item['custom'] = $custom
          if ($q.multiSelect -ne $true) { $item['selected'] = @() }
        }
        [void]$answers.Add($item)
      }
      $script:busy = $true
      Write-Inbox @{ t = $Token; a = 'answer'; answers = @($answers) }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $script:errTb.Text = [string]$_.Exception.Message
      $script:busy = $false
    }
  })
  Add-OpenAndPrimary $send
}
elseif ($kind -eq 'approval') {
  $title = [string]$data.sub
  if (-not $title) { $title = [string]$data.heading }
  Add-Title $title
    $row = New-Object System.Windows.Controls.Primitives.UniformGrid
  $row.Columns = 2
  $row.Margin = New-Object System.Windows.Thickness 0, 0, 0, 4
  $deny = New-UiButton -Caption (LabelOf 'reject' 'Reject') -Bg $brDeny -Fg $brDenyFg
  $deny.Margin = New-Object System.Windows.Thickness 0, 0, 6, 0
  $deny.Height = 36
  $deny.Tag = 'reject'
  $deny.Add_Click({
    try {
      if ($script:busy) { return }
      $script:busy = $true
      Write-Inbox @{ t = $Token; a = [string]$this.Tag }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $script:errTb.Text = [string]$_.Exception.Message
      $script:busy = $false
    }
  })
  $allow = New-UiButton -Caption (LabelOf 'allow' 'Allow') -Bg $brAccent -Fg $brAccentFg
  $allow.Margin = New-Object System.Windows.Thickness 6, 0, 0, 0
  $allow.Height = 36
  $allow.Tag = 'allow'
  $allow.Add_Click({
    try {
      if ($script:busy) { return }
      $script:busy = $true
      Write-Inbox @{ t = $Token; a = [string]$this.Tag }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $script:errTb.Text = [string]$_.Exception.Message
      $script:busy = $false
    }
  })
  [void]$row.Children.Add($deny)
  [void]$row.Children.Add($allow)
  [void]$body.Children.Add($row)
  [void]$body.Children.Add($errTb)
  Add-OpenAndPrimary $null
}
elseif ($kind -eq 'idle') {
  $title = [string]$data.heading
  Add-Title $title
  $ph = LabelOf 'placeholder' (U 0x4E0B 0x4E00 0x6B65)
  $box = New-InputBox $ph
  $script:idleBox = $box.Box
  [void]$body.Children.Add($box.Wrap)
  [void]$body.Children.Add($errTb)
  $send = New-UiButton -Caption (LabelOf 'send' 'Send') -Bg $brAccent -Fg $brAccentFg -Width 72
  $send.Add_Click({
    try {
      if ($script:busy) { return }
      $textValue = ([string]$script:idleBox.Text).Trim()
      if (-not $textValue) {
        $script:errTb.Text = LabelOf 'empty' 'empty'
        return
      }
      $script:busy = $true
      Write-Inbox @{ t = $Token; a = 'send'; text = $textValue }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $script:errTb.Text = [string]$_.Exception.Message
      $script:busy = $false
    }
  })
  Add-OpenAndPrimary $send
}
else {
  Write-ActLog ('unknown-kind=' + $kind)
  exit 0
}

$card.Child = $dock
$outer.Children.Add($card) | Out-Null
$window.Content = $outer

function Get-FocusedWorkArea {
  $fallback = [System.Windows.SystemParameters]::WorkArea
  try {
    $hwnd = $script:focusHwnd
    if ($hwnd -eq [IntPtr]::Zero) { return $fallback }
    $monitor = [DshAttentionNative]::MonitorFromWindow($hwnd, 2)
    if ($monitor -eq [IntPtr]::Zero) { return $fallback }
    $info = New-Object DshAttentionNative+MONITORINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [DshAttentionNative]::GetMonitorInfo($monitor, [ref]$info)) { return $fallback }
    $dpiX = [uint32]96
    $dpiY = [uint32]96
    $hr = [DshAttentionNative]::GetDpiForMonitor($monitor, 0, [ref]$dpiX, [ref]$dpiY)
    if ($hr -ne 0) { $dpiX = 96; $dpiY = 96 }
    $scaleX = 96.0 / [double]$dpiX
    $scaleY = 96.0 / [double]$dpiY
    $x = [double]$info.rcWork.Left * $scaleX
    $y = [double]$info.rcWork.Top * $scaleY
    $w = [double]($info.rcWork.Right - $info.rcWork.Left) * $scaleX
    $h = [double]($info.rcWork.Bottom - $info.rcWork.Top) * $scaleY
    return New-Object System.Windows.Rect($x, $y, $w, $h)
  } catch {
    return $fallback
  }
}

function Place-BottomRight {
  $wa = Get-FocusedWorkArea
  $w = $script:window.ActualWidth
  $h = $script:window.ActualHeight
  if ($w -le 0) { $w = $script:window.Width }
  if ($h -le 0) { $h = 240 }
  $script:window.Left = $wa.Right - $w - 10
  $script:window.Top = [Math]::Max($wa.Top + 16, $wa.Bottom - $h - 10)
}

$watch = New-Object System.Windows.Threading.DispatcherTimer
$watch.Interval = [TimeSpan]::FromMilliseconds(800)
$watch.Add_Tick({
  if (-not (Test-Path -LiteralPath $pendingFile)) { $script:window.Close() }
})
$watch.Start()

$life = New-Object System.Windows.Threading.DispatcherTimer
$life.Interval = [TimeSpan]::FromMilliseconds(80)
$script:startedAt = [System.Diagnostics.Stopwatch]::StartNew()
$life.Add_Tick({
  if ($script:timeoutSec -le 0) { return }
  $left = $script:timeoutSec - $script:startedAt.Elapsed.TotalSeconds
  if ($left -le 0) {
    $this.Stop()
    Write-ActLog 'timeout-close'
    try { $script:window.Close() } catch {}
    return
  }
  $ratio = $left / $script:timeoutSec
  if ($ratio -lt 0) { $ratio = 0 }
  $tw = $script:timerHost.ActualWidth
  if ($tw -gt 0) { $script:timerFill.Width = $tw * $ratio }
  $script:timerFill.Fill = Get-TimerBrush $ratio
})

$window.Add_ContentRendered({
  Place-BottomRight
  if ($script:timeoutSec -gt 0) { $life.Start() }
  if ($script:idleBox) { [void]$script:idleBox.Focus() }
  if ($data.playSound -ne $false) {
    try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
  }
})
$window.Add_SizeChanged({ Place-BottomRight })
$window.Add_Closed({
  $watch.Stop()
  $life.Stop()
})

Write-ActLog ('show kind=' + $kind + ' token=' + $Token + ' timeout=' + $timeoutSec)
[void]$window.ShowDialog()
