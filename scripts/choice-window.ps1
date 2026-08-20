# Compact toast-like picker. ASCII-only for Windows PowerShell 5.1.
# UI strings come from the pending JSON written by the Node plugin.
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

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not ('DshAttention.Native' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshAttentionNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageStr(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
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

# ASCII-only source: Chinese fallbacks via code points so PS 5.1 never depends on file encoding.
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
    [System.Windows.Forms.Application]::DoEvents()
    $hwnd = Find-DshHwnd
  }
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $ok = Activate-Hwnd $hwnd
  if ($ok) { Write-ActLog 'focus-ok verified' }
  else { Write-ActLog 'focus-fake SetForegroundWindow ignored' }
  return $ok
}

function Apply-Cue($Box, [string]$Text) {
  if (-not $Box -or -not $Text) { return }
  try {
    [void][DshAttentionNative]::SendMessageStr($Box.Handle, 0x1501, [IntPtr]1, $Text)
  } catch {}
}

function New-Color($R, $G, $B) {
  return [System.Drawing.Color]::FromArgb($R, $G, $B)
}

function Measure-TextHeight([string]$Text, $Font, [int]$Width, [int]$MinH, [int]$MaxH) {
  $flags = [System.Windows.Forms.TextFormatFlags]::WordBreak
  $size = [System.Windows.Forms.TextRenderer]::MeasureText(
    $Text,
    $Font,
    (New-Object System.Drawing.Size $Width, 400),
    $flags
  )
  $h = [int]$size.Height
  if ($h -lt $MinH) { $h = $MinH }
  if ($h -gt $MaxH) { $h = $MaxH }
  return $h
}

$bg = New-Color 43 43 43
$card = New-Color 56 56 56
$line = New-Color 78 78 78
$fg = New-Color 232 232 232
$muted = New-Color 156 156 156
$accent = New-Color 214 214 214
$sel = New-Color 70 70 70
$hover = New-Color 64 64 64

$fontUi = New-Object System.Drawing.Font('Segoe UI', 9)
$fontTitle = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 8)
$fontOpt = New-Object System.Drawing.Font('Segoe UI', 9)

$cardW = 332
$pad = 12
$optH = 30
$optGap = 5
$innerW = $cardW - ($pad * 2)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Width = $cardW
$form.BackColor = $bg
$form.ForeColor = $fg
$form.Font = $fontUi
$form.Padding = New-Object System.Windows.Forms.Padding 0
try {
  $prop = $form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
  if ($prop) { $prop.SetValue($form, $true, $null) }
} catch {}

$busyState = @{ busy = $false }
$err = New-Object System.Windows.Forms.Label
$err.AutoSize = $false
$err.ForeColor = New-Color 248 113 113
$err.Font = $fontSmall
$err.Height = 16
$err.Width = $innerW
$idleBox = $null
$script:picked = @{}
$script:questions = @()
$script:customBoxes = @{}

function Close-Soon {
  $busyState.busy = $true
  $err.ForeColor = $muted
  $err.Text = LabelOf 'done' 'OK'
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 220
  $timer.Add_Tick({
    $this.Stop()
    $form.Close()
  })
  $timer.Start()
}

function Enable-Drag($Control) {
  $Control.Add_MouseDown({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      [void][DshAttentionNative]::ReleaseCapture()
      [void][DshAttentionNative]::SendMessage($form.Handle, 0xA1, 0x2, 0)
    }
  })
}

function New-OptionButton([string]$Caption) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.UseVisualStyleBackColor = $false
  $btn.FlatStyle = 'Flat'
  $btn.FlatAppearance.BorderColor = $line
  $btn.FlatAppearance.BorderSize = 1
  $btn.FlatAppearance.MouseOverBackColor = $hover
  $btn.BackColor = $card
  $btn.ForeColor = $fg
  $btn.Font = $fontOpt
  $btn.Height = $optH
  $btn.Width = $innerW
  $btn.TextAlign = 'MiddleLeft'
  $btn.Padding = New-Object System.Windows.Forms.Padding 8, 0, 8, 0
  $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btn.Text = $Caption
  return $btn
}

