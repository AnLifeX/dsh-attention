# Sourced by the resident window: status control and persistent session drawer.
. (Join-Path $PSScriptRoot 'pet-layout.ps1')
$script:petActionTemplate = [Windows.Markup.XamlReader]::Parse('<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button"><Border CornerRadius="12" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter Property="Opacity" Value="0.8"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.35"/></Trigger></ControlTemplate.Triggers></ControlTemplate>')
function Set-PetButtonStyle($Button) {
  $Button.Template = $script:petActionTemplate
  $Button.SetResourceReference([Windows.Controls.Control]::BackgroundProperty, 'PetControl')
  $Button.SetResourceReference([Windows.Controls.Control]::ForegroundProperty, 'PetForeground')
  $Button.BorderThickness = 0
  $Button.Padding = [Windows.Thickness]::new(10, 6, 10, 6)
  $Button.Cursor = [Windows.Input.Cursors]::Hand
}
function Invoke-PetSessionAction([string]$SessionId, [string]$Action, [string]$Text = '') {
  $body = @{ sessionId = $SessionId; action = $Action; text = $Text } | ConvertTo-Json -Compress
  $uri = [Uri]([string]$state.webUrl)
  if (-not $uri.IsLoopback -or $uri.Scheme -ne 'http') { throw 'Invalid local host address' }
  $result = Invoke-RestMethod -Uri ($uri.AbsoluteUri.TrimEnd('/') + '/dsh-attention/pet-act') -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 12
  if (-not $result.ok) { throw $result.error }
}

function Update-PetBadge {
  $count = @($state.sessions).Count
  if ($count -eq 0) {
    $script:petExpanded = $false
    $script:petClosingUntil = 0
    $sessionBorder.Visibility = 'Collapsed'
    $badge.Visibility = 'Collapsed'
    return
  }
  $badge.Visibility = 'Visible'
  $badge.Content = if ($script:petExpanded) { if ($script:sessionSide -eq 'above') { [string][char]0x2304 } else { [string][char]0x2303 } } elseif ($script:petHover) { [string]$count } else { '' }
  $mode = if ($script:petExpanded -or $script:petHover) { 'round' } else { 'bar' }
  if ($mode -ne $script:badgeMode) {
    $script:badgeMode = $mode
    $motion = New-Object Windows.Media.Animation.DoubleAnimation
    $motion.To = if ($mode -eq 'round') { 24 } else { 6 }
    $motion.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds(180))
    $ease = New-Object Windows.Media.Animation.CubicEase
    $ease.EasingMode = 'EaseOut'
    $motion.EasingFunction = $ease
    if (-not [Windows.SystemParameters]::ClientAreaAnimation) { $motion.Duration = [Windows.Duration]::new([TimeSpan]::Zero) }
    $badge.BeginAnimation([Windows.FrameworkElement]::HeightProperty, $motion)
    $widthMotion = $motion.Clone()
    $widthMotion.To = if ($mode -eq 'round') { 24 } else { 17 }
    $badge.BeginAnimation([Windows.FrameworkElement]::WidthProperty, $widthMotion)
  }
}

