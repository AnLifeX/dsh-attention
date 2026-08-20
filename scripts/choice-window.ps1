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
using System.Runtime.InteropServices;
public static class DshAttentionNative {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
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
  $value = $labels.$Name
  if ($value) { return [string]$value }
  return $Fallback
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

function New-TextButton([string]$Caption) {
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
  $btn.Width = 52
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
$header.Controls.Add($kicker)
Enable-Drag $kicker

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

if ($kind -eq 'question') {
  $script:questions = @($data.questions)
  $body = [string]$script:questions[0].question
  if (-not $body) { $body = [string]$data.heading }
  Add-BodyLabel $body

  $needSubmit = $false
  foreach ($q in $script:questions) {
    if ($q.multiSelect -eq $true) { $needSubmit = $true }
    if ($script:questions.Count -gt 1) { $needSubmit = $true }
  }

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
  }

  $optArea = $oy
  if ($optArea -gt 168) {
    $optHost.AutoScroll = $true
    $optHost.Height = 168
    $optHost.Width = $innerW
  } else {
    $optHost.Height = $optArea
  }
  $y = $optHost.Top + $optHost.Height + 4

  if ($needSubmit) {
    $err.Location = New-Object System.Drawing.Point $pad, $y
    $form.Controls.Add($err)
    $y += 16
    $send = New-TextButton (LabelOf 'submit' 'OK')
    $send.Location = New-Object System.Drawing.Point ($cardW - $pad - 52), ($y)
    $send.Add_Click({
      try {
        if ($busyState.busy) { return }
        $answers = New-Object System.Collections.ArrayList
        foreach ($q in $script:questions) {
          $qid = [string]$q.id
          $selList = @($script:picked[$qid])
          if ($selList.Count -eq 0) {
            $err.Text = LabelOf 'missing' 'pick'
            return
          }
          [void]$answers.Add(@{ id = $qid; selected = $selList })
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
  $y += $optH + 8
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
}
else {
  Write-ActLog ('unknown-kind=' + $kind)
  exit 0
}

$form.Height = [Math]::Max(96, [Math]::Min(320, $y + 10))
Apply-Round
Place-BottomRight
$form.Add_Shown({
  Apply-Round
  Place-BottomRight
  if ($idleBox) { $idleBox.Focus() }
  try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
})

Write-ActLog ('show kind=' + $kind + ' token=' + $Token + ' h=' + $form.Height)
[void][System.Windows.Forms.Application]::Run($form)