function New-TextButton([string]$Caption, [int]$Width = 52) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.UseVisualStyleBackColor = $false
  $btn.FlatStyle = 'Flat'
  $btn.FlatAppearance.BorderSize = 0
  $btn.FlatAppearance.MouseOverBackColor = $hover
  $btn.BackColor = $bg
  $btn.ForeColor = $accent
  $btn.Font = $fontTitle
  $btn.Text = $Caption
  $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btn.Height = 26
  $btn.Width = $Width
  return $btn
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
    $form.TopMost = $false
    [System.Windows.Forms.Application]::DoEvents()
    if (-not (Test-ReuseSession)) {
      Open-NewSessionUrl
      $form.Hide()
      Close-Soon
      return
    }
    $ok = Focus-ExistingDsh
    if (-not $ok) {
      Write-ActLog 'open-no-window'
      $form.TopMost = $true
      $err.Text = LabelOf 'focusMiss' (U 0x627E 0x4E0D 0x5230 0x5DF2 0x6253 0x5F00 0x7684 0x20 0x64 0x73 0x68 0x20 0x7A97 0x53E3)
      if (-not $form.Controls.Contains($err)) { $form.Controls.Add($err) }
      return
    }
    $form.Hide()
    Close-Soon
  } catch {
    Write-ActLog ('open-click-error=' + $_.Exception.Message)
  }
}

function Add-OpenSessionButton([int]$X, [int]$Y) {
  $caption = LabelOf 'openSession' (U 0x56DE 0x5230 0x4F1A 0x8BDD)
  $btn = New-TextButton -Caption $caption -Width 88
  $btn.Location = New-Object System.Drawing.Point $X, $Y
  $btn.Add_Click({ Open-ExistingSession })
  $form.Controls.Add($btn)
  return $btn
}

function Apply-Round {
  try {
    $rgn = [DshAttentionNative]::CreateRoundRectRgn(0, 0, $form.Width, $form.Height, 16, 16)
    $form.Region = [System.Drawing.Region]::FromHrgn($rgn)
  } catch {}
}

function Place-BottomRight {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Left = $wa.Right - $form.Width - 18
  $form.Top = [Math]::Max($wa.Top + 16, $wa.Bottom - $form.Height - 18)
}

$y = 0
$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point 0, 0
$header.Size = New-Object System.Drawing.Size $cardW, 30
$header.BackColor = $bg
$form.Controls.Add($header)
Enable-Drag $header

$kickerText = LabelOf 'kicker' 'dsh'
if ($session) { $kickerText = $kickerText + '  ' + $session }
$kicker = New-Object System.Windows.Forms.Label
$kicker.AutoSize = $false
$kicker.Font = $fontSmall
$kicker.ForeColor = $muted
$kicker.Text = $kickerText
$kicker.Location = New-Object System.Drawing.Point $pad, 8
$kicker.Size = New-Object System.Drawing.Size ($innerW - 28), 16
$kicker.Cursor = [System.Windows.Forms.Cursors]::Hand
$header.Controls.Add($kicker)
$kicker.Add_Click({ Open-ExistingSession })

$close = New-Object System.Windows.Forms.Button
$close.UseVisualStyleBackColor = $false
$close.FlatStyle = 'Flat'
$close.FlatAppearance.BorderSize = 0
$close.FlatAppearance.MouseOverBackColor = $hover
$close.BackColor = $bg
$close.ForeColor = $muted
$close.Font = $fontSmall
$close.Text = LabelOf 'closeX' 'x'
$close.Size = New-Object System.Drawing.Size 26, 22
$close.Location = New-Object System.Drawing.Point ($cardW - 30), 4
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$close.Add_Click({ $form.Close() })
$header.Controls.Add($close)
$y = 30