function Place-PetSessionList {
  if ($script:placingSessions -or -not $surface) { return }
  $script:placingSessions = $true
  try {
    $anchor = $script:petAnchor
    $work = $anchor.workArea
    $petRoot.Width = $anchor.width
    $petRoot.Height = $anchor.height
    $window.Width = [Math]::Min([Math]::Max(476, $anchor.width + 16), $work.right - $work.left)
    $window.Height = $work.bottom - $work.top
    $window.Left = [Math]::Max($work.left, [Math]::Min($anchor.left + $anchor.width / 2 - $window.Width / 2, $work.right - $window.Width))
    $window.Top = $work.top
    [Windows.Controls.Canvas]::SetLeft($petRoot, $anchor.left - $window.Left)
    [Windows.Controls.Canvas]::SetTop($petRoot, $anchor.top - $window.Top)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $sessionBorder.Visibility = if (($script:petExpanded -or $script:petClosingUntil -gt $now) -and @($state.sessions).Count -gt 0) { 'Visible' } else { 'Collapsed' }
    if ($sessionBorder.Visibility -eq 'Visible') {
      $sessionBorder.Width = [Math]::Min(460, $window.Width - 16)
      $preferred = Get-PetSessionPlacement $anchor $sessionBorder.Width 0
      $available = if ($preferred.side -eq 'above') { $anchor.top - $work.top - 16 } else { $work.bottom - $anchor.top - $anchor.height - 16 }
      $sessionScroll.MaxHeight = [Math]::Max(24, [Math]::Min(300, $available - 20))
      $sessionBorder.Measure([Windows.Size]::new($sessionBorder.Width, [Math]::Max(60, $available)))
      $height = $sessionBorder.DesiredSize.Height
      $position = Get-PetSessionPlacement $anchor $sessionBorder.Width $height
      $oldSide = $script:sessionSide
      $script:sessionSide = $position.side
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($oldSide -and $oldSide -ne $position.side) { $script:sessionMotionUntil = $now + 220 }
      [Windows.Controls.Canvas]::SetLeft($sessionBorder, $position.left - $window.Left)
      $target = $position.top - $window.Top
      $current = [Windows.Controls.Canvas]::GetTop($sessionBorder)
      [Windows.Controls.Canvas]::SetTop($sessionBorder, $target)
      if ($script:sessionMotionUntil -gt $now -and [Windows.SystemParameters]::ClientAreaAnimation -and -not [double]::IsNaN($current)) {
        $motion = [Windows.Media.Animation.DoubleAnimation]::new($current, $target, [Windows.Duration]::new([TimeSpan]::FromMilliseconds($script:sessionMotionUntil - $now)))
        $ease = New-Object Windows.Media.Animation.CubicEase
        $ease.EasingMode = 'EaseOut'
        $motion.EasingFunction = $ease
        $motion.FillBehavior = 'Stop'
        $sessionBorder.BeginAnimation([Windows.Controls.Canvas]::TopProperty, $motion)
      } else { $sessionBorder.BeginAnimation([Windows.Controls.Canvas]::TopProperty, $null) }
    }
    Write-PetAnchor
    Update-PetBadge
  } finally { $script:placingSessions = $false }
}

function Update-PetTheme {
  $theme = if ($state.theme -eq 'dark') { 'dark' } else { 'light' }
  if ($script:petTheme -eq $theme) { return }
  $script:petTheme = $theme
  $palette = if ($theme -eq 'dark') {
    @{ PetForeground = '#F5F5F7'; PetSecondary = '#B3B8C2'; PetControl = '#407E8593'; PetEdge = '#55FFFFFF'; PetInput = '#C0202329'; PetError = '#FFAD9C'; PetGlassTop = '#E83B3E46'; PetGlassBottom = '#D122252B' }
  } else {
    @{ PetForeground = '#20232A'; PetSecondary = '#626873'; PetControl = '#24707888'; PetEdge = '#BBFFFFFF'; PetInput = '#DFFFFFFF'; PetError = '#B52F25'; PetGlassTop = '#F5FFFFFF'; PetGlassBottom = '#DDDFE5ED' }
  }
  foreach ($key in $palette.Keys) {
    $brush = [Windows.Media.BrushConverter]::new().ConvertFromString($palette[$key])
    $window.Resources[$key] = $brush.psobject.BaseObject
  }
  $glass = New-Object Windows.Media.LinearGradientBrush
  # ponytail: Translucent gradient fallback; native desktop blur needs a Windows composition bridge.
  $glass.StartPoint = [Windows.Point]::new(0,0)
  $glass.EndPoint = [Windows.Point]::new(0,1)
  $glass.GradientStops.Add([Windows.Media.GradientStop]::new($window.Resources['PetGlassTop'].Color, 0))
  $glass.GradientStops.Add([Windows.Media.GradientStop]::new($window.Resources['PetGlassBottom'].Color, 1))
  $window.Resources['PetGlass'] = $glass.psobject.BaseObject
}

function Update-PetHover($Point, [long]$Now) {
  $a = $script:petAnchor
  $dx = [Math]::Max(0, [Math]::Max($a.left - $Point.X, $Point.X - $a.left - $a.width))
  $dy = [Math]::Max(0, [Math]::Max($a.top - $Point.Y, $Point.Y - $a.top - $a.height))
  $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
  if ($distance -le 40 -or ($script:petHover -and $distance -le 56) -or $script:petDragging) {
    $script:petHover = $true
    $script:hoverLeaveAt = 0
  } elseif ($script:petHover) {
    if (-not $script:hoverLeaveAt) { $script:hoverLeaveAt = $Now }
    if ($Now - $script:hoverLeaveAt -ge 300) { $script:petHover = $false }
  }
  Update-PetBadge
}

