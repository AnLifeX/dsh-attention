$ErrorActionPreference = 'Stop'
$scriptsDir = Join-Path $PSScriptRoot '..\scripts'
$choiceAst = $null
foreach ($name in @('choice-window.ps1', 'protocol-handler.ps1')) {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptsDir $name), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  if ($name -eq 'choice-window.ps1') { $choiceAst = $ast }
}

# Run the real click handler with process/window operations replaced by local stubs.
foreach ($name in @('Test-ReuseSession', 'Open-ExistingSession')) {
  $definition = $choiceAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression $definition.Extent.Text
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