function Add-BodyLabel([string]$Text) {
  if (-not $Text) { return }
  $lab = New-Object System.Windows.Forms.Label
  $lab.AutoSize = $false
  $lab.Font = $fontUi
  $lab.ForeColor = $fg
  $lab.Text = $Text
  $needed = Measure-TextHeight $Text $fontUi $innerW 18 54
  $lab.Size = New-Object System.Drawing.Size $innerW, $needed
  $lab.Location = New-Object System.Drawing.Point $pad, $script:y
  $form.Controls.Add($lab)
  Enable-Drag $lab
  $script:y += $needed + 8
}

$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 800
$watch.Add_Tick({
  if (-not (Test-Path -LiteralPath $pendingFile)) { $form.Close() }
})
$watch.Start()
$form.Add_FormClosed({ $watch.Stop() })

$timeoutSec = 0
try { $timeoutSec = [int]$data.timeoutSec } catch { $timeoutSec = 0 }
if ($timeoutSec -gt 0) {
  $life = New-Object System.Windows.Forms.Timer
  $life.Interval = [Math]::Min(86400000, $timeoutSec * 1000)
  $life.Add_Tick({
    $this.Stop()
    Write-ActLog 'timeout-close'
    $form.Close()
  })
  $life.Start()
  $form.Add_FormClosed({ $life.Stop() })
}

