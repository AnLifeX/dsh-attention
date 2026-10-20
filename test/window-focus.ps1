$ErrorActionPreference = 'Stop'
$scriptsDir = Join-Path $PSScriptRoot '..\scripts'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptsDir 'window-focus.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Compile the real P/Invoke declarations, then exercise behavior without moving the user's windows.
$source = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.VariablePath.UserPath -eq 'nativeSource' }, $true)
Invoke-Expression $source.Extent.Text
Add-Type -TypeDefinition $nativeSource
Add-Type -TypeDefinition @'
using System;
public static class FocusTestNative {
  public static IntPtr Foreground;
  public static IntPtr Target;
  public static bool Minimized, Denied, NeedAlt, AltDown, AltReleased, ThrowKey;
  public static int Restores, Sets, Polls;
  public static string Windows;
  public static bool IsIconic(IntPtr h) { return Minimized; }
  public static bool ShowWindowAsync(IntPtr h, int cmd) { Restores++; Minimized = false; return true; }
  public static bool SetForegroundWindow(IntPtr h) { Sets++; Target = h; Polls = 0; return true; }
  public static IntPtr GetForegroundWindow() {
    if (!Denied && (!NeedAlt || AltReleased) && ++Polls >= 3) Foreground = Target;
    return Foreground;
  }
  public static void keybd_event(byte key, byte scan, int flags, int extra) {
    AltDown = flags == 0;
    if (flags == 2) AltReleased = true;
    if (flags == 0 && ThrowKey) throw new Exception("injected key failure");
  }
  public static string ListVisibleWindows() { return Windows; }
  public static void Reset() {
    Foreground = IntPtr.Zero; Target = IntPtr.Zero;
    Minimized = Denied = NeedAlt = AltDown = AltReleased = ThrowKey = false;
    Restores = Sets = Polls = 0;
  }
}
'@
foreach ($name in @('Test-SameHwnd', 'Activate-Hwnd', 'Get-DshNeedles', 'Test-BrowserProcess', 'Score-DshTitle', 'Find-DshHwnd', 'Focus-ExistingDsh')) {
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression ($definition.Extent.Text.Replace('[DshAttentionNative]', '[FocusTestNative]'))
}
function Write-ActLog($Line) {}
if (Activate-Hwnd ([IntPtr]::Zero)) { throw 'A missing window must not report success' }
foreach ($minimized in @($false, $true)) {
  [FocusTestNative]::Reset()
  [FocusTestNative]::Minimized = $minimized
  if (-not (Activate-Hwnd ([IntPtr]123))) { throw 'Activation must wait for asynchronous foreground changes' }
  if ([FocusTestNative]::AltReleased -or [FocusTestNative]::Sets -ne 1) { throw 'Normal click activation must not inject keys' }
  if ([FocusTestNative]::Restores -ne [int]$minimized) { throw 'Only minimized windows should be restored' }
}
[FocusTestNative]::Reset()
[FocusTestNative]::NeedAlt = $true
if (-not (Activate-Hwnd ([IntPtr]123)) -or [FocusTestNative]::Sets -ne 2 -or [FocusTestNative]::AltDown) {
  throw 'Foreground-lock retry must release Alt before activating the window'
}
[FocusTestNative]::Reset()
[FocusTestNative]::Denied = $true
if (Activate-Hwnd ([IntPtr]123)) { throw 'Taskbar flashing / successful API return must not count as foreground success' }
[FocusTestNative]::Reset()
[FocusTestNative]::NeedAlt = $true
[FocusTestNative]::ThrowKey = $true
if ((Activate-Hwnd ([IntPtr]123)) -or [FocusTestNative]::AltDown) { throw 'Failed activation must still release Alt' }
if ((Score-DshTitle 'Unrelated page - Google Chrome' @('DeepSeek Harness')) -ne 0) { throw 'An unrelated browser title must not match' }
if ((Score-DshTitle 'DeepSeek Harness - Microsoft Edge' @('DeepSeek Harness')) -le 0) { throw 'Normal browser tabs must match' }
if ((Score-DshTitle 'DeepSeek Harness' @('DeepSeek Harness')) -le 0) { throw 'PWA windows must match' }
function Get-Process($Id) {
  $name = if ($Id -eq 999) { 'dsh' } else { 'chrome' }
  return [pscustomobject]@{ ProcessName = $name }
}
# Two windows belonging to the same browser process must be considered separately.
[FocusTestNative]::Windows = "100`t111`tUnrelated page - Google Chrome`n200`t111`tDeepSeek Harness - Google Chrome`n300`t999`tDeepSeek Harness"
$data = [pscustomobject]@{ webUrl = 'http://127.0.0.1:19387' }
if ((Find-DshHwnd $data).ToInt64() -ne 200) { throw 'Must select the matching browser HWND, including secondary browser windows' }
[FocusTestNative]::Windows = "100`t111`tUnrelated page - Google Chrome`n300`t999`tDeepSeek Harness"
if ((Find-DshHwnd $data) -ne [IntPtr]::Zero) { throw 'Web activation must not pick Desktop or an unrelated browser' }
$data = [pscustomobject]@{ webUrl = 'http://127.0.0.1:19387'; windowTitle = 'Unique session title' }
[FocusTestNative]::Windows = "100`t111`tUnrelated page - Google Chrome`n200`t111`tUnique session title - Google Chrome"
if ((Find-DshHwnd $data).ToInt64() -ne 200) { throw 'Reported page titles must be matched as individual needles' }
Write-Output 'Web/PWA discovery and foreground activation checks passed'
