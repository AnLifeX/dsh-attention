# Resident pet. Notification windows keep the existing answer/approval handlers.
param([Parameter(Mandatory = $true)][string]$StateFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms

function Read-PetState([string]$Path) {
  try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) } catch { return $null }
}

function Test-PetStateAlive($State, [long]$Now) {
  return ($null -ne $State -and $State.ownerPid -gt 0 -and $State.updatedAt -gt 0 -and
    $Now - [long]$State.updatedAt -lt 10000)
}

function Test-PetBubbleVisible($State, [string]$Directory) {
  foreach ($bubblePid in @($State.bubblePids)) {
    if ([int]$bubblePid -gt 0 -and (Test-Path -LiteralPath (Join-Path $Directory ('pending-pet-visible-' + [int]$bubblePid + '.json')))) {
      return $true
    }
  }
  return $false
}

function Get-PetScale($Value) {
  $number = 1.0
  if (-not [double]::TryParse([string]$Value, [ref]$number) -or [double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 1.0 }
  return [Math]::Max(0.5, [Math]::Min(2.0, $number))
}

function Open-PetHost($State) {
  if ($State.platform -eq 'desktop') {
    $env:ELECTRON_RUN_AS_NODE = $null
    Start-Process 'dsh://open' | Out-Null
  } else {
    # Reuse the existing window without sending a session id or navigating its page.
    $shell = (Get-Process -Id $PID).Path
    Start-Process -FilePath $shell -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', ('"' + (Join-Path $PSScriptRoot 'protocol-handler.ps1') + '"'),
      '-FocusExisting', '-ReuseOnly', '-WebUrl', ('"' + [string]$State.webUrl + '"')
    ) | Out-Null
  }
}

function Test-PetDrag($Start, $Current) {
  return ([Math]::Abs($Current.X - $Start.X) -ge [Windows.SystemParameters]::MinimumHorizontalDragDistance -or
    [Math]::Abs($Current.Y - $Start.Y) -ge [Windows.SystemParameters]::MinimumVerticalDragDistance)
}

