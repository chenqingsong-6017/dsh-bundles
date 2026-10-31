# migrate-profile-to-d.ps1  DSH profiles 目录迁移到 D 盘
# 必须在 DSH 完全关闭后运行。用法：
#   pwsh -File migrate-profile-to-d.ps1              # 正式迁移（复制 -> 校验 -> 改名备份 -> 建 junction）
#   pwsh -File migrate-profile-to-d.ps1 -PrepareOnly  # 只做复制+校验，不动物件（可随时跑）
#   pwsh -File migrate-profile-to-d.ps1 -Rollback     # 回滚：删 junction，恢复 C 盘原目录
param([switch]$Rollback, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$src = "$env:USERPROFILE\.dsh\profiles"
$dst = 'D:\AI\dsh-data\profiles'
$bak = "$env:USERPROFILE\.dsh\profiles.bak-before-d"
function Step($m) { Write-Host "" ; Write-Host ("== " + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ("   OK  " + $m) -ForegroundColor Green }
function Bad($m) { Write-Host ("   X   " + $m) -ForegroundColor Red }

function Test-IsJunction($p) {
  if (-not (Test-Path $p)) { return $false }
  $i = Get-Item $p -Force
  return [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Test-DshRunning {
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  return [bool]$p
}

function Copy-Tree {
  Step "复制 profiles -> D 盘（跳过 junction，符号链接按链接复制）"
  $rc = & robocopy $src $dst /MIR /XJ /SL /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
  Write-Host ("   robocopy 退出码 " + $LASTEXITCODE + "（0-7 正常）")
  if ($LASTEXITCODE -ge 8) { throw "robocopy 复制失败" }
}

function Repair-Links {
  Step "重建 @local / eva-theme 链接（junction）"
  $links = @(Get-ChildItem $src -Recurse -Force -ErrorAction SilentlyContinue -Attributes ReparsePoint)
  $ok = 0; $bad = 0
  foreach ($l in $links) {
    $rel = $l.FullName.Substring($src.Length).TrimStart('\')
    $tp = Join-Path $dst $rel
    $target = @($l.Target)[0]
    if (Test-Path $tp) { Remove-Item -LiteralPath $tp -Recurse -Force -ErrorAction SilentlyContinue }
    & cmd /c mklink /J $tp $target | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok++ } else { $bad++; Bad ("失败: " + $rel) }
  }
  Ok ("重建 " + $ok + " 个链接，失败 " + $bad)
  if ($bad -gt 0) { throw "有链接重建失败" }
  return $links.Count
}

function Test-Copy($expectLinks) {
  Step "校验"
  $sf = @(Get-ChildItem $src -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
  $df = @(Get-ChildItem $dst -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
  $dl = @(Get-ChildItem $dst -Recurse -Force -ErrorAction SilentlyContinue -Attributes ReparsePoint)
  $ss = ($sf | Measure-Object Length -Sum).Sum
  $ds = ($df | Measure-Object Length -Sum).Sum
  Write-Host ("   非链接文件 源 " + $sf.Count + " / 目标 " + $df.Count)
  Write-Host ("   非链接字节 " + [math]::Round($ss/1MB,2) + " MB / " + [math]::Round($ds/1MB,2) + " MB")
  Write-Host ("   目标链接数 " + $dl.Count + "（源 " + $expectLinks + "）")
  if ($df.Count -ne $sf.Count) { throw "文件数不一致" }
  if ([math]::Abs($ss - $ds) -gt 65536) { throw "字节数不一致" }
  if ($dl.Count -ne $expectLinks) { throw "链接数不一致" }
  foreach ($f in @("desktop\package.json","desktop\cordis.patch.yml","desktop\node_modules\dsh-proof\package.json","desktop\node_modules\@local\dsh-memory\index.js","headless\package.json")) {
    if (-not (Test-Path (Join-Path $dst $f))) { throw ("缺少关键文件: " + $f) }
  }
  Ok "复制内容校验通过"
}

function Do-Rollback {
  Step "回滚"
  if (Test-IsJunction $src) {
    & cmd /c rmdir $src | Out-Null
    Ok "已删除 C 盘 junction（D 盘数据保留）"
  }
  if ((Test-Path $bak) -and -not (Test-Path $src)) {
    Rename-Item -LiteralPath $bak -NewName "profiles"
    Ok "已恢复 C 盘原目录"
  }
  if (Test-Path $src) { Ok "C 盘 profiles 已就位（不是 junction）" } else { Bad "回滚失败，请手工检查" }
}

if ($Rollback) { Do-Rollback; exit 0 }

if (Test-DshRunning) {
  Bad "DSH 还在运行，profiles 被占用。请完全退出 DSH（含托盘）后重跑本脚本。"
  exit 2
}

$linkCount = @(Get-ChildItem $src -Recurse -Force -ErrorAction SilentlyContinue -Attributes ReparsePoint).Count
Write-Host ("C 盘源链接数: " + $linkCount)
Copy-Tree
$null = Repair-Links
Test-Copy $linkCount

if ($PrepareOnly) { Ok "仅准备模式完成：D 盘副本已就绪且校验通过，未改动 C 盘"; exit 0 }

Step "C 盘原目录改名备份 -> profiles.bak-before-d"
try { Rename-Item -LiteralPath $src -NewName "profiles.bak-before-d" -ErrorAction Stop; Ok "改名成功" }
catch { Bad ("改名失败: " + $_.Exception.Message); exit 3 }

Step "建立 C 盘 junction -> D 盘"
& cmd /c mklink /J $src $dst | ForEach-Object { Write-Host ("   " + $_) }
if ($LASTEXITCODE -ne 0) { Bad "mklink 失败，自动回滚"; Do-Rollback; exit 4 }

Step "最终校验"
if (-not (Test-IsJunction $src)) { Bad "不是 junction，回滚"; Do-Rollback; exit 5 }
$i = Get-Item $src -Force
Write-Host ("   " + $i.LinkType + " -> " + $i.Target)
if (-not (Test-Path (Join-Path $src "desktop\package.json"))) { Bad "通过 junction 读不到 package.json，回滚"; Do-Rollback; exit 6 }
Ok "迁移完成。现在可以重新打开 DSH。"
Write-Host ""
Write-Host "确认 DSH 正常跑 3 天没问题后，这份备份可以删（用户规则：稳定即删）：" -ForegroundColor Yellow
Write-Host ("  Remove-Item -LiteralPath " + $bak + " -Recurse -Force")
Write-Host ""
Write-Host "回滚命令：" -ForegroundColor Yellow
Write-Host ("  pwsh -File " + $PSCommandPath + " -Rollback")