function Toggle-PetReply([string]$SessionId) {
  if ($replyBox.Tag -eq $SessionId -and $replyPanel.Visibility -eq 'Visible') {
    $replyPanel.Visibility = 'Collapsed'
  } else {
    if ($replyBox.Tag -and $script:sessionViews.ContainsKey([string]$replyBox.Tag)) {
      $script:sessionViews[[string]$replyBox.Tag].draft = $replyBox.Text
    }
    if ($replyPanel.Parent) { $replyPanel.Parent.Children.Remove($replyPanel) }
    $view = $script:sessionViews[$SessionId]
    [void]$view.body.Children.Add($replyPanel)
    $replyBox.Tag = $SessionId
    $replyBox.Text = [string]$view.draft
    $replyPanel.Visibility = 'Visible'
    [void]$replyBox.Focus()
  }
  Place-PetSessionList
}

function Open-PetMessage($Card) {
  if ($script:petStacked -and @($state.sessions).Count -gt 1) {
    $oldTop = [Windows.Controls.Canvas]::GetTop($sessionBorder)
    $script:petStacked = $false
    Update-PetSessionList
    $window.UpdateLayout()
    Place-PetSessionList
    if ([Windows.SystemParameters]::ClientAreaAnimation) {
      $script:sessionMotionUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 280
      $move = [Windows.Media.Animation.DoubleAnimation]::new($oldTop, [Windows.Controls.Canvas]::GetTop($sessionBorder), [Windows.Duration]::new([TimeSpan]::FromMilliseconds(280)))
      $move.EasingFunction = [Windows.Media.Animation.CubicEase]::new()
      $move.EasingFunction.EasingMode = 'EaseOut'
      $move.FillBehavior = 'Stop'
      $sessionBorder.BeginAnimation([Windows.Controls.Canvas]::TopProperty, $move)
      $offset = 0
      for ($i = 0; $i -lt $sessionRows.Children.Count; $i++) {
        $card = $sessionRows.Children[$i]
        if ($i -gt 0) {
          $transform = New-Object Windows.Media.TransformGroup
          $scale = [Windows.Media.ScaleTransform]::new(1,1)
          $shift = [Windows.Media.TranslateTransform]::new()
          $transform.Children.Add($scale)
          $transform.Children.Add($shift)
          $card.RenderTransformOrigin = [Windows.Point]::new(0.5,0)
          $card.RenderTransform = $transform
          $motion = $move.Clone()
          $motion.From = -$offset + [Math]::Min($i,2) * 8
          $motion.To = 0
          $shift.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $motion)
          $width = $move.Clone()
          $width.From = 0.96
          $width.To = 1
          $scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $width)
          $fade = $move.Clone()
          $fade.From = 0.25
          $fade.To = 1
          $card.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
        }
        $offset += $card.ActualHeight + $card.Margin.Top + $card.Margin.Bottom
      }
    }
    return
  }
  try {
    $sessionError.Text = ''
    Invoke-PetSessionAction ([string]$Card.Tag) 'open'
    Open-PetHost $state
  } catch { $sessionError.Text = $_.Exception.Message }
}

function Update-PetStack {
  $stacked = $script:petStacked -and @($state.sessions).Count -gt 1
  for ($i = 0; $i -lt $sessionRows.Children.Count; $i++) {
    $sessionRows.Children[$i].Visibility = if ($stacked -and $i -gt 0) { 'Collapsed' } else { 'Visible' }
  }
  $stackBacks.Visibility = if ($stacked) { 'Visible' } else { 'Collapsed' }
  $depths = [Math]::Min(2, @($state.sessions).Count - 1)
  $sessionRows.Margin = if ($stacked) { [Windows.Thickness]::new(0,0,0,8 * $depths) } else { [Windows.Thickness]::new(0) }
  if ($stacked) {
    $height = [Math]::Max(56, $sessionRows.Children[0].ActualHeight)
    $width = if ($sessionRows.ActualWidth -gt 0) { $sessionRows.ActualWidth } else { 444 }
    foreach ($back in $stackBacks.Children) {
      $depth = [int]$back.Tag
      $back.Visibility = if ($depth -le $depths) { 'Visible' } else { 'Collapsed' }
      $back.Height = $height
      $back.CornerRadius = [Windows.CornerRadius]::new($height / 2)
      # Exclude the front capsule, preserving curved exposed edges without showing outlines through glass.
      $bounds = [Windows.Media.RectangleGeometry]::new([Windows.Rect]::new(0,0,$width,$height))
      $front = [Windows.Media.RectangleGeometry]::new([Windows.Rect]::new(-12 * $depth,-8 * $depth,$width,$height), $height / 2, $height / 2)
      $back.Clip = [Windows.Media.CombinedGeometry]::new([Windows.Media.GeometryCombineMode]::Exclude,$bounds,$front)
    }
  }
}