$state = Read-PetState $StateFile
if (-not (Test-PetStateAlive $state ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))) { exit 0 }
$ownerPid = [int]$state.ownerPid
$created = $false
$mutex = New-Object Threading.Mutex $true, ('Local\dsh-attention-' + (Split-Path $StateFile -Leaf)), ([ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }

try {
  . (Join-Path $PSScriptRoot 'pet-animation.ps1')
  $animations = Read-PetAnimations (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/pet')
  # WPF has no grab/grabbing cursors; use Chromium's original Windows resources.
  $script:petGrabCursor = [Windows.Input.Cursor]::new((Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/pet/grab.cur'), $true)
  $script:petGrabbingCursor = [Windows.Input.Cursor]::new((Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/pet/grabbing.cur'), $true)
  $script:petPose = 'neutral'
  $window = New-Object Windows.Window
  $window.UseLayoutRounding = $true
  $window.Title = 'dsh-attention pet'
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = [Windows.Media.Brushes]::Transparent
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.Topmost = $true
  $window.ResizeMode = 'NoResize'
  $window.Width = 188
  $window.Height = 188
  $wa = [Windows.SystemParameters]::WorkArea
  $script:petAnchor = @{
    left = $wa.Right - 200; top = $wa.Bottom - 228; width = 188; height = 216
    workArea = @{ left = $wa.Left; top = $wa.Top; right = $wa.Right; bottom = $wa.Bottom }
  }
  $image = New-Object Windows.Controls.Image
  $image.Margin = New-Object Windows.Thickness 18
  $image.Source = $animations['idle'].frames[0]
  $image.Stretch = 'Uniform'
  $image.Cursor = $script:petGrabCursor
  $image.Add_MouseLeftButtonDown({
    $script:petMouseStart = $window.PointToScreen($_.GetPosition($window))
    $script:petWindowStart = [Windows.Point]::new($script:petAnchor.left, $script:petAnchor.top)
    $script:petDragging = $false
    $script:petDragX = 0
    $image.Cursor = $script:petGrabbingCursor
    [void]$image.CaptureMouse()
    $_.Handled = $true
  })
  $image.Add_MouseMove({
    if ($null -eq $script:petMouseStart -or $_.LeftButton -ne 'Pressed') { return }
    $current = $window.PointToScreen($_.GetPosition($window))
    if ($script:petDragging -or (Test-PetDrag $script:petMouseStart $current)) {
      $script:petDragging = $true
      Move-PetToPointer $current
    }
    $_.Handled = $true
  })
  $image.Add_MouseLeftButtonUp({
    if ($script:petDragging) { Save-PetPosition }
    if ($null -ne $script:petMouseStart) {
      $script:petGesture = if ($script:petDragging) { 'jumping' } elseif ($animations.ContainsKey('release')) { 'release' } else { 'waving' }
      $script:petGestureUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $(if ($script:petDragging) { 840 } elseif ($script:petGesture -eq 'release') { 480 } else { 700 })
      $script:animationState = $null
    }
    if ($null -ne $script:petMouseStart -and -not $script:petDragging) {
      try { Open-PetHost $state } catch { [Diagnostics.Debug]::WriteLine($_.Exception.Message) }
    }
    $script:petMouseStart = $null
    $script:petDragging = $false
    $image.ReleaseMouseCapture()
    $image.Cursor = $script:petGrabCursor
    $_.Handled = $true
  })
  $image.Add_LostMouseCapture({
    if ($script:petDragging) { Save-PetPosition }
    $script:petMouseStart = $null; $script:petDragging = $false; $image.Cursor = $script:petGrabCursor
  })
  function Get-PetScreens {
    $source = [Windows.PresentationSource]::FromVisual($window)
    $fromDevice = if ($source) { $source.CompositionTarget.TransformFromDevice } else { [Windows.Media.Matrix]::Identity }
    foreach ($screen in [Windows.Forms.Screen]::AllScreens) {
      $start = $fromDevice.Transform([Windows.Point]::new($screen.WorkingArea.Left, $screen.WorkingArea.Top))
      $end = $fromDevice.Transform([Windows.Point]::new($screen.WorkingArea.Right, $screen.WorkingArea.Bottom))
      @{
        monitor = $screen.DeviceName; primary = $screen.Primary
        workArea = @{ left = $start.X; top = $start.Y; right = $end.X; bottom = $end.Y }
      }
    }
  }
  function Restore-PetPosition($Screens) {
    $script:petAnchor = Get-PetRestoredAnchor $script:savedPetPosition $Screens $script:petAnchor.width $script:petAnchor.height
    $script:petScreensJson = ConvertTo-Json -InputObject @($Screens) -Depth 4 -Compress
    Place-PetSessionList
  }
  function Save-PetPosition {
    # Separate from the heartbeat/anchor files, which the host deletes on shutdown.
    $script:savedPetPosition = Get-PetSavedPosition $script:petAnchor
    $temp = $script:petPositionFile + '.' + $PID + '.tmp'
    try {
      [IO.File]::WriteAllText($temp, ($script:savedPetPosition | ConvertTo-Json -Compress))
      if ([IO.File]::Exists($script:petPositionFile)) { [IO.File]::Replace($temp, $script:petPositionFile, [System.Management.Automation.Language.NullString]::Value) }
      else { [IO.File]::Move($temp, $script:petPositionFile) }
    } catch { [Diagnostics.Debug]::WriteLine($_.Exception.Message) }
    finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
  }
  function Move-PetToPointer($Current) {
    $source = [Windows.PresentationSource]::FromVisual($window)
    if (-not $source) { return }
    $fromDevice = $source.CompositionTarget.TransformFromDevice
    $delta = $fromDevice.Transform([Windows.Vector]::new($Current.X - $script:petMouseStart.X, $Current.Y - $script:petMouseStart.Y))
    $screen = [Windows.Forms.Screen]::FromPoint([Drawing.Point]::new([int]$Current.X, [int]$Current.Y))
    $waStart = $fromDevice.Transform([Windows.Point]::new($screen.WorkingArea.Left, $screen.WorkingArea.Top))
    $waEnd = $fromDevice.Transform([Windows.Point]::new($screen.WorkingArea.Right, $screen.WorkingArea.Bottom))
    $position = Get-PetResidentPlacement @{
      left = $script:petWindowStart.X + $delta.X; top = $script:petWindowStart.Y + $delta.Y
      width = $script:petAnchor.width; height = $script:petAnchor.height
      workArea = @{ left = $waStart.X; top = $waStart.Y; right = $waEnd.X; bottom = $waEnd.Y }
    }
    # Clamp before assigning either coordinate; native DragMove can paint outside the boundary.
    if ([Math]::Abs($position.left - $script:petAnchor.left) -gt 0.5) { $script:petDragX = $position.left - $script:petAnchor.left }
    $script:petAnchor.left = $position.left
    $script:petAnchor.top = $position.top
    $script:petAnchor.workArea = @{ left = $waStart.X; top = $waStart.Y; right = $waEnd.X; bottom = $waEnd.Y }
    $script:petAnchor.monitor = $screen.DeviceName
    Place-PetSessionList
  }
  $window.Content = $image

  $script:petScale = Get-PetScale $state.petScale
  function Set-PetScale([double]$Value) {
    $scale = Get-PetScale $Value
    $centerX = $script:petAnchor.left + $script:petAnchor.width / 2
    $bottom = $script:petAnchor.top + $script:petAnchor.height
    $script:petAnchor.width = 152 * $scale + 36
    $script:petAnchor.height = $script:petAnchor.width + 32
    $script:petAnchor.left = $centerX - $script:petAnchor.width / 2
    $script:petAnchor.top = $bottom - $script:petAnchor.height
    $position = Get-PetResidentPlacement $script:petAnchor
    $script:petAnchor.left = $position.left
    $script:petAnchor.top = $position.top
    $script:petScale = $scale

    Update-PetSessionList
  }
  $image.Add_MouseEnter({
    if (-not $script:petDragging -and $script:petPose -eq 'neutral') {
      $script:petGesture = 'waving'
      $script:petGestureUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 700
      $script:animationState = $null
    }
  })

  $animationTimer = New-Object Windows.Threading.DispatcherTimer
  $animationTimer.Interval = [TimeSpan]::FromMilliseconds(33)
  $animationTimer.Add_Tick({ Update-PetAnimation ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) })
  $timer = New-Object Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds(250)
  $timer.Add_Tick({
    $next = Read-PetState $StateFile
    if ($next) { $script:state = $next }
    if (-not (Test-PetStateAlive $state ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) -or
        [int]$state.ownerPid -ne $ownerPid -or -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
      $window.Close()
      return
    }
    $pose = [string]$state.pose
    foreach ($bubblePid in @($state.bubblePids)) {
      $bubble = Read-PetState (Join-Path (Split-Path $StateFile -Parent) ('pending-pet-visible-' + [int]$bubblePid + '.json'))
      if ($bubble.pose) { $pose = [string]$bubble.pose }
    }
    $script:petPose = $pose
    Update-PetAnimation ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if (-not $window.IsVisible) { $window.Show() }
    $screens = @(Get-PetScreens)
    if (-not $script:petDragging -and (ConvertTo-Json -InputObject $screens -Depth 4 -Compress) -ne $script:petScreensJson) {
      Restore-PetPosition $screens
    }
    Update-PetSessionList
    if ((Get-PetScale $state.petScale) -ne $script:petScale) { Set-PetScale (Get-PetScale $state.petScale) }
  })
  function Write-PetAnchor {
    # Only standalone approval/question cards need the external anchor file.
    $json = $script:petAnchor | ConvertTo-Json -Compress
    if ($json -eq $script:lastAnchorJson) { return }
    try {
      [IO.File]::WriteAllText(($StateFile + '.anchor.json'), $json)
      $script:lastAnchorJson = $json
    } catch {}
  }
  . (Join-Path $PSScriptRoot 'pet-sessions.ps1')
  $script:petPositionFile = Join-Path (Split-Path $StateFile -Parent) 'pet-position.json'
  $script:savedPetPosition = Read-PetState $script:petPositionFile
  Set-PetScale $script:petScale
  $window.Add_SourceInitialized({ Restore-PetPosition @(Get-PetScreens) })
  $window.Add_ContentRendered({
    Place-PetSessionList
  })
  $window.Add_Closed({
    $timer.Stop()
    $animationTimer.Stop()
    $hoverTimer.Stop()
    Remove-Item -LiteralPath ($StateFile + '.anchor.json') -ErrorAction SilentlyContinue
    [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
  })
  $animationTimer.Start()
  $timer.Start()
  $window.Show()
  [Windows.Threading.Dispatcher]::Run()
} finally {
  if ($timer) { $timer.Stop() }
  if ($animationTimer) { $animationTimer.Stop() }
  if ($script:petGrabCursor) { $script:petGrabCursor.Dispose() }
  if ($script:petGrabbingCursor) { $script:petGrabbingCursor.Dispose() }
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
