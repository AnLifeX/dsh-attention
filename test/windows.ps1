$ErrorActionPreference = 'Stop'
$scriptsDir = Join-Path $PSScriptRoot '..\scripts'
$choiceAst = $null
foreach ($name in @('choice-window.ps1', 'protocol-handler.ps1', 'window-focus.ps1', 'pet-window.ps1', 'pet-layout.ps1', 'pet-sessions.ps1', 'pet-animation.ps1')) {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptsDir $name), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  if ($name -eq 'choice-window.ps1') { $choiceAst = $ast }
  if ($name -eq 'pet-window.ps1') { $petAst = $ast }
}
foreach ($name in @('Read-PetState', 'Test-PetStateAlive', 'Test-PetBubbleVisible', 'Get-PetScale', 'Open-PetHost', 'Test-PetDrag')) {
  $definition = $petAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression ($definition.Extent.Text.Replace('$PSScriptRoot', ("'" + $scriptsDir.Replace("'", "''") + "'")))
}
if ((Get-PetScale 'bad') -ne 1 -or (Get-PetScale $null) -ne 1 -or (Get-PetScale 0.1) -ne 0.5 -or (Get-PetScale 9) -ne 2 -or (Get-PetScale 1.25) -ne 1.25) {
  throw 'Invalid persisted pet scales must fall back or be clamped'
}
function Start-Process {
  param($FilePath, $WindowStyle, $ArgumentList)
  $script:petLaunch = @{ target = $FilePath; args = @($ArgumentList); windowStyle = $WindowStyle }
}
function Focus-ExistingDsh($Data) { $script:petFocus = $Data; return $true }
$env:ELECTRON_RUN_AS_NODE = '1'
Open-PetHost ([pscustomobject]@{ platform = 'desktop' })
if ($script:petLaunch.target -ne 'dsh://open' -or $env:ELECTRON_RUN_AS_NODE) { throw 'Pet click must restore Desktop without a session navigation request' }
Open-PetHost ([pscustomobject]@{ platform = 'web'; webUrl = 'http://127.0.0.1:19387' })
if ($script:petLaunch.target -ne 'dsh://open' -or $script:petFocus.webUrl -ne 'http://127.0.0.1:19387') {
  throw 'Web/PWA pet clicks must activate in the click process without launching a helper or navigating'
}
$petTestDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-pet-test-' + [Guid]::NewGuid())
[void](New-Item -ItemType Directory -Path $petTestDir)
try {
  $stateFile = Join-Path $petTestDir 'pet.json'
  [IO.File]::WriteAllText($stateFile, '{"ownerPid":123,"updatedAt":100000,"pose":"neutral","bubblePids":[456]}')
  $state = Read-PetState $stateFile
  if (-not (Test-PetStateAlive $state 100500)) { throw 'Healthy resident pet should stay alive' }
  if (Test-PetStateAlive $state 110000) { throw 'Resident pet should exit when host heartbeat expires' }
  if (Test-PetStateAlive $null 100500) { throw 'Missing owner state should not start a pet' }
  if (Test-PetBubbleVisible $state $petTestDir) { throw 'Pending notifications should not hide the pet before their window is ready' }
  $marker = Join-Path $petTestDir 'pending-pet-visible-456.json'
  [IO.File]::WriteAllText($marker, '{}')
  if (-not (Test-PetBubbleVisible $state $petTestDir)) { throw 'The notification pet should replace the resident pet while its bubble is shown' }
  Remove-Item -LiteralPath $marker
  if (Test-PetBubbleVisible $state $petTestDir) { throw 'Closing the bubble should restore the resident pet' }
  [IO.File]::WriteAllText($stateFile, '{')
  if ($null -ne (Read-PetState $stateFile)) { throw 'Partial host writes should be retried without crashing the resident window' }
  $closedNode = $choiceAst.Find({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'Add_Closed' -and $node.Expression.VariablePath.UserPath -eq 'window' }, $true)
  $pendingFile = Join-Path $petTestDir 'pending-closed-card.json'
  [IO.File]::WriteAllText($pendingFile, '{}')
  $watch = [pscustomobject]@{}
  $watch | Add-Member -MemberType ScriptMethod -Name Stop -Value {}
  $life = $watch
  $script:petBubble = $false
  & $closedNode.Arguments[0].ScriptBlock.GetScriptBlock()
  if (Test-Path -LiteralPath $pendingFile) { throw 'Closing or timing out a card must delete its pending file without a submitted action' }
  & $closedNode.Arguments[0].ScriptBlock.GetScriptBlock()
} finally {
  $resolved = [IO.Path]::GetFullPath($petTestDir)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped its temp directory' }
  Remove-Item -LiteralPath $resolved -Recurse
}