function Set-PetMessageActions($Card, [bool]$Visible) {
  $view = $script:sessionViews[[string]$Card.Tag]
  if (-not $view) { return }
  $visibility = if ($Visible) { 'Visible' } else { 'Hidden' }
  $view.close.Visibility = $visibility
  $view.actions.Visibility = $visibility
}

function New-PetActionButton([string]$Caption, $Item, [string]$Action) {
  $button = New-Object Windows.Controls.Button
  $button.Content = switch ($Action) { 'reply' { [string][char]0x21B5 } 'stop' { [string][char]0x25A0 } 'dismiss' { [string][char]0x00D7 } 'compose' { [string][char]0x270E } default { '?' } }
  $button.ToolTip = $Caption
  $button.Width = 32
  $button.Height = 32
  $button.Margin = New-Object Windows.Thickness 4
  $button.Padding = New-Object Windows.Thickness 8, 4, 8, 4
  $button.Tag = @{ item = $Item; action = $Action }
  Set-PetButtonStyle $button
  $button.Padding = [Windows.Thickness]::new(0)
  $button.FontSize = 18
  $button.Add_Click({
    $info = $this.Tag
    try {
      $sessionError.Text = ''
      if ($info.action -eq 'reply') {
        Toggle-PetReply ([string]$info.item.sessionId)
        return
      }
      Invoke-PetSessionAction $info.item.sessionId $info.action
      if ($info.action -eq 'dismiss') { $script:sessionViews[[string]$info.item.sessionId].card.Visibility = 'Collapsed' }
      if ($info.action -eq 'stop') { $this.IsEnabled = $false }
    } catch { $sessionError.Text = $_.Exception.Message }
  })
  return $button
}