if ($kind -eq 'question') {
  $script:questions = @($data.questions)
  $body = [string]$script:questions[0].question
  if (-not $body) { $body = [string]$data.heading }
  Add-BodyLabel $body

  $needSubmit = $true

  $optHost = New-Object System.Windows.Forms.Panel
  $optHost.Location = New-Object System.Drawing.Point $pad, $y
  $optHost.Width = $innerW
  $optHost.BackColor = $bg
  $optHost.AutoScroll = $false
  $form.Controls.Add($optHost)

  $oy = 0
  foreach ($q in $script:questions) {
    $qid = [string]$q.id
    $script:picked[$qid] = New-Object System.Collections.ArrayList
    if ($script:questions.Count -gt 1 -and [string]$q.question -ne $body) {
      $qh = New-Object System.Windows.Forms.Label
      $qh.AutoSize = $false
      $qh.Font = $fontSmall
      $qh.ForeColor = $muted
      $qh.Text = [string]$q.question
      $qhH = Measure-TextHeight ([string]$q.question) $fontSmall $innerW 16 36
      $qh.Size = New-Object System.Drawing.Size $innerW, $qhH
      $qh.Location = New-Object System.Drawing.Point 0, $oy
      $optHost.Controls.Add($qh)
      $oy += $qhH + 4
    }
    $multi = ($q.multiSelect -eq $true)
    foreach ($opt in @($q.options)) {
      $label = [string]$opt.label
      if (-not $label) { continue }
      $caption = $label
      $btn = New-OptionButton $caption
      $btn.Width = $innerW
      $btn.Location = New-Object System.Drawing.Point 0, $oy
      $btn.Tag = @{ qid = $qid; label = $label; multi = $multi }
      $btn.Add_Click({
        try {
          if ($busyState.busy) { return }
          $info = $this.Tag
          $qid = [string]$info.qid
          $label = [string]$info.label
          if ($info.multi) {
            if ($script:picked[$qid].Contains($label)) {
              [void]$script:picked[$qid].Remove($label)
              $this.BackColor = $card
              $this.FlatAppearance.BorderColor = $line
            } else {
              [void]$script:picked[$qid].Add($label)
              $this.BackColor = $sel
              $this.FlatAppearance.BorderColor = $accent
            }
            return
          }
          $busyState.busy = $true
          $this.BackColor = $sel
          Write-Inbox @{
            t = $Token
            a = 'answer'
            answers = @(@{
              id = $qid
              selected = @($label)
            })
          }
          Close-Soon
        } catch {
          Write-ActLog ('click-error=' + $_.Exception.Message)
          $err.Text = [string]$_.Exception.Message
          $busyState.busy = $false
        }
      })
      $optHost.Controls.Add($btn)
      $oy += $optH + $optGap
    }

    $hint = New-Object System.Windows.Forms.Label
    $hint.AutoSize = $false
    $hint.Font = $fontSmall
    $hint.ForeColor = $muted
    $hint.Text = LabelOf 'customPlaceholder' (U 0x8F93 0x5165 0x4F60 0x7684 0x7B54 0x6848)
    $hint.Size = New-Object System.Drawing.Size $innerW, 16
    $hint.Location = New-Object System.Drawing.Point 0, $oy
    $optHost.Controls.Add($hint)
    $oy += 16

    $boxBg = New-Object System.Windows.Forms.Panel
    $boxBg.BackColor = $card
    $boxBg.Location = New-Object System.Drawing.Point 0, $oy
    $boxBg.Size = New-Object System.Drawing.Size $innerW, 28
    $optHost.Controls.Add($boxBg)

    $tb = New-Object System.Windows.Forms.TextBox
    $tb.BorderStyle = 'None'
    $tb.BackColor = $card
    $tb.ForeColor = $fg
    $tb.Font = $fontUi
    $tb.Width = $innerW - 16
    $tb.Height = 18
    $tb.Location = New-Object System.Drawing.Point 8, ($oy + 5)
    $tb.Tag = $qid
    $optHost.Controls.Add($tb)
    $tb.BringToFront()
    $script:customBoxes[$qid] = $tb
    $oy += 32
  }

  $optArea = $oy
  if ($optArea -gt 196) {
    $optHost.AutoScroll = $true
    $optHost.Height = 196
    $optHost.Width = $innerW
  } else {
    $optHost.Height = $optArea
  }
  $y = $optHost.Top + $optHost.Height + 4

  if ($needSubmit) {
    $err.Location = New-Object System.Drawing.Point $pad, $y
    $form.Controls.Add($err)
    $y += 16
    [void](Add-OpenSessionButton $pad $y)
    $send = New-TextButton (LabelOf 'submit' 'OK')
    $send.Location = New-Object System.Drawing.Point ($cardW - $pad - 52), ($y)
    $send.Add_Click({
      try {
        if ($busyState.busy) { return }
        $answers = New-Object System.Collections.ArrayList
        foreach ($q in $script:questions) {
          $qid = [string]$q.id
          $selList = @($script:picked[$qid])
          $custom = ''
          $box = $script:customBoxes[$qid]
          if ($box) { $custom = ([string]$box.Text).Trim() }
          if ($selList.Count -eq 0 -and -not $custom) {
            $err.Text = LabelOf 'missing' 'pick'
            return
          }
          $item = @{ id = $qid; selected = $selList }
          if ($custom) {
            $item['custom'] = $custom
            if ($q.multiSelect -ne $true) { $item['selected'] = @() }
          }
          [void]$answers.Add($item)
        }
        $busyState.busy = $true
        Write-Inbox @{ t = $Token; a = 'answer'; answers = @($answers) }
        Close-Soon
      } catch {
        Write-ActLog ('click-error=' + $_.Exception.Message)
        $err.Text = [string]$_.Exception.Message
        $busyState.busy = $false
      }
    })
    $form.Controls.Add($send)
    $y += 28
  }
}
elseif ($kind -eq 'approval') {
  $body = [string]$data.sub
  if (-not $body) { $body = [string]$data.heading }
  Add-BodyLabel $body

  $half = [int](($innerW - 6) / 2)
  $deny = New-OptionButton (LabelOf 'reject' 'Reject')
  $deny.Width = $half
  $deny.Location = New-Object System.Drawing.Point $pad, $y
  $deny.TextAlign = 'MiddleCenter'
  $deny.Tag = 'reject'
  $deny.Add_Click({
    try {
      if ($busyState.busy) { return }
      $busyState.busy = $true
      Write-Inbox @{ t = $Token; a = [string]$this.Tag }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $err.Text = [string]$_.Exception.Message
      $busyState.busy = $false
    }
  })
  $form.Controls.Add($deny)

  $allow = New-OptionButton (LabelOf 'allow' 'Allow')
  $allow.Width = $half
  $allow.Location = New-Object System.Drawing.Point ($pad + $half + 6), $y
  $allow.TextAlign = 'MiddleCenter'
  $allow.Tag = 'allow'
  $allow.Add_Click({
    try {
      if ($busyState.busy) { return }
      $busyState.busy = $true
      Write-Inbox @{ t = $Token; a = [string]$this.Tag }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $err.Text = [string]$_.Exception.Message
      $busyState.busy = $false
    }
  })
  $form.Controls.Add($allow)
  $y += $optH + 4
  [void](Add-OpenSessionButton $pad $y)
  $y += 28
}
elseif ($kind -eq 'idle') {
  $body = [string]$data.heading
  Add-BodyLabel $body

  $boxBg = New-Object System.Windows.Forms.Panel
  $boxBg.BackColor = $card
  $boxBg.Location = New-Object System.Drawing.Point $pad, $y
  $boxBg.Size = New-Object System.Drawing.Size ($innerW - 56), 28
  $form.Controls.Add($boxBg)

  $idleBox = New-Object System.Windows.Forms.TextBox
  $idleBox.BorderStyle = 'None'
  $idleBox.BackColor = $card
  $idleBox.ForeColor = $fg
  $idleBox.Font = $fontUi
  $idleBox.Width = $innerW - 68
  $idleBox.Height = 18
  $idleBox.Location = New-Object System.Drawing.Point ($pad + 8), ($y + 6)
  $form.Controls.Add($idleBox)
  $idleBox.BringToFront()

  $send = New-TextButton (LabelOf 'send' 'Send')
  $send.Location = New-Object System.Drawing.Point ($pad + $innerW - 52), ($y + 1)
  $send.Add_Click({
    try {
      if ($busyState.busy) { return }
      $textValue = $idleBox.Text.Trim()
      if (-not $textValue) {
        $err.Text = LabelOf 'empty' 'empty'
        $err.Location = New-Object System.Drawing.Point $pad, ($idleBox.Top + 28)
        if (-not $form.Controls.Contains($err)) { $form.Controls.Add($err) }
        return
      }
      $busyState.busy = $true
      Write-Inbox @{ t = $Token; a = 'send'; text = $textValue }
      Close-Soon
    } catch {
      Write-ActLog ('click-error=' + $_.Exception.Message)
      $err.Text = [string]$_.Exception.Message
      $busyState.busy = $false
    }
  })
  $form.Controls.Add($send)
  $y += 36
  [void](Add-OpenSessionButton $pad $y)
  $y += 28
}
else {
  Write-ActLog ('unknown-kind=' + $kind)
  exit 0
}

$form.Height = [Math]::Max(96, [Math]::Min(380, $y + 10))
Apply-Round
Place-BottomRight
$form.Add_Shown({
  Apply-Round
  Place-BottomRight
  $cue = LabelOf 'customPlaceholder' (U 0x8F93 0x5165 0x4F60 0x7684 0x7B54 0x6848)
  foreach ($qid in @($script:customBoxes.Keys)) {
    Apply-Cue $script:customBoxes[$qid] $cue
  }
  if ($idleBox) { $idleBox.Focus() }
  if ($data.playSound -ne $false) {
    try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
  }
})

Write-ActLog ('show kind=' + $kind + ' token=' + $Token + ' h=' + $form.Height)
[void][System.Windows.Forms.Application]::Run($form)