. (Join-Path $scriptsDir 'pet-layout.ps1')
$screens = @(
  @{ monitor = 'main'; primary = $true; workArea = @{ left = 0; top = 0; right = 1920; bottom = 1040 } },
  @{ monitor = 'left'; primary = $false; workArea = @{ left = -2560; top = -400; right = 0; bottom = 1000 } }
)
$restored = Get-PetRestoredAnchor @{ monitor = 'left'; x = 0.25; y = 0.75 } $screens 188 220
if ($restored.monitor -ne 'left' -or $restored.left -ne -1961 -or $restored.top -ne 479) { throw 'Restart must restore the selected monitor, including negative origins' }
$saved = Get-PetSavedPosition $restored
if ($saved.x -ne 0.25 -or $saved.y -ne 0.75 -or $saved.monitor -ne 'left') { throw 'Position serialization must preserve monitor and relative location' }
$screens[1].workArea = @{ left = 1920; top = 200; right = 3627; bottom = 1100 }
$restored = Get-PetRestoredAnchor $saved $screens 264 296
$roundtrip = Get-PetSavedPosition $restored
if ([Math]::Abs($roundtrip.x - 0.25) -gt 0.000001 -or $restored.left -lt 1920 -or $restored.top + 296 -gt 1100) { throw 'Resolution, DPI, pet size and screen arrangement changes must retain relative position within bounds' }
$fallback = Get-PetRestoredAnchor $saved @($screens[0]) 188 220
if ($fallback.monitor -ne 'main' -or $fallback.left -lt 12 -or $fallback.left + 188 -gt 1908) { throw 'Disconnected displays must fall back to a visible monitor' }
foreach ($invalid in @($null, @{ monitor = 'left'; x = 'broken'; y = 0 }, @{ x = [double]::NaN; y = 0 })) {
  $fallback = Get-PetRestoredAnchor $invalid @($screens[0]) 188 220
  if ($fallback.left -ne 1720 -or $fallback.top -ne 808) { throw 'Missing/corrupt position data must use a safe default' }
}
foreach ($origin in @(0, -1920, 2560)) {
  $anchor = @{ left = $origin + 1600; top = 800; width = 188; height = 188; workArea = @{ left = $origin; top = 0; right = $origin + 1920; bottom = 1080 } }
  $placement = Get-PetBubblePlacement $anchor 416 540
  if ($placement.side -ne 'left' -or $placement.left -lt $origin -or $placement.top + 540 -gt 1080) { throw 'Right-edge pet must open the bubble to its left inside the work area' }
  $anchor.left = $origin + 10
  $anchor.top = 10
  $placement = Get-PetBubblePlacement $anchor 416 540
  if ($placement.side -ne 'right' -or $placement.top -lt 0 -or $placement.left + 416 -gt $origin + 1920) { throw 'Left-edge pet must open the bubble to its right inside the work area' }
  $anchor.height = 216
  $anchor.top = 100
  $placement = Get-PetSessionPlacement $anchor 460 100
  if ($placement.side -ne 'below' -or $placement.top -ne 324) { throw 'Upper-half pets must expand below' }
  $anchor.top = 440
  $placement = Get-PetSessionPlacement $anchor 460 100
  if ($placement.side -ne 'above' -or $placement.top -ne 332) { throw 'Lower-half pets must expand above even when there is space below' }
  $anchor.top = 2000
  $anchor.left = $origin + 2000
  $placement = Get-PetResidentPlacement $anchor
  if ($placement.top + $anchor.height -ne 1068 -or $placement.left + $anchor.width -ne $origin + 1908) { throw 'Dragging must reserve the full pet and bottom badge row inside each monitor' }
}

# Run the real click handler with process/window operations replaced by local stubs.
foreach ($name in @('Test-ReuseSession', 'Open-ExistingSession', 'Get-PetPose')) {
  $definition = $choiceAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression $definition.Extent.Text
}
if ((Get-PetPose 'approval' $false) -ne 'question' -or
    (Get-PetPose 'question' $false) -ne 'question' -or
    (Get-PetPose 'idle' $false) -ne 'done' -or
    (Get-PetPose 'approval' $true) -ne 'done' -or
    (Get-PetPose 'unknown' $false) -ne 'neutral') {
  throw 'Incorrect pet pose for the notification state'
}
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
if (Test-PetDrag ([Windows.Point]::new(10,10)) ([Windows.Point]::new(11,11))) { throw 'A small pointer movement must remain a click' }
if (-not (Test-PetDrag ([Windows.Point]::new(10,10)) ([Windows.Point]::new(100,100)))) { throw 'Dragging must not trigger a host activation click' }
foreach ($asset in @('preview')) {
  $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit()
  $bitmap.CacheOption = 'OnLoad'
  $bitmap.UriSource = New-Object System.Uri (Join-Path (Split-Path $scriptsDir -Parent) ('assets\pet\' + $asset + '.png'))
  $bitmap.EndInit()
  $bitmap.Freeze()
  if ($bitmap.PixelWidth -le 0 -or $bitmap.PixelHeight -le 0) { throw ('Invalid pet image: ' + $asset) }
}
function Write-Inbox($value) { $script:action = $value['a'] }
function Start-Process($target) {
  if ($target -eq 'dsh://open' -and $env:ELECTRON_RUN_AS_NODE) { throw 'Desktop would launch in Node mode' }
  $script:opened = $target
}
function Open-NewSessionUrl { $script:opened = 'browser' }
function Focus-ExistingDsh { $script:opened = 'existing-web'; return $true }
function Close-Soon { $script:closed = $true }
function Write-ActLog($line) { throw $line }

foreach ($platform in @('desktop', 'web')) {
  foreach ($mode in @('new', 'reuse')) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $data = [pscustomobject]@{ platform = $platform; openSessionMode = $mode; reuseSession = ($mode -eq 'reuse') }
    $script:opened = ''
    $script:action = ''
    $script:closed = $false
    $script:hidden = $false
    $script:window = [pscustomobject]@{ Topmost = $true }
    $script:window | Add-Member -MemberType ScriptMethod -Name Hide -Value { $script:hidden = $true }
    $Token = 'test-token'
    Open-ExistingSession
    $expected = if ($platform -eq 'desktop') { 'dsh://open' } elseif ($mode -eq 'new') { 'browser' } else { 'existing-web' }
    if ($script:opened -ne $expected -or $script:action -ne 'open' -or -not $script:closed -or -not $script:hidden) {
      throw "Incorrect navigation for $platform / $mode"
    }
  }
}
Write-Output 'PowerShell parsing and Desktop/Web click routing passed'