function Update-PetSessionList {
  Update-PetTheme
  Update-PetBadge
  $present = @{}
  foreach ($item in @($state.sessions)) {
    $key = [string]$item.sessionId
    $present[$key] = $true
    if (-not $script:sessionViews.ContainsKey($key)) {
      $row = New-Object Windows.Controls.Grid
      $row.Margin = New-Object Windows.Thickness 0, 8, 0, 8
      $textColumn = New-Object Windows.Controls.ColumnDefinition
      $row.ColumnDefinitions.Add($textColumn)
      $actionColumn = New-Object Windows.Controls.ColumnDefinition
      $actionColumn.Width = [Windows.GridLength]::Auto
      $row.ColumnDefinitions.Add($actionColumn)
      $text = New-Object Windows.Controls.StackPanel
      $text.Margin = New-Object Windows.Thickness 12, 4, 4, 4
      [void]$row.Children.Add($text)
      $close = New-PetActionButton '隐藏此消息' $item 'dismiss'
      $close.Width = 22
      $close.Height = 22
      $close.Padding = [Windows.Thickness]::new(0)
      $close.Margin = New-Object Windows.Thickness -4, -20, 0, 0
      $close.BorderThickness = [Windows.Thickness]::new(1)
      $close.SetResourceReference([Windows.Controls.Control]::BorderBrushProperty, 'PetEdge')
      $close.SetResourceReference([Windows.Controls.Control]::BackgroundProperty, 'PetGlass')
      $close.Visibility = 'Hidden'
      $close.HorizontalAlignment = 'Left'
      $close.VerticalAlignment = 'Top'
      [void]$row.Children.Add($close)
      $title = New-Object Windows.Controls.TextBlock
      $title.Text = [string]$item.title
      $title.FontWeight = 'SemiBold'
      $title.TextTrimming = 'CharacterEllipsis'
      $title.ToolTip = [string]$item.title
      $titleRow = New-Object Windows.Controls.DockPanel
      $completed = New-Object Windows.Controls.TextBlock
      $completed.Text = [string][char]0x2713
      $completed.Foreground = [Windows.Media.Brushes]::White
      $completed.FontSize = 10
      $completed.HorizontalAlignment = 'Center'
      $completed.VerticalAlignment = 'Center'
      $completedMark = New-Object Windows.Controls.Border
      $completedMark.Child = $completed
      $completedMark.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#36C779')
      $completedMark.Width = 14
      $completedMark.Height = 14
      $completedMark.CornerRadius = [Windows.CornerRadius]::new(7)
      $completedMark.Margin = [Windows.Thickness]::new(0,0,6,0)
      [Windows.Controls.DockPanel]::SetDock($completedMark, 'Left')
      [void]$titleRow.Children.Add($completedMark)
      [void]$titleRow.Children.Add($title)
      [void]$text.Children.Add($titleRow)
      $status = New-Object Windows.Controls.TextBlock
      $status.Text = if ($item.preview) { [string]$item.preview } else { [string]$item.status }
      $status.TextTrimming = 'CharacterEllipsis'
      $status.ToolTip = ([string]$item.status + ': ' + [string]$item.preview)
      $status.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'PetSecondary')
      [void]$text.Children.Add($status)
      $actions = New-Object Windows.Controls.StackPanel
      $actions.Orientation = 'Horizontal'
      $actions.Visibility = 'Hidden'
      $actions.VerticalAlignment = 'Center'
      [Windows.Controls.Grid]::SetColumn($actions, 1)
      $reply = New-PetActionButton ($script:petLabels.reply) $item 'reply'
      $reply.IsEnabled = $item.canReply -eq $true
      [void]$actions.Children.Add($reply)
      $stop = New-PetActionButton ($script:petLabels.stop) $item 'stop'
      $stop.IsEnabled = $item.running -eq $true
      [void]$actions.Children.Add($stop)
      $compose = New-PetActionButton ($script:petLabels.handle) $item 'compose'
      [void]$actions.Children.Add($compose)
      [void]$row.Children.Add($actions)
      $card = New-Object Windows.Controls.Border
      $card.Tag = $key
      $card.Cursor = [Windows.Input.Cursors]::Hand
      $card.Focusable = $true
      $card.Add_MouseEnter({ Set-PetMessageActions $this $true })
      $card.Add_MouseLeave({
        $view = $script:sessionViews[[string]$this.Tag]
        Set-PetMessageActions $this ($this.IsKeyboardFocused -or $view.actions.IsKeyboardFocusWithin -or $view.close.IsKeyboardFocused)
      })
      $card.Add_GotKeyboardFocus({
        $view = $script:sessionViews[[string]$this.Tag]
        Set-PetMessageActions $this ($this.IsMouseOver -or $this.IsKeyboardFocused -or $view.actions.IsKeyboardFocusWithin -or $view.close.IsKeyboardFocused)
      })
      $card.Add_LostKeyboardFocus({
        $view = $script:sessionViews[[string]$this.Tag]
        Set-PetMessageActions $this ($this.IsMouseOver -or $this.IsKeyboardFocused -or $view.actions.IsKeyboardFocusWithin -or $view.close.IsKeyboardFocused)
      })
      $card.Add_MouseUp({
        param($sender, $event)
        if ($event.ChangedButton -ne [Windows.Input.MouseButton]::Left) { return }
        $source = $event.OriginalSource
        while ($source -and $source -ne $sender) {
          if ($source -is [Windows.Controls.Primitives.ButtonBase] -or $source -is [Windows.Controls.Primitives.TextBoxBase] -or $source -eq $replyPanel) { return }
          $source = if ($source -is [Windows.Media.Visual]) { [Windows.Media.VisualTreeHelper]::GetParent($source) } else { [Windows.LogicalTreeHelper]::GetParent($source) }
        }
        $event.Handled = $true
        Open-PetMessage $sender
      })
      $card.Add_KeyDown({
        param($sender, $event)
        if ($sender.IsKeyboardFocused -and $event.Key -in @([Windows.Input.Key]::Return, [Windows.Input.Key]::Space)) {
          $event.Handled = $true
          Open-PetMessage $sender
        }
      })
      $body = New-Object Windows.Controls.StackPanel
      [void]$body.Children.Add($row)
      $card.Child = $body
      $card.Padding = [Windows.Thickness]::new(12, 4, 8, 4)
      $card.Margin = [Windows.Thickness]::new(0, 10, 0, 6)
      $card.CornerRadius = [Windows.CornerRadius]::new(28)
      $card.Add_SizeChanged({
        $headerHeight = $this.Child.Children[0].DesiredSize.Height + $this.Padding.Top + $this.Padding.Bottom + 2
        $this.CornerRadius = [Windows.CornerRadius]::new([Math]::Min($headerHeight, $this.ActualHeight) / 2)
        if ($script:petStacked -and $sessionRows.Children.Count -gt 0 -and $sessionRows.Children[0] -eq $this) { Update-PetStack }
      })
      $card.BorderThickness = [Windows.Thickness]::new(1)
      $card.SetResourceReference([Windows.Controls.Border]::BackgroundProperty, 'PetGlass')
      $card.SetResourceReference([Windows.Controls.Border]::BorderBrushProperty, 'PetEdge')
      [void]$sessionRows.Children.Add($card)
      $script:sessionViews[$key] = @{ card = $card; body = $body; draft = ''; title = $title; completed = $completedMark; status = $status; close = $close; actions = $actions; reply = $reply; stop = $stop; compose = $compose }
    }
    $view = $script:sessionViews[$key]
    $view.title.Text = [string]$item.title
    $view.title.ToolTip = [string]$item.title
    $view.completed.Visibility = if (-not $item.running -and -not $item.needsAnswer) { 'Visible' } else { 'Collapsed' }
    $view.status.Text = if ($item.preview) { [string]$item.preview } else { [string]$item.status }
    $view.status.ToolTip = ([string]$item.status + ': ' + [string]$item.preview)
    $view.reply.IsEnabled = $item.canReply -eq $true
    $view.stop.IsEnabled = $item.running -eq $true
    $view.compose.Visibility = if ($item.needsAnswer) { 'Visible' } else { 'Collapsed' }
    foreach ($button in @($view.close) + @($view.actions.Children)) { $button.Tag.item = $item }
  }
  foreach ($key in @($script:sessionViews.Keys)) {
    if (-not $present.ContainsKey($key)) {
      $sessionRows.Children.Remove($script:sessionViews[$key].card)
      $script:sessionViews.Remove($key)
      if ($replyBox.Tag -eq $key) { $replyPanel.Visibility = 'Collapsed' }
    }
  }
  $ordered = @($state.sessions)
  for ($i = 0; $i -lt $ordered.Count; $i++) {
    $card = $script:sessionViews[[string]$ordered[$i].sessionId].card
    if ($sessionRows.Children.IndexOf($card) -ne $i) { $sessionRows.Children.Remove($card); $sessionRows.Children.Insert($i, $card) }
  }
  Update-PetStack
  Place-PetSessionList
}

