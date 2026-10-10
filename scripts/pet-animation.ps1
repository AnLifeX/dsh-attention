# Codex v2 cells and timing; decode once so pointer tracking never reads images from disk.
function Read-PetAnimations([string]$Directory) {
  $manifest = [IO.File]::ReadAllText((Join-Path $Directory 'pet.json')) | ConvertFrom-Json
  if ($manifest.spriteVersionNumber -ne 2 -or $manifest.spritesheetPath -ne 'spritesheet.png') { throw 'Unsupported pet spritesheet manifest' }
  $atlas = New-Object Windows.Media.Imaging.BitmapImage
  $atlas.BeginInit()
  $atlas.CacheOption = 'OnLoad'
  $atlas.UriSource = [Uri]::new((Join-Path $Directory $manifest.spritesheetPath))
  $atlas.EndInit()
  $atlas.Freeze()
  if ($atlas.PixelWidth -ne 1536 -or $atlas.PixelHeight -ne 2288) { throw 'Codex v2 spritesheet must be 1536 x 2288' }
  $states = @('idle','running-right','running-left','waving','jumping','failed','waiting','running','review')
  $durations = @(
    @(280,110,110,140,140,320), @(120,120,120,120,120,120,120,220), @(120,120,120,120,120,120,120,220),
    @(140,140,140,280), @(140,140,140,140,280), @(140,140,140,140,140,140,140,240),
    @(150,150,150,150,150,260), @(240,180,240,420,200,240), @(150,150,150,150,150,280)
  )
  $animations = @{}
  for ($row = 0; $row -lt 9; $row++) {
    $cells = @()
    for ($column = 0; $column -lt $durations[$row].Count; $column++) {
      $cell = [Windows.Media.Imaging.CroppedBitmap]::new($atlas, [Windows.Int32Rect]::new($column * 192, $row * 208, 192, 208))
      $cell.Freeze()
      $cells += $cell
    }
    $animations[$states[$row]] = @{ frames = $cells; durations = $durations[$row] }
  }
  $looks = @()
  for ($direction = 0; $direction -lt 16; $direction++) {
    $cell = [Windows.Media.Imaging.CroppedBitmap]::new($atlas, [Windows.Int32Rect]::new(($direction % 8) * 192, (9 + [Math]::Floor($direction / 8)) * 208, 192, 208))
    $cell.Freeze()
    $looks += $cell
  }
  $animations['look'] = @{ frames = $looks }
  $pressPath = Join-Path $Directory 'press.png'
  if (Test-Path -LiteralPath $pressPath) {
    $press = New-Object Windows.Media.Imaging.BitmapImage
    $press.BeginInit()
    $press.CacheOption = 'OnLoad'
    $press.UriSource = [Uri]::new($pressPath)
    $press.EndInit()
    $press.Freeze()
    if ($press.PixelWidth -ne 1536 -or $press.PixelHeight -ne 208) { throw 'Press animation must contain eight 192 x 208 cells' }
    $cells = @()
    for ($column = 0; $column -lt 8; $column++) {
      $cell = [Windows.Media.Imaging.CroppedBitmap]::new($press, [Windows.Int32Rect]::new($column * 192, 0, 192, 208))
      $cell.Freeze()
      $cells += $cell
    }
    $animations['press'] = @{ frames = $cells[0..3]; durations = @(80,80,100,100) }
    $animations['release'] = @{ frames = $cells[4..7]; durations = @(80,100,120,180) }
  }
  return $animations
}

function Get-PetFrameIndex($Durations, [long]$Elapsed) {
  $total = 0
  foreach ($duration in $Durations) { $total += $duration }
  $time = [Math]::Max([long]0, $Elapsed) % $total
  for ($i = 0; $i -lt $Durations.Count; $i++) {
    if ($time -lt $Durations[$i]) { return $i }
    $time -= $Durations[$i]
  }
  return 0
}

function Get-PetLookDirection([double]$X, [double]$Y, [double]$Deadzone) {
  if ([Math]::Sqrt($X * $X + $Y * $Y) -le $Deadzone) { return -1 }
  $angle = [Math]::Atan2($X, -$Y) * 180 / [Math]::PI
  return ([int][Math]::Floor((($angle + 360) % 360 + 11.25) / 22.5)) % 16
}

function Get-PetAnimationState([string]$Pose, [bool]$Dragging, [double]$DragX) {
  if ($Dragging) { return $(if ($DragX -lt 0) { 'running-left' } else { 'running-right' }) }
  switch ($Pose) {
    'work' { return 'running' }
    'question' { return 'waiting' }
    'done' { return 'review' }
    'failed' { return 'failed' }
    default { return 'idle' }
  }
}

function Get-PetActiveLook($Point, [long]$Now) {
  if ($null -ne $script:petLookPointer -and ($Point - $script:petLookPointer).Length -ge 2) {
    $script:petLookUntil = $Now + 900
  }
  $script:petLookPointer = $Point
  if ($script:petLookUntil -le $Now) { return -1 }
  return Get-PetLookDirection ($Point.X - $script:petAnchor.left - $script:petAnchor.width / 2) ($Point.Y - $script:petAnchor.top - ($script:petAnchor.height - 32) / 2) ($script:petAnchor.width * 0.65)
}

function Update-PetAnimation([long]$Now) {
  $name = Get-PetAnimationState $script:petPose ($script:petDragging -eq $true) $script:petDragX
  if (-not $script:petDragging -and $script:petGestureUntil -gt $Now) { $name = $script:petGesture }
  if (-not $script:petDragging -and $null -ne $script:petMouseStart -and $animations.ContainsKey('press')) { $name = 'press' }
  if ($script:animationState -ne $name) { $script:animationState = $name; $script:animationStarted = $Now }
  $index = 0
  if ([Windows.SystemParameters]::ClientAreaAnimation) {
    $elapsed = $Now - $script:animationStarted
    if ($name -eq 'press') { $elapsed = [Math]::Min([long]359, $elapsed) }
    $index = Get-PetFrameIndex $animations[$name].durations $elapsed
    if ($name -eq 'idle') {
      $source = [Windows.PresentationSource]::FromVisual($window)
      if ($source) {
        $pointer = [Windows.Forms.Cursor]::Position
        $point = $source.CompositionTarget.TransformFromDevice.Transform([Windows.Point]::new($pointer.X, $pointer.Y))
        $direction = Get-PetActiveLook $point $Now
        if ($direction -ge 0) { $name = 'look'; $index = $direction }
      }
    }
  }
  $frame = $animations[$name].frames[$index]
  if ($image.Source -ne $frame) { $image.Source = $frame }
}
