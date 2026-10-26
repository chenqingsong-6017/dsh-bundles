<#
  DSH 自研插件栈自检（开发期脚本，不是插件）。

  一条命令跑完：结构 → 清单 → 语法 → schema → 单元测试 → profile 安装一致性。
  退出码 0 表示全绿；任何一项失败返回 1。

  用法：
    pwsh -File D:\AI\dsh-bundles\_selftest\selfcheck.ps1
    pwsh -File ...\selfcheck.ps1 -SkipTests     # 跳过单元测试（快跑一遍结构）
#>
param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = 'D:\AI\dsh-bundles'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$profileJson = Join-Path $profileDir 'package.json'

# 只有这些是"完整交付"的 bundle（必须有 locale / icon / README）
$strictBundles = @(
  'dsh-checkpoint', 'dsh-skill-usage', 'dsh-memory',
  'dsh-repomap', 'dsh-verify', 'dsh-agents-md',
  'dsh-browser-bundle', 'dsh-computer-bundle', 'dsh-staleness-watch',
  'dsh-usage', 'dsh-audit', 'dsh-notify'
)

$failures = [System.Collections.Generic.List[string]]::new()
$checks = 0
function Check([bool]$ok, [string]$label) {
  $script:checks += 1
  if ($ok) { Write-Host "  ✓ $label" -ForegroundColor DarkGreen }
  else { Write-Host "  ✗ $label" -ForegroundColor Red; $script:failures.Add($label) }
}

$bundleDirs = Get-ChildItem $root -Directory | Where-Object { $_.Name -notlike '_*' } | Sort-Object Name
Write-Host "=== 1. 结构与清单（$($bundleDirs.Count) 个 bundle） ==="

$manifest = @{}
foreach ($dir in $bundleDirs) {
  $name = $dir.Name
  $pkgPath = Join-Path $dir.FullName 'package.json'
  Check (Test-Path $pkgPath) "$name · package.json 存在"
  if (-not (Test-Path $pkgPath)) { continue }

  try { $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json } catch { $pkg = $null }
  Check ($null -ne $pkg) "$name · package.json 可解析"
  if ($null -eq $pkg) { continue }
  $manifest[$name] = $pkg

  Check ($null -ne $pkg.dsh.bundle.patch) "$name · 声明了 dsh.bundle.patch"

  $patchPath = Join-Path $dir.FullName 'cordis.patch.yml'
  Check (Test-Path $patchPath) "$name · cordis.patch.yml 存在"
  if (Test-Path $patchPath) {
    $patchText = Get-Content $patchPath -Raw
    # 三种合法形态：insert 自己的行 / insert 别人的行（集成 bundle）/ 只做覆盖
    $hasInsert = $patchText -match '(?m)^\s*-\s*insert:'
    $hasOverride = $patchText -match '(?m)^-\s+id:'
    $hasName = $patchText -match '(?m)^\s*name:'
    Check ($hasInsert -or $hasOverride) "$name · patch 有 insert 或覆盖行"
    if ($hasInsert) { Check $hasName "$name · insert 行带 name" }
  }

  # 入口校验：按 package.json 的 main / exports["."] 解析，兼容根 index.js 与 lib/index.js 两种形态
  $entryRel = $null
  if ($pkg.main) {
    $entryRel = [string]$pkg.main
  } elseif ($pkg.exports) {
    $dot = $pkg.exports.'.'
    if ($dot -is [string]) { $entryRel = $dot }
    elseif ($dot -is [pscustomobject]) {
      if ($dot.import) { $entryRel = [string]$dot.import }
      elseif ($dot.require) { $entryRel = [string]$dot.require }
    }
  }
  if (-not $entryRel -and (Test-Path (Join-Path $dir.FullName 'index.js'))) { $entryRel = './index.js' }

  if ($entryRel) {
    $rel = ($entryRel -replace '\\', '/') -replace '^\./', ''
    $entryPath = Join-Path $dir.FullName $rel
    Check (Test-Path $entryPath) "$name · 入口 $rel 存在"
    if (Test-Path $entryPath) {
      $tmp = Join-Path $env:TEMP ("selfcheck-" + [guid]::NewGuid().ToString('N') + '.mjs')
      Copy-Item $entryPath $tmp
      node --check $tmp *> $null
      Check ($LASTEXITCODE -eq 0) "$name · 入口 $rel 语法通过"
      Remove-Item $tmp -Force
    }
  } else {
    Write-Host "  · $name · 纯配置 bundle（无入口代码，正常）" -ForegroundColor DarkGray
  }

  if ($strictBundles -contains $name) {
    foreach ($f in @('locale\en.json', 'locale\zh.json', 'icon.svg', 'README.md')) {
      Check (Test-Path (Join-Path $dir.FullName $f)) "$name · $f 存在"
    }
    foreach ($locale in @('locale\en.json', 'locale\zh.json')) {
      $lp = Join-Path $dir.FullName $locale
      if (Test-Path $lp) {
        $parsed = $true
        try { Get-Content $lp -Raw | ConvertFrom-Json | Out-Null } catch { $parsed = $false }
        Check $parsed "$name · $locale 可解析"
        if ($parsed) {
          $meta = (Get-Content $lp -Raw | ConvertFrom-Json).meta
          Check (($meta.title -and $meta.description)) "$name · $locale 有 title/description"
        }
      }
    }
    $iconPath = Join-Path $dir.FullName 'icon.svg'
    if (Test-Path $iconPath) {
      $icon = Get-Item $iconPath
      Check ($icon.Length -lt 256KB) "$name · icon 小于 256 KiB"
      $head = (Get-Content $iconPath -Raw).TrimStart()
      Check ($head.StartsWith('<svg') -or $head.StartsWith('<?xml')) "$name · icon 是 SVG"
    }
  }
}