$script:petLabels = @{ reply = '回复'; stop = '终止'; handle = '处理'; empty = '暂无会话'; collapse = '收起' }
$petRoot = New-Object Windows.Controls.Grid
$petRoot.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition))
$badgeRow = New-Object Windows.Controls.RowDefinition
$badgeRow.Height = [Windows.GridLength]::new(32)
$petRoot.RowDefinitions.Add($badgeRow)
$window.Content = $null
[void]$petRoot.Children.Add($image)
$badge = New-Object Windows.Controls.Button
$badge.Background = [Windows.Media.Brushes]::SlateGray
$badge.Foreground = [Windows.Media.Brushes]::White
$badge.BorderThickness = 0
$badge.Width = 28
$badge.Height = 6
$badge.HorizontalAlignment = 'Center'
$badge.VerticalAlignment = 'Center'
$badge.ToolTip = '展开或收起会话列表'
$badge.Cursor = [Windows.Input.Cursors]::Hand
$badge.Template = [Windows.Markup.XamlReader]::Parse('<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button"><Border CornerRadius="16" Background="{TemplateBinding Background}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border></ControlTemplate>')
[Windows.Controls.Grid]::SetRow($badge, 1)
[void]$petRoot.Children.Add($badge)
$surface = New-Object Windows.Controls.Canvas
[void]$surface.Children.Add($petRoot)
$window.Content = $surface
$script:petExpanded = $false
$script:petStacked = $true
$script:petHover = $false
$script:sessionViews = @{}

