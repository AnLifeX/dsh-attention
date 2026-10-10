$ErrorActionPreference = 'Stop'
$scriptsDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts'))
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-pet-window-test-' + [Guid]::NewGuid())
[void](New-Item -ItemType Directory -Path $testDir)
$stateFile = Join-Path $testDir 'state.json'
$testState = @{ ownerPid = $PID; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pose = 'neutral'; theme = 'light'; bubblePids = @(); sessions = @() }
[IO.File]::WriteAllText($stateFile, ($testState | ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $testDir 'pet-position.json'), '{"monitor":"disconnected","x":0.25,"y":0.35}')
function Pump-Pet([int]$Milliseconds = 300) {
  $frame = New-Object Windows.Threading.DispatcherFrame
  $settle = New-Object Windows.Threading.DispatcherTimer
  $settle.Interval = [TimeSpan]::FromMilliseconds($Milliseconds)
  $settle.Add_Tick({ $settle.Stop(); $frame.Continue = $false })
  $settle.Start()
  [Windows.Threading.Dispatcher]::PushFrame($frame)
}
try {
  $code = [IO.File]::ReadAllText((Join-Path $scriptsDir 'pet-window.ps1'))
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$parseErrors)
  $tickNode = $ast.Find({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'Add_Tick' -and $node.Expression.VariablePath.UserPath -eq 'timer' }, $true)
  $tick = $tickNode.Arguments[0].ScriptBlock.GetScriptBlock()
  $code = $code.Replace('$PSScriptRoot', ("'" + $scriptsDir.Replace("'", "''") + "'"))
  $code = [regex]::Replace($code, '(?m)^  \$window.Show\(\)\r?\n  \[Windows.Threading.Dispatcher\]::Run\(\)', '')
  . ([scriptblock]::Create($code)) -StateFile $stateFile
  $timer.Stop()
  $animationTimer.Stop()
  # The test dot-sources initialization without running the window's message loop.
  $script:petGrabCursor = [Windows.Input.Cursor]::new((Join-Path (Split-Path $scriptsDir -Parent) 'assets/pet/grab.cur'), $true)
  $script:petGrabbingCursor = [Windows.Input.Cursor]::new((Join-Path (Split-Path $scriptsDir -Parent) 'assets/pet/grabbing.cur'), $true)
  $image.Cursor = $script:petGrabCursor
  if ($animations.Count -lt 10 -or $animations['look'].frames.Count -ne 16) { throw 'The v2 player must load nine standard rows and sixteen look directions' }
  foreach ($spec in @(@('idle',6), @('running-right',8), @('running-left',8), @('waving',4), @('jumping',5), @('failed',8), @('waiting',6), @('running',6), @('review',6))) {
    if ($animations[$spec[0]].frames.Count -ne $spec[1]) { throw ('Incorrect frame count: ' + $spec[0]) }
    foreach ($frame in $animations[$spec[0]].frames) {
      if ($frame.PixelWidth -ne 192 -or $frame.PixelHeight -ne 208 -or -not $frame.IsFrozen) { throw 'Animation cells must be pre-decoded immutable 192 x 208 bitmaps' }
    }
  }
  if ((Get-PetFrameIndex @(120,220) 119) -ne 0 -or (Get-PetFrameIndex @(120,220) 120) -ne 1 -or (Get-PetFrameIndex @(120,220) 339) -ne 1 -or (Get-PetFrameIndex @(120,220) 340) -ne 0) { throw 'Frame timing must respect each duration and loop boundaries' }
  for ($direction = 0; $direction -lt 16; $direction++) {
    $angle = $direction * [Math]::PI / 8
    if ((Get-PetLookDirection (100 * [Math]::Sin($angle)) (-100 * [Math]::Cos($angle)) 10) -ne $direction) { throw 'Look poses must follow clockwise up/right/down/left direction order' }
  }
  if ((Get-PetLookDirection 0 0 10) -ne -1 -or (Get-PetAnimationState 'question' $false 0) -ne 'waiting' -or (Get-PetAnimationState 'done' $false 0) -ne 'review' -or (Get-PetAnimationState 'failed' $false 0) -ne 'failed' -or (Get-PetAnimationState 'work' $true -1) -ne 'running-left' -or (Get-PetAnimationState 'neutral' $true 1) -ne 'running-right') { throw 'State priority and pointer deadzone must preserve intended animation semantics' }
  $script:petPose = 'work'
  $script:animationState = $null
  Update-PetAnimation 1000
  if ($image.Source -ne $animations['running'].frames[0]) { throw 'Starting a state must start at its first frame' }
  if (($animations['running'].durations -join ',') -ne '240,180,240,420,200,240') { throw 'Work must retain the approved rice-eating rhythm' }
  Update-PetAnimation 1241
  $expectedFrame = if ([Windows.SystemParameters]::ClientAreaAnimation) { 1 } else { 0 }
  if ($image.Source -ne $animations['running'].frames[$expectedFrame]) { throw 'Animation must advance without restarting on host polling; reduced motion must remain still' }
  Update-PetAnimation 2520
  if ($image.Source -ne $animations['running'].frames[0]) { throw 'The rice-eating cycle must loop after 1520ms' }
  $script:petMouseStart = [Windows.Point]::new(0,0)
  $script:animationState = $null
  Update-PetAnimation 2000
  Update-PetAnimation 5000
  $pressedFrame = if ([Windows.SystemParameters]::ClientAreaAnimation) { 3 } else { 0 }
  if ($animations['press'].frames.Count -ne 4 -or $animations['release'].frames.Count -ne 4 -or $image.Source -ne $animations['press'].frames[$pressedFrame]) { throw 'Holding the pet must hold the compressed press frame instead of looping' }
  $script:petDragging = $true
  $script:petDragX = -3
  Update-PetAnimation 5100
  if ($script:animationState -ne 'running-left') { throw 'Dragging must replace a press with directional movement' }
  $script:petDragging = $false
  $script:petMouseStart = $null
  $script:petGesture = 'release'
  $script:petGestureUntil = 5580
  Update-PetAnimation 5200
  if ($script:animationState -ne 'release') { throw 'Releasing the pet must play the return animation' }
  Update-PetAnimation 5581
  if ($script:animationState -ne 'running') { throw 'A completed gesture must return to the live task state' }
  $script:petGestureUntil = 0
  $script:petPose = 'neutral'
  $hoverTimer.Stop()
  $window.Show()
  Pump-Pet
  $screens = @(Get-PetScreens)
  $expected = Get-PetRestoredAnchor @{ monitor = 'disconnected'; x = 0.25; y = 0.35 } $screens $script:petAnchor.width $script:petAnchor.height
  if ([Math]::Abs($script:petAnchor.left - $expected.left) -gt 0.01 -or [Math]::Abs($script:petAnchor.top - $expected.top) -gt 0.01) { throw 'The first rendered frame must restore persisted position, with disconnected monitor fallback' }
  Save-PetPosition
  $saved = Read-PetState (Join-Path $testDir 'pet-position.json')
  if ([Math]::Abs($saved.x - 0.25) -gt 0.000001 -or [Math]::Abs($saved.y - 0.35) -gt 0.000001 -or $saved.monitor -ne $script:petAnchor.monitor) { throw ('Drag position must persist independently of the temporary heartbeat and anchor files: ' + ($saved | ConvertTo-Json -Compress) + ' anchor: ' + ($script:petAnchor | ConvertTo-Json -Compress)) }
  Save-PetPosition
  if (-not (Read-PetState $script:petPositionFile)) { throw 'Replacing an existing position file must preserve valid JSON' }
  $script:petAnchor.left = -99999
  $script:savedPetPosition = Read-PetState $script:petPositionFile
  Restore-PetPosition $screens
  if ([Math]::Abs($script:petAnchor.left - $expected.left) -gt 0.01) { throw 'Restart restoration must use the saved file, not the previous window position' }
  $script:petAnchor.left = -99999
  $script:petScreensJson = 'changed display layout'
  & $tick
  if ([Math]::Abs($script:petAnchor.left - $expected.left) -gt 0.01) { throw 'Display topology changes must restore the pet into a visible work area without restarting' }
  if ($image.Cursor -ne $script:petGrabCursor -or $replyBox.Cursor -ne [Windows.Input.Cursors]::IBeam) { throw 'Pet hover and quick reply must have distinct grab and text cursors' }
  $pressEvent = [Windows.Input.MouseButtonEventArgs]::new([Windows.Input.Mouse]::PrimaryDevice, 0, [Windows.Input.MouseButton]::Left)
  $pressEvent.RoutedEvent = [Windows.Input.Mouse]::MouseDownEvent
  $image.RaiseEvent($pressEvent)
  if ($image.Cursor -ne $script:petGrabbingCursor) { throw 'Picking up the pet must reveal the closed grabbing hand' }
  $image.ReleaseMouseCapture()
  if ($image.Cursor -ne $script:petGrabCursor) { throw 'Losing pointer capture must restore the open grabbing hand' }
  $pressEvent.Handled = $false
  $image.RaiseEvent($pressEvent)
  $script:petDragging = $true
  $script:petAnchor.left += 10
  $image.ReleaseMouseCapture()
  $saved = Read-PetState $script:petPositionFile
  $restored = Get-PetRestoredAnchor $saved $screens $script:petAnchor.width $script:petAnchor.height
  if ([Math]::Abs($restored.left - $script:petAnchor.left) -gt 0.01) { throw 'Ending a drag through capture loss must save before shutdown can terminate the helper' }
  if ($code.Contains('scalePopup') -or $code.Contains('Add_MouseRightButtonUp')) { throw 'Desktop right click must no longer open a scale slider' }
  $script:petLookPointer = $null
  $script:petLookUntil = 0
  $far = [Windows.Point]::new($script:petAnchor.left + 1000, $script:petAnchor.top)
  if ((Get-PetActiveLook $far 1000) -ne -1) { throw 'A stationary initial pointer must not replace the idle loop' }
  $far.X += 10
  if ((Get-PetActiveLook $far 1100) -lt 0 -or (Get-PetActiveLook $far 1900) -lt 0 -or (Get-PetActiveLook $far 2001) -ne -1) { throw 'Moving the pointer must temporarily follow it then restore idle after 900ms' }
  $script:petLookPointer = $null
  $script:petLookUntil = 0
  if (-not $window.IsVisible -or $badge.Visibility -ne 'Collapsed' -or $sessionBorder.Visibility -ne 'Collapsed') { throw 'Zero sessions should leave only the resident pet' }
  $script:petAnchor = @{ left = 500; top = 100; width = 188; height = 220; workArea = @{ left = 0; top = 0; right = 1200; bottom = 900 } }
  $state.sessions = @([pscustomobject]@{ sessionId = 'selected'; title = 'Selected session'; preview = 'Latest assistant update'; status = 'Running'; running = $true; canReply = $true })
  Update-PetSessionList
  Update-PetHover ([Windows.Point]::new(500, 100)) 1000
  if ($badge.Content -ne '1' -or $script:badgeMode -ne 'round') { throw 'Proximity must reveal the count' }
  Update-PetHover ([Windows.Point]::new(449, 100)) 1100
  if (-not $script:petHover) { throw 'Exit distance must be greater than entry distance' }
  Update-PetHover ([Windows.Point]::new(400, 100)) 1200
  Update-PetHover ([Windows.Point]::new(400, 100)) 1400
  if (-not $script:petHover) { throw 'Hover must have a dismiss delay' }
  Update-PetHover ([Windows.Point]::new(400, 100)) 1501
  if ($script:petHover) { throw 'Hover must eventually collapse' }
  $badge.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
  $window.UpdateLayout()
  if ($sessionBorder.Visibility -ne 'Visible' -or $sessionRows.Children.Count -ne 1) { throw 'The badge must expand the list' }
  if ([Windows.Window]::GetWindow($sessionBorder) -ne $window -or [Windows.Window]::GetWindow($petRoot) -ne $window) { throw 'Pet and list must share a native window' }
  if ([Windows.Controls.Canvas]::GetTop($sessionBorder) -ne 328) { throw 'Upper-half list must open below the pet' }
  $view = $script:sessionViews['selected']
  Set-PetMessageActions $view.card $false
  if ($view.close.Visibility -ne 'Hidden' -or $view.actions.Visibility -ne 'Hidden') { throw 'Message actions must be hidden without hover' }
  $idleHeight = $view.card.ActualHeight
  $idleWidth = $view.title.ActualWidth
  Set-PetMessageActions $view.card $true
  $window.UpdateLayout()
  if ($view.close.Visibility -ne 'Visible' -or $view.actions.Visibility -ne 'Visible' -or $view.card.ActualHeight -ne $idleHeight -or $view.title.ActualWidth -ne $idleWidth) { throw 'Hover must reveal all actions without shifting the bubble or title' }
  if ($view.close.Width -ne $view.close.Height -or $view.close.BorderThickness.Left -ne 1 -or $view.close.Margin.Top -ge -14) { throw 'Dismiss must be a circular outlined control across the upper-left bubble edge' }
  Set-PetMessageActions $view.card $false
  if ($view.card.CornerRadius.TopLeft -ne $view.card.ActualHeight / 2 -or -not $window.UseLayoutRounding) { throw 'Message cards must keep a continuous capsule arc with pixel-aligned layout' }
  $lightForeground = $view.reply.Foreground.Color.ToString()
  $state.theme = 'dark'
  Update-PetSessionList
  if ($view.reply.Foreground.Color.ToString() -eq $lightForeground) { throw 'Dark theme must update buttons and reply input together' }
  $state.theme = 'light'
  Update-PetSessionList
  if ($badge.Foreground.Color -ne [Windows.Media.Colors]::White -or $badge.Background.Color.A -lt 230) { throw 'Count badge must retain a high-contrast background and white number regardless of app theme' }
  if ($view.reply.Foreground.Color.ToString() -ne $lightForeground) { throw 'Light theme must restore the palette' }
  $view.reply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
  $window.UpdateLayout()
  if ($replyPanel.Visibility -ne 'Visible' -or $replyPanel.Parent -ne $view.body -or $replyBox.Parent -ne $replyPanel -or $replyPanel.Children.Count -ne 1 -or $replyBox.AcceptsReturn -or $replyBox.TextWrapping -ne 'NoWrap') { throw 'Quick reply must contain only a single-line input inside its message bubble' }
  if ($replyBox.Foreground.Color -ne $view.reply.Foreground.Color) { throw 'Attached reply input must use the bubble theme' }
  $inputBorder = $replyBox.Template.FindName('InputBorder', $replyBox)
  $placeholder = $replyBox.Template.FindName('Placeholder', $replyBox)
  if ($inputBorder.CornerRadius.TopLeft -ne 12 -or $placeholder.Visibility -ne 'Visible' -or $placeholder.IsHitTestVisible -or $replyBox.Text -ne '') { throw 'Empty quick reply must show a hint inside a rounded input without putting the hint in the draft' }
  $replyBox.Text = 'Unsent draft'
  if ($placeholder.Visibility -ne 'Collapsed') { throw 'Typing must hide the quick reply hint' }
  $window.UpdateLayout()
  $replyHost = $replyBox.Template.FindName('PART_ContentHost', $replyBox)
  if ($replyHost.ViewportHeight -lt $replyBox.FontSize -or $replyHost.ExtentHeight -gt $replyHost.ViewportHeight + 1) { throw ('Typed reply text must have a visible viewport tall enough for a whole line: viewport=' + $replyHost.ViewportHeight + ' extent=' + $replyHost.ExtentHeight + ' actual=' + $replyHost.ActualHeight + ' font=' + $replyBox.FontSize + ' padding=' + $replyHost.Padding) }
  if ($replyBox.CaretBrush.Color -ne $replyBox.Foreground.Color -or $replyBox.Foreground.Color.R -gt 80) { throw 'Light reply text and caret must remain dark on the white input' }
  $view.reply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
  if ($replyPanel.Visibility -ne 'Collapsed') { throw 'Clicking reply again must close its editor' }
  $view.reply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
  if ($replyPanel.Visibility -ne 'Visible' -or $replyBox.Text -ne 'Unsent draft') { throw 'Reopening reply must preserve its draft' }
  $state.sessions[0].preview = 'New tool activity'
  Update-PetSessionList
  if ($script:sessionViews['selected'].card -ne $view.card -or $view.status.Text -ne 'New tool activity' -or $replyBox.Text -ne 'Unsent draft') { throw 'Live updates must preserve card identity and reply drafts' }
  $other = [pscustomobject]@{ sessionId = 'other'; title = 'Another session'; preview = 'Waiting'; running = $false; canReply = $false; needsAnswer = $true }
  $state.sessions = @($other, $state.sessions[0])
  Update-PetSessionList
  if ($sessionRows.Children.Count -ne 2 -or $sessionRows.Children[1] -ne $view.card -or $script:sessionViews['other'].compose.Visibility -ne 'Visible') { throw 'Reordering and adding sessions must preserve existing cards and show pending actions' }
  if ($stackBacks.Visibility -ne 'Visible' -or $view.card.Visibility -ne 'Collapsed' -or $sessionRows.Children[0].Visibility -ne 'Visible') { throw 'Multiple messages must initially show one front card and stacked edges' }
  $window.UpdateLayout()
  $visibleBacks = @($stackBacks.Children | Where-Object { $_.Visibility -eq 'Visible' })
  if ($visibleBacks.Count -ne 1 -or $visibleBacks[0].Clip -isnot [Windows.Media.CombinedGeometry] -or $visibleBacks[0].Margin.Top -ne 18) { throw 'Two sessions must show one curved back edge, not two rectangular stripes' }
  $state.sessions += [pscustomobject]@{ sessionId = 'third'; title = 'Third session'; status = 'Completed'; running = $false }
  Update-PetSessionList
  if (@($stackBacks.Children | Where-Object { $_.Visibility -eq 'Visible' }).Count -ne 2) { throw 'Three sessions must expose exactly two rear cards' }
  $state.sessions = @($state.sessions | Where-Object { $_.sessionId -ne 'third' })
  Update-PetSessionList
  Open-PetMessage $script:sessionViews['other'].card
  if ($script:petStacked -or $stackBacks.Visibility -ne 'Collapsed' -or $view.card.Visibility -ne 'Visible') { throw 'Clicking a stack must expand all messages without navigating' }
  if ([Windows.SystemParameters]::ClientAreaAnimation) {
    $shift = $view.card.RenderTransform.Children[1]
    $deadline = $script:sessionMotionUntil
    if (-not $shift.HasAnimatedProperties) { throw 'Expanding a stack must move its rear card out from behind the front card' }
    Pump-Pet 90
    Update-PetSessionList
    if ($shift.Y -gt 0.1 -or $shift.Y -le -($sessionRows.Children[0].ActualHeight + 16) -or $script:sessionMotionUntil -ne $deadline) { throw 'Stack motion must stay within its start/end bounds without restarting on host updates' }
    Pump-Pet 300
    if ([Math]::Abs($shift.Y) -gt 0.1 -or [Math]::Abs($view.card.Opacity - 1) -gt 0.01) { throw 'Expanded cards must finish at their natural positions and full opacity' }
  }
  if ($view.completed.Visibility -ne 'Collapsed' -or $script:sessionViews['other'].completed.Visibility -ne 'Collapsed') { throw 'Running and waiting messages must not show completion marks' }
  $state.sessions[0].needsAnswer = $false
  Update-PetSessionList
  if ($script:sessionViews['other'].completed.Visibility -ne 'Visible') { throw 'Completed messages must show a green status mark before the title' }
  $state.sessions[0].needsAnswer = $true
  Toggle-PetReply 'other'
  if ($replyBox.Text -ne '' -or $replyPanel.Parent -ne $script:sessionViews['other'].body) { throw 'Switching reply must move the editor to the selected bubble without leaking drafts' }
  $replyBox.Text = 'Other draft'
  Toggle-PetReply 'selected'
  if ($replyBox.Text -ne 'Unsent draft' -or $replyPanel.Parent -ne $view.body) { throw 'Each message bubble must preserve its own reply draft' }
  $state.theme = 'dark'
  Update-PetSessionList
  if ($replyBox.Foreground.Color -ne $view.reply.Foreground.Color) { throw 'An open reply input must follow theme changes' }
  if ($replyBox.CaretBrush.Color -ne $replyBox.Foreground.Color -or $replyBox.Foreground.Color.R -lt 220) { throw 'Dark reply text and caret must remain light on the dark input' }
  $state.theme = 'light'
  Update-PetSessionList
  $state.sessions = @($state.sessions[1])
  Update-PetSessionList
  $script:replyCalls = @()
  $script:rejectReply = $false
  $originalReplyAction = ${function:Invoke-PetSessionAction}
  function Invoke-PetSessionAction([string]$SessionId, [string]$Action, [string]$Text) {
    if ($script:rejectReply) { throw 'Reply rejected' }
    $script:replyCalls += @{ sessionId = $SessionId; action = $Action; text = $Text }
  }
  function Press-ReplyKey($Key) {
    $event = [Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice, [Windows.PresentationSource]::FromVisual($window), 0, $Key)
    $event.RoutedEvent = [Windows.Input.Keyboard]::KeyDownEvent
    $replyBox.RaiseEvent($event)
  }
  $replyBox.Text = '   '
  Press-ReplyKey ([Windows.Input.Key]::Return)
  if ($script:replyCalls.Count -ne 0 -or $replyPanel.Visibility -ne 'Visible') { throw 'Blank Enter must not send or close the reply' }
  $replyBox.Text = 'Quick reply'
  Press-ReplyKey ([Windows.Input.Key]::ImeProcessed)
  if ($script:replyCalls.Count -ne 0) { throw 'IME composition keys must not send replies' }
  $script:rejectReply = $true
  Press-ReplyKey ([Windows.Input.Key]::Return)
  if ($replyBox.Text -ne 'Quick reply' -or $replyPanel.Visibility -ne 'Visible' -or $sessionError.Text -ne 'Reply rejected') { throw 'A failed Enter reply must retain the draft and show the failure' }
  $script:rejectReply = $false
  Press-ReplyKey ([Windows.Input.Key]::Return)
  if ($script:replyCalls.Count -ne 1 -or $script:replyCalls[0].sessionId -ne 'selected' -or $script:replyCalls[0].text -ne 'Quick reply' -or $replyBox.Text -ne '' -or $view.draft -ne '' -or $replyPanel.Visibility -ne 'Collapsed') { throw 'Enter must send to the selected session once, clear the draft and close the reply' }
  if ($placeholder.Visibility -ne 'Visible') { throw 'Clearing a sent reply must restore its hint' }
  if (@($view.actions.Children | Where-Object { $_.Tag.action -eq 'open' }).Count -ne 0) { throw 'Message bubbles must not keep a redundant open-session button' }
  $originalOpenHost = ${function:Open-PetHost}
  $script:openHostCalls = 0
  function Open-PetHost($State) { $script:openHostCalls++ }
  function Click-MessagePart($Part) {
    $event = [Windows.Input.MouseButtonEventArgs]::new([Windows.Input.Mouse]::PrimaryDevice, 0, [Windows.Input.MouseButton]::Left)
    $event.RoutedEvent = [Windows.Input.Mouse]::MouseUpEvent
    $Part.RaiseEvent($event)
  }
  Click-MessagePart $view.title
  if ($script:replyCalls.Count -ne 2 -or $script:replyCalls[1].action -ne 'open' -or $script:replyCalls[1].sessionId -ne 'selected' -or $script:openHostCalls -ne 1) { throw 'Clicking a message title must open the matching session and restore the host' }
  Toggle-PetReply 'selected'
  Click-MessagePart $replyBox
  Click-MessagePart $view.reply
  Click-MessagePart $view.stop
  Click-MessagePart $view.close
  if ($script:openHostCalls -ne 1) { throw 'Reply inputs and action buttons must not navigate when clicked' }
  $replyPanel.Visibility = 'Collapsed'
  ${function:Open-PetHost} = $originalOpenHost
  ${function:Invoke-PetSessionAction} = $originalReplyAction
  $replyPanel.Visibility = 'Collapsed'
  $script:petAnchor.top = 650
  Place-PetSessionList
  if ($script:sessionSide -ne 'above') { throw 'Lower-half list must open above the pet' }
  Pump-Pet 400
  $window.UpdateLayout()
  if ([Windows.Controls.Canvas]::GetTop($sessionBorder) + $sessionBorder.ActualHeight -gt $script:petAnchor.top) { throw 'The list must not overlap the pet' }
  $deadline = $script:sessionMotionUntil
  foreach ($offset in @(10,20,30)) {
    $script:petAnchor.top = 650 + $offset
    Place-PetSessionList
    $window.UpdateLayout()
    if ($script:sessionMotionUntil -ne $deadline -or [Math]::Abs([Windows.Controls.Canvas]::GetTop($petRoot) - $script:petAnchor.top) -gt 1) { throw 'Dragging within one side must follow without restarting animations' }
  }
  $before = $script:petAnchor.top
  $badge.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
  Pump-Pet 250
  Place-PetSessionList
  if ($sessionBorder.Visibility -ne 'Collapsed' -or $script:petAnchor.top -ne $before) { throw 'Collapsing must preserve pet position' }
  $script:petAnchor.top = 100
  Place-PetSessionList
  $script:petMouseStart = $petRoot.PointToScreen([Windows.Point]::new(30,30))
  $script:petWindowStart = [Windows.Point]::new($script:petAnchor.left, $script:petAnchor.top)
  Move-PetToPointer ([Windows.Point]::new($script:petMouseStart.X, $script:petMouseStart.Y + 10000))
  if ($script:petAnchor.top + $script:petAnchor.height -gt $script:petAnchor.workArea.bottom - 12) { throw 'Drag must clamp the pet and permanent control row before rendering' }
  Move-PetToPointer $script:petMouseStart
  $script:petMouseStart = $null
  $originalBottom = $script:petAnchor.top + $script:petAnchor.height
  $originalCenter = $script:petAnchor.left + $script:petAnchor.width / 2
  Set-PetScale 1.5
  if ($petRoot.Width -ne 264 -or $petRoot.Height -ne 296 -or $script:petAnchor.left + $script:petAnchor.width / 2 -ne $originalCenter -or $script:petAnchor.top + $script:petAnchor.height -ne $originalBottom) { throw 'Scaling must preserve the pet base and update immediately' }
  $state.sessions = @()
  Update-PetSessionList
  if ($sessionRows.Children.Count -ne 0 -or $badge.Visibility -ne 'Collapsed') { throw 'Removed sessions must clear their cards and badge' }
  if ($env:DSH_PET_RENDER_DIR) {
    $state.sessions = @([pscustomobject]@{ sessionId = 'render'; title = 'Desktop compatibility test'; preview = 'Checking plugin and message state'; status = 'Running'; running = $true; canReply = $true })
    $state.sessions += [pscustomobject]@{ sessionId = 'render-done'; title = 'Completed compatibility checks'; preview = 'All tests passed'; status = 'Completed'; running = $false; canReply = $true }
    $script:petExpanded = $false
    Update-PetSessionList
    $badge.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
    Pump-Pet 250
    Toggle-PetReply 'render'
    $replyBox.Text = ''
    $replyPanel.Visibility = 'Collapsed'
    Pump-Pet 250
    foreach ($stage in @('stacked','expanded','expanded-reply','expanded-reply-typed')) {
    $replyPanel.Visibility = if ($stage.StartsWith('expanded-reply')) { 'Visible' } else { 'Collapsed' }
    $replyBox.Text = if ($stage -eq 'expanded-reply-typed') { '你好 · Quick reply' } else { '' }
    $script:petStacked = $stage -eq 'stacked'
    Update-PetSessionList
    foreach ($theme in @('light','dark')) {
      $state.theme = $theme
      Update-PetSessionList
      $window.UpdateLayout()
      Set-PetMessageActions $script:sessionViews['render'].card $true
      if ($sessionBorder.Opacity -lt 0.99) { throw 'Reopening the list must restore its opacity after the collapse animation' }
      $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$window.Width, [int]$window.Height,96,96,[Windows.Media.PixelFormats]::Pbgra32)
      $bitmap.Render($surface)
      $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
      $contentTop = [int][Math]::Max(0,[Math]::Min([Windows.Controls.Canvas]::GetTop($petRoot), [Windows.Controls.Canvas]::GetTop($sessionBorder)) - 16)
      $contentBottom = [int][Math]::Min($window.Height, [Math]::Max([Windows.Controls.Canvas]::GetTop($petRoot) + $petRoot.Height, [Windows.Controls.Canvas]::GetTop($sessionBorder) + $sessionBorder.ActualHeight) + 16)
      $crop = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap,[Windows.Int32Rect]::new(0,$contentTop,[int]$window.Width,$contentBottom - $contentTop))
      $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($crop))
      $stream = [IO.File]::Create((Join-Path $env:DSH_PET_RENDER_DIR ($theme + '-' + $stage + '.png')))
      try { $encoder.Save($stream) } finally { $stream.Dispose() }
    }
  }
    }
  $testState.petScale = 1.25
  $testState.pose = 'work'
  $testState.updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [IO.File]::WriteAllText($stateFile, ($testState | ConvertTo-Json))
  & $tick
  if ($script:animationState -ne 'running' -or $image.Source.PixelWidth -ne 192 -or $image.Source.PixelHeight -ne 208) { throw 'Host work state must select the running animation in v2 cell geometry' }
  if ($script:petScale -ne 1.25 -or $petRoot.Width -ne 226) { throw 'Host config scale must update the pet without recreating its window' }
  $testState.updatedAt -= 11000
  [IO.File]::WriteAllText($stateFile, ($testState | ConvertTo-Json))
  & $tick
  if ($window.IsVisible -or $hoverTimer.IsEnabled -or $animationTimer.IsEnabled) { throw 'Expired host heartbeat must close the pet and stop all animation timers' }
  if (-not (Test-Path -LiteralPath $script:petPositionFile) -or (Test-Path -LiteralPath ($stateFile + '.anchor.json'))) { throw 'Shutdown must keep the saved position while removing its temporary anchor' }
  Write-Output 'Shared pet layout, theme switching, stable cards, hover, drag, scale and heartbeat passed'
} finally {
  if ($window) { $window.Close() }
  if ($script:petGrabCursor) { $script:petGrabCursor.Dispose() }
  if ($script:petGrabbingCursor) { $script:petGrabbingCursor.Dispose() }
  $resolved = [IO.Path]::GetFullPath($testDir)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped its temp directory' }
  Remove-Item -LiteralPath $resolved -Recurse
}