Write-Host ""
Write-Host "=== 2. 工具输出 schema（node schema-check.mjs） ==="
$schemaOutput = node (Join-Path $root '_selftest\schema-check.mjs') 2>&1
$schemaExit = $LASTEXITCODE
$schemaSummary = ($schemaOutput | Select-Object -Last 1)
Check ($schemaExit -eq 0) "schema 检查通过（$schemaSummary）"
if ($schemaExit -ne 0) { $schemaOutput | Where-Object { $_ -match 'FAIL|schemas' } | ForEach-Object { Write-Host "    $_" -ForegroundColor Red } }

Write-Host ""
Write-Host "=== 3. 单元测试 ==="
if ($SkipTests) {
  Write-Host "  （已跳过）" -ForegroundColor DarkGray
} else {
  $testFiles = Get-ChildItem (Join-Path $root '_selftest\tests') -Filter '*.test.mjs' -ErrorAction SilentlyContinue
  foreach ($test in $testFiles) {
    $out = node $test.FullName 2>&1
    $ok = $LASTEXITCODE -eq 0
    Check $ok "$($test.Name)"
    if (-not $ok) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor Red } }
  }
}

Write-Host ""
Write-Host "=== 4. profile 安装一致性 ==="
Check (Test-Path $profileJson) "profile package.json 存在"
if (Test-Path $profileJson) {
  $profile = Get-Content $profileJson -Raw | ConvertFrom-Json
  $selected = @($profile.dsh.profile.bundles)
  foreach ($name in $manifest.Keys) {
    $pkgName = $manifest[$name].name
    $dep = $profile.dependencies.$pkgName
    if ($null -eq $dep) { continue }  # 未安装的 bundle 不在这里检查
    Check ($selected -contains $pkgName) "$name · 在 profile bundle 列表中"
    $expected = 'link:' + (Join-Path $root $name)
    Check (($dep -replace '\\', '/') -eq ($expected -replace '\\', '/')) "$name · 依赖指向 $root\$name"

    $scope = ($pkgName -split '/')[0]
    $leaf = ($pkgName -split '/')[1]
    $linkPath = Join-Path $profileDir "node_modules\$scope\$leaf"
    if (Test-Path $linkPath) {
      $target = (Get-Item $linkPath -Force).Target
      $targetPath = if ($target) { @($target)[0] } else { $null }
      Check (($null -ne $targetPath) -and (($targetPath -replace '\\', '/') -eq ((Join-Path $root $name) -replace '\\', '/'))) "$name · node_modules 链接指向正确"
    } else {
      Check $false "$name · node_modules 里没有链接"
    }
  }
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "全部通过：$checks 项检查" -ForegroundColor Green
  exit 0
} else {
  Write-Host "失败 $($failures.Count) 项 / 共 $checks 项：" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