$sessionBorder = New-Object Windows.Controls.Border
$sessionBorder.Background = [Windows.Media.Brushes]::Transparent
$sessionBorder.Padding = [Windows.Thickness]::new(8)
$sessionBorder.BorderThickness = [Windows.Thickness]::new(0)
$sessionBorder.RenderTransform = New-Object Windows.Media.ScaleTransform 1, 1
$sessionBorder.RenderTransformOrigin = [Windows.Point]::new(0.5,0.5)
[Windows.Controls.TextBlock]::SetForeground($surface, [Windows.Media.Brushes]::Black)
$surface.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'PetForeground')
$sessionBody = New-Object Windows.Controls.StackPanel
$sessionRows = New-Object Windows.Controls.StackPanel
$sessionScroll = New-Object Windows.Controls.ScrollViewer
$sessionScroll.MaxHeight = 300
$sessionScroll.VerticalScrollBarVisibility = 'Auto'
$sessionScroll.HorizontalScrollBarVisibility = 'Disabled'
$sessionDeck = New-Object Windows.Controls.Grid
$stackBacks = New-Object Windows.Controls.Grid
$stackBacks.IsHitTestVisible = $false
$stackBacks.Visibility = 'Collapsed'
foreach ($depth in @(2,1)) {
  $back = New-Object Windows.Controls.Border
  $back.Tag = $depth
  $back.Margin = [Windows.Thickness]::new(12 * $depth,10 + 8 * $depth,12 * $depth,0)
  $back.VerticalAlignment = 'Top'
  $back.BorderThickness = [Windows.Thickness]::new(1)
  $back.SetResourceReference([Windows.Controls.Border]::BackgroundProperty, 'PetGlass')
  $back.SetResourceReference([Windows.Controls.Border]::BorderBrushProperty, 'PetEdge')
  [void]$stackBacks.Children.Add($back)
}
[void]$sessionDeck.Children.Add($stackBacks)
[void]$sessionDeck.Children.Add($sessionRows)
$sessionScroll.Content = $sessionDeck
[void]$sessionBody.Children.Add($sessionScroll)
$replyPanel = New-Object Windows.Controls.StackPanel
$replyPanel.Margin = [Windows.Thickness]::new(16,0,16,12)
$replyPanel.Visibility = 'Collapsed'
$replyBox = New-Object Windows.Controls.TextBox
$replyBox.Cursor = [Windows.Input.Cursors]::IBeam
$replyBox.AcceptsReturn = $false
$replyBox.TextWrapping = 'NoWrap'
$replyBox.MaxLines = 1
$replyBox.Height = 36
$replyBox.Padding = [Windows.Thickness]::new(10,6,10,6)
$replyBox.Margin = [Windows.Thickness]::new(0,4,0,4)
$replyBox.ToolTip = '回车发送快捷回复'
$replyBox.VerticalContentAlignment = 'Center'
$replyBox.Template = [Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="TextBox">
  <Border x:Name="InputBorder" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" CornerRadius="12" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1">
    <Grid>
      <!-- TextBox applies Padding to its content host; adding a margin would count it twice. -->
      <ScrollViewer x:Name="PART_ContentHost" Foreground="{TemplateBinding Foreground}" VerticalAlignment="Center"/>
      <TextBlock x:Name="Placeholder" Text="输入快捷回复，回车发送" Margin="{TemplateBinding Padding}" VerticalAlignment="Center" Foreground="{DynamicResource PetSecondary}" IsHitTestVisible="False" Visibility="Collapsed"/>
    </Grid>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="Text" Value=""><Setter TargetName="Placeholder" Property="Visibility" Value="Visible"/></Trigger>
    <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="InputBorder" Property="BorderBrush" Value="#748AA8"/></Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@)
