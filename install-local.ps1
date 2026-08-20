# 把 D: 源码镜像到 C:（与 ~/.dsh profile 同盘），再用 file: 安装。
# Windows 上 pnpm file: 走硬链接，不能跨盘；junction 到 D: 同样会失败。
# 版本号不变时 pnpm 会跳过新文件（例如 src/protocol.js），所以每次都删掉
# 已安装副本再 add，避免 index.js 已更新但缺模块导致 dsh web 起不来。
# 改完 D:\gddi\dsh-attention 后重新跑本脚本，再重启 dsh web。
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$dest = Join-Path $profileDir 'dsh-attention-local'

if (-not (Test-Path $src)) { throw "source not found: $src" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$robo = & robocopy $src $dest /MIR /XD .git node_modules /NFL /NDL /NJH /NJS /nc /ns /np
# robocopy: 0-7 = success with extra bits; 8+ = failure
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit $LASTEXITCODE"
}

Write-Host "mirrored -> $dest"

$installed = Join-Path $profileDir 'node_modules\dsh-attention'
if (Test-Path $installed) {
  Remove-Item -LiteralPath $installed -Recurse -Force
  Write-Host "removed stale $installed"
}
$pnpmRoot = Join-Path $profileDir 'node_modules\.pnpm'
if (Test-Path $pnpmRoot) {
  Get-ChildItem -LiteralPath $pnpmRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'dsh-attention@*' } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      Write-Host "removed stale $($_.Name)"
    }
}

dsh plugin --profile web add "file:$dest"

$proto = Join-Path $profileDir 'node_modules\dsh-attention\src\protocol.js'
$persist = Join-Path $profileDir 'node_modules\dsh-attention\src\persist.js'
$ui = Join-Path $profileDir 'node_modules\dsh-attention\src\ui-page.js'
$logo = Join-Path $profileDir 'node_modules\dsh-attention\assets\logo-a-bell.png'
$choice = Join-Path $profileDir 'node_modules\dsh-attention\scripts\choice-window.ps1'
$inbox = Join-Path $profileDir 'node_modules\dsh-attention\src\inbox.js'
foreach ($path in @($proto, $persist, $ui, $logo, $choice, $inbox)) {
  if (-not (Test-Path $path)) { throw "install incomplete: missing $path" }
}
Write-Host "verified protocol.js persist.js ui-page.js inbox.js choice-window.ps1 logo"
Write-Host "done. restart dsh web to load dsh-attention."
