function Get-PetResidentPlacement($Anchor) {
  $wa = $Anchor.workArea
  return @{
    left = [Math]::Max([double]$wa.left + 12, [Math]::Min([double]$Anchor.left, [double]$wa.right - [double]$Anchor.width - 12))
    # Height includes the permanent badge row, even while it is hidden.
    top = [Math]::Max([double]$wa.top + 12, [Math]::Min([double]$Anchor.top, [double]$wa.bottom - [double]$Anchor.height - 12))
  }
}

function Get-PetSavedPosition($Anchor) {
  $wa = $Anchor.workArea
  return @{
    monitor = $Anchor.monitor
    x = [Math]::Max(0.0, [Math]::Min(1.0, ($Anchor.left - $wa.left - 12) / [Math]::Max(1.0, $wa.right - $wa.left - $Anchor.width - 24)))
    y = [Math]::Max(0.0, [Math]::Min(1.0, ($Anchor.top - $wa.top - 12) / [Math]::Max(1.0, $wa.bottom - $wa.top - $Anchor.height - 24)))
  }
}

function Get-PetRestoredAnchor($Saved, $Screens, [double]$Width, [double]$Height) {
  $screen = @($Screens | Where-Object { $_.monitor -eq $Saved.monitor }) | Select-Object -First 1
  if (-not $screen) { $screen = @($Screens | Where-Object { $_.primary }) | Select-Object -First 1 }
  if (-not $screen) { $screen = $Screens[0] }
  $x = 1.0; $y = 1.0
  try {
    if ($null -ne $Saved.x -and $null -ne $Saved.y) {
      $sx = [double]$Saved.x; $sy = [double]$Saved.y
      if (-not [double]::IsNaN($sx) -and -not [double]::IsInfinity($sx) -and -not [double]::IsNaN($sy) -and -not [double]::IsInfinity($sy)) {
        $x = [Math]::Max(0.0, [Math]::Min(1.0, $sx)); $y = [Math]::Max(0.0, [Math]::Min(1.0, $sy))
      }
    }
  } catch {}
  $wa = $screen.workArea
  return @{
    monitor = $screen.monitor; workArea = $wa; width = $Width; height = $Height
    left = $wa.left + 12 + $x * [Math]::Max(0.0, $wa.right - $wa.left - $Width - 24)
    top = $wa.top + 12 + $y * [Math]::Max(0.0, $wa.bottom - $wa.top - $Height - 24)
  }
}

function Get-PetSessionPlacement($Anchor, [double]$Width, [double]$Height) {
  $wa = $Anchor.workArea
  $side = if ([double]$Anchor.top + [double]$Anchor.height / 2 -lt ([double]$wa.top + [double]$wa.bottom) / 2) { 'below' } else { 'above' }
  $x = [double]$Anchor.left + ([double]$Anchor.width - $Width) / 2
  $y = if ($side -eq 'below') { [double]$Anchor.top + [double]$Anchor.height + 8 } else { [double]$Anchor.top - $Height - 8 }
  return @{
    left = [Math]::Max([double]$wa.left + 8, [Math]::Min($x, [double]$wa.right - $Width - 8))
    top = [Math]::Max([double]$wa.top + 8, [Math]::Min($y, [double]$wa.bottom - $Height - 8))
    side = $side
  }
}

function Get-PetBubblePlacement($Anchor, [double]$Width, [double]$Height) {
  $wa = $Anchor.workArea
  $leftSpace = [double]$Anchor.left - [double]$wa.left
  $rightSpace = [double]$wa.right - ([double]$Anchor.left + [double]$Anchor.width)
  $side = if ($rightSpace -ge $Width + 12) { 'right' } elseif ($leftSpace -ge $Width + 12) { 'left' } elseif ($rightSpace -ge $leftSpace) { 'right' } else { 'left' }
  $x = if ($side -eq 'right') { [double]$Anchor.left + [double]$Anchor.width + 8 } else { [double]$Anchor.left - $Width - 8 }
  $y = [double]$Anchor.top + [double]$Anchor.height / 2 - $Height / 2
  $x = [Math]::Max([double]$wa.left + 8, [Math]::Min($x, [double]$wa.right - $Width - 8))
  $y = [Math]::Max([double]$wa.top + 8, [Math]::Min($y, [double]$wa.bottom - $Height - 8))
  return @{ left = $x; top = $y; side = $side }
}
