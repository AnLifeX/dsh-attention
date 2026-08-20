# 把 D: 源码镜像到 C:（与 ~/.dsh profile 同盘），再用 file: 安装。
# Windows 上 pnpm file: 走硬链接，不能跨盘；junction 到 D: 同样会失败。
# 改完 D:\gddi\dsh-attention 后重新跑本脚本，再重启 dsh web。
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\web\dsh-attention-local'

if (-not (Test-Path $src)) { throw "source not found: $src" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$robo = & robocopy $src $dest /MIR /XD .git node_modules /NFL /NDL /NJH /NJS /nc /ns /np
# robocopy: 0-7 = success with extra bits; 8+ = failure
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit $LASTEXITCODE"
}

Write-Host "mirrored -> $dest"
dsh plugin --profile web add "file:$dest"
Write-Host "done. restart dsh web to load dsh-attention."