[void]$replyPanel.Children.Add($replyBox)
$replyBox.Add_KeyDown({
  param($sender, $event)
  if ($event.Key -ne [Windows.Input.Key]::Return) { return }
  $event.Handled = $true
  if ([string]::IsNullOrWhiteSpace($replyBox.Text)) { return }
  try {
    Invoke-PetSessionAction ([string]$replyBox.Tag) 'reply' ($replyBox.Text -replace '[\r\n]+', ' ')
    $replyBox.Text = ''
    if ($script:sessionViews.ContainsKey([string]$replyBox.Tag)) { $script:sessionViews[[string]$replyBox.Tag].draft = '' }
    $replyPanel.Visibility = 'Collapsed'
    $sessionError.Text = ''
    Place-PetSessionList
  } catch { $sessionError.Text = $_.Exception.Message }
})
$sessionError = New-Object Windows.Controls.TextBlock
$sessionError.Foreground = [Windows.Media.Brushes]::Salmon
$sessionError.TextWrapping = 'Wrap'
[void]$sessionBody.Children.Add($sessionError)
$sessionBorder.Child = $sessionBody
$sessionBorder.Visibility = 'Collapsed'
[void]$surface.Children.Add($sessionBorder)
$sessionBody.Add_SizeChanged({ Place-PetSessionList })
$badge.Add_Click({
  $script:petExpanded = -not $script:petExpanded
  $script:petClosingUntil = 0
  $sessionBorder.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
  foreach ($property in @([Windows.Media.ScaleTransform]::ScaleXProperty, [Windows.Media.ScaleTransform]::ScaleYProperty)) { $sessionBorder.RenderTransform.BeginAnimation($property, $null) }
  if ($script:petExpanded) {
    $script:petStacked = $true
    Update-PetStack
    $script:sessionSide = $null
    $sessionBorder.BeginAnimation([Windows.Controls.Canvas]::TopProperty, $null)
  }
  if ([Windows.SystemParameters]::ClientAreaAnimation) {
    if (-not $script:petExpanded) { $script:petClosingUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 200 }
    $from = if ($script:petExpanded) { 0 } else { 1 }
    $to = 1 - $from
    $fade = [Windows.Media.Animation.DoubleAnimation]::new($from, $to, [Windows.Duration]::new([TimeSpan]::FromMilliseconds(200)))
    $sessionBorder.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
    $scale = $fade.Clone()
    $scale.From = if ($script:petExpanded) { 0.94 } else { 1 }
    $scale.To = if ($script:petExpanded) { 1 } else { 0.94 }
    $ease = New-Object Windows.Media.Animation.CubicEase
    $ease.EasingMode = 'EaseOut'
    $scale.EasingFunction = $ease
    foreach ($property in @([Windows.Media.ScaleTransform]::ScaleXProperty, [Windows.Media.ScaleTransform]::ScaleYProperty)) { $sessionBorder.RenderTransform.BeginAnimation($property, $scale) }
  }
  Place-PetSessionList
})
$badge.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#F0556475')
$badge.Foreground = [Windows.Media.Brushes]::White
$badge.Effect = New-Object Windows.Media.Effects.DropShadowEffect
$badge.Effect.Color = [Windows.Media.Colors]::Black
$badge.Effect.BlurRadius = 6
$badge.Effect.ShadowDepth = 1
$replyBox.SetResourceReference([Windows.Controls.Control]::BackgroundProperty, 'PetInput')
$replyBox.SetResourceReference([Windows.Controls.Control]::ForegroundProperty, 'PetForeground')
$replyBox.SetResourceReference([Windows.Controls.Primitives.TextBoxBase]::CaretBrushProperty, 'PetForeground')
$replyBox.SetResourceReference([Windows.Controls.Control]::BorderBrushProperty, 'PetEdge')
$sessionError.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'PetError')
$hoverTimer = New-Object Windows.Threading.DispatcherTimer
$hoverTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$hoverTimer.Add_Tick({
  if (-not $window.IsVisible) { return }
  $source = [Windows.PresentationSource]::FromVisual($window)
  if (-not $source) { return }
  $cursor = [Windows.Forms.Cursor]::Position
  $point = $source.CompositionTarget.TransformFromDevice.Transform([Windows.Point]::new($cursor.X, $cursor.Y))
  Update-PetHover $point ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  if ($script:petClosingUntil -gt 0 -and $script:petClosingUntil -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { $script:petClosingUntil = 0; Place-PetSessionList }
})
$hoverTimer.Start()
Update-PetSessionList
