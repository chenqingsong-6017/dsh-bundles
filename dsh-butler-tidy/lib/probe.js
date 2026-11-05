// 依赖探测 + 系统健康/事件/残留探测（从 index.js 机械提取，逻辑零变化）。
// 循环 import：从 ../index.js 反向 import measureDir（function 声明 + 运行时调用，安全）。
// 注：原依赖分析里的 Get/Resolve/Test 是 PowerShell here-string 的 Get-*/Resolve-*/Test-* 被正则误匹配，并非 JS 函数；本文件无 JS 死代码。
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { isUnsafePath, hasReparsePoint, realPathOf, isProtected } from './path-safety.js'
import { measureDir } from '../index.js'
// ───────────────────────────── 依赖探测（搬目录前查引用） ─────────────────────────────

/**
 * 查目录被谁引用、有没有进程在里面跑：
 * 服务、计划任务、开机自启、开始菜单快捷方式 + 正在运行的进程。
 * 这是"YULE 事件"的教训：搬/改一个程序安装目录前，必须先把引用查出来。
 * 探测失败返回空结果（不阻断流程）。
 */
export function detectDependencies(target) {
  const empty = { references: [], processes: [] }
  const needle = target.replace(/'/g, "''")
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$p = '${needle}'
$pl = $p.ToLower()
$refs = @()
$procs = @()
try {
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -and $_.PathName.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '服务'; name = $_.Name; detail = $_.PathName } }
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $_.Actions | Where-Object { $_.Execute -and $_.Execute.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '计划任务'; name = $t.TaskName; detail = $_.Execute } } }
  Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Where-Object { $_.Command -and $_.Command.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '开机自启'; name = $_.Name; detail = $_.Command } }
  $sh = New-Object -ComObject WScript.Shell
  @("$env:APPDATA\\Microsoft\\Windows\\Start Menu", "$env:ProgramData\\Microsoft\\Windows\\Start Menu") | ForEach-Object {
    Get-ChildItem $_ -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      if ($t -and $t.ToLower().Contains($pl)) { $script:refs += [pscustomobject]@{ kind = '开始菜单'; name = $_.BaseName; detail = $t } }
    }
  }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($pl) } | ForEach-Object { $script:procs += [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; path = $_.Path } }
} catch { }
@{ references = @($refs); processes = @($procs) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 25000, windowsHide: true },
    )
    const trimmed = String(output || '').trim()
    if (trimmed === '' || trimmed === 'null') return empty
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return empty
    const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
    const procs = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : []
    return {
      references: refs
        .filter((item) => item && item.kind)
        .map((item) => ({ kind: String(item.kind), name: String(item.name || ''), detail: String(item.detail || '') })),
      processes: procs
        .filter((item) => item && item.pid)
        .map((item) => ({ pid: Number(item.pid) || 0, name: String(item.name || ''), path: String(item.path || '') })),
    }
  } catch (error) {
    return empty
  }
}

/** 标记探测：Electron 应用、代码仓库、游戏、安装器等特征文件 */
export const MARKERS = [
  { file: 'app.asar', label: 'Electron 应用（内含 app.asar）' },
  { file: '.git', label: 'Git 仓库' },
  { file: 'package.json', label: 'Node 项目' },
  { file: 'steam_appid.txt', label: 'Steam 游戏' },
  { file: 'unins000.exe', label: 'Inno Setup 安装的程序' },
  { file: 'uninstall.exe', label: '带卸载器的程序' },
  { file: 'launcher', label: '带启动器目录' },
]

export function detectMarkers(target) {
  const found = []
  for (const marker of MARKERS) {
    try {
      if (existsSync(path.join(target, marker.file))) found.push(marker.label)
    } catch (error) {
      /* 读不到就跳过 */
    }
  }
  return found
}

/** 用 Sysinternals handle64 抓占用（找不到工具就跳过，不算失败） */
export function detectLocks(target, store) {
  const tool = path.join(store.dir, 'tools', 'handle64.exe')
  if (!existsSync(tool)) return { checked: false, holders: [] }
  try {
    const output = execFileSync(tool, ['-nobanner', target], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const seen = new Set()
    const holders = []
    for (const line of String(output || '').split('\n')) {
      const match = /^(.+?)\s+pid:\s*(\d+)\s+type:\s*\S+\s+\S+:\s*(.+)$/.exec(line.trim())
      if (!match) continue
      const key = `${match[1].trim()}|${match[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      holders.push({ process: match[1].trim(), pid: Number(match[2]) || 0 })
    }
    return { checked: true, holders }
  } catch (error) {
    return { checked: true, holders: [] }
  }
}

/** 综合探查：体积构成 + 引用 + 运行中进程 + 占用 + 特征 + 结论 */
export function inspectTarget(target, guard, store, options = {}) {
  const result = {
    path: target,
    bytes: 0,
    files: 0,
    dirs: 0,
    topTypes: [],
    references: [],
    processes: [],
    locks: [],
    locksChecked: false,
    markers: [],
    verdict: 'safe',
    reason: '',
  }
  // 2026-11-03 审计 T3：原先只做字符串比较，junction / \\?\ / UNC 写法会给出「可动」的相反结论。
  if (isUnsafePath(target)) {
    result.verdict = 'forbidden'
    result.reason = '路径写法不能安全判定（UNC / 设备路径），按不可动处理。'
    return result
  }
  const inspectResolved = path.resolve(target)
  if (hasReparsePoint(inspectResolved)) {
    result.verdict = 'forbidden'
    result.reason = '是 junction / 符号链接（重解析点），真实位置无法安全判定，按不可动处理。'
    return result
  }
  const inspectReal = realPathOf(inspectResolved)
  result.path = inspectReal === '' ? target : inspectReal
  if (inspectReal === '' || isProtected(inspectReal, guard)) {
    result.verdict = 'forbidden'
    result.reason = '在红线目录内（系统目录 / 插件源码 / 学习空间），不许动。'
    return result
  }

  const measured = measureDir(target, { maxEntries: 60000, deadlineMs: 5000 })
  result.bytes = Math.round(measured.bytes)
  result.files = measured.files

  // 顶层构成（只看两层，避免慢）
  const typeMap = new Map()
  try {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        result.dirs += 1
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase() || '（无扩展名）'
      const bucket = typeMap.get(ext) || { label: ext, files: 0, bytes: 0 }
      try {
        bucket.bytes += statSync(path.join(target, entry.name)).size
      } catch (error) {
        /* skip */
      }
      bucket.files += 1
      typeMap.set(ext, bucket)
    }
  } catch (error) {
    /* skip */
  }
  result.topTypes = [...typeMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)

  const deps = detectDependencies(target)
  result.references = deps.references
  result.processes = deps.processes
  result.markers = detectMarkers(target)

  if (options.locks) {
    const locks = detectLocks(target, store)
    result.locksChecked = locks.checked
    result.locks = locks.holders
  }

  if (result.references.length > 0) {
    result.verdict = 'caution'
    result.reason = `被 ${result.references.length} 处系统引用（服务/自启/计划任务/开始菜单），改名或搬走会让它们失效。`
  } else if (result.processes.length > 0) {
    result.verdict = 'caution'
    result.reason = `有 ${result.processes.length} 个进程正在这个目录里运行，先关掉。`
  } else if (result.locks.length > 0) {
    result.verdict = 'caution'
    result.reason = `有 ${result.locks.length} 个进程咬着里面的文件，改名会失败。`
  } else {
    result.verdict = 'safe'
    result.reason = '没查出引用、运行中进程或占用，可以动。'
  }
  return result
}

/** 系统体检（只读）：7 天错误数、开机耗时、自启未运行、已装软件数、开机时长 */
export function probeHealth() {
  const empty = { errors7d: 0, bootMs: 0, autoNotRunning: 0, installedApps: 0, uptimeHours: 0 }
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem
$bootMs = 0
try { $ev = Get-WinEvent -LogName 'Microsoft-Windows-Diagnostics-Performance/Operational' -MaxEvents 30 -ErrorAction Stop | Where-Object { $_.Id -eq 100 } | Select-Object -First 1; if ($ev) { $bootMs = [int]$ev.Properties[3].Value } } catch { }
$errors = 0
try { $errors = (Get-WinEvent -FilterHashtable @{LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-7)} -ErrorAction Stop | Measure-Object).Count } catch { }
$auto = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' })
$apps = 0
foreach ($r in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) { $apps += (Get-ChildItem $r -ErrorAction SilentlyContinue | Measure-Object).Count }
@{ errors7d = $errors; bootMs = $bootMs; autoNotRunning = $auto.Count; installedApps = $apps; uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) } | ConvertTo-Json -Compress
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    return {
      errors7d: Number(parsed.errors7d) || 0,
      bootMs: Number(parsed.bootMs) || 0,
      autoNotRunning: Number(parsed.autoNotRunning) || 0,
      installedApps: Number(parsed.installedApps) || 0,
      uptimeHours: Number(parsed.uptimeHours) || 0,
    }
  } catch (error) {
    return empty
  }
}

/** 事件日志归类（只读）：近 N 天系统/应用错误，按「来源 + 事件ID」聚合，附噪音判定 */
export function probeEvents(days = 7) {
  const empty = { systemTotal: 0, appTotal: 0, systemTop: [], appTop: [] }
  const span = Number(days) > 0 ? Number(days) : 7
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start = (Get-Date).AddDays(-${span})
$sys = @(Get-WinEvent -FilterHashtable @{LogName = 'System'; Level = 1, 2; StartTime = $start} -ErrorAction SilentlyContinue)
$app = @(Get-WinEvent -FilterHashtable @{LogName = 'Application'; Level = 1, 2; StartTime = $start} -ErrorAction SilentlyContinue)
function Get-TopGroups($events) {
  $events | Group-Object { "$($_.ProviderName)#$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 6 | ForEach-Object {
    $first = $_.Group[0]
    $msg = ''
    try { $msg = ($first.Message.Split([char]10)[0]).Trim() } catch { }
    [pscustomobject]@{ source = [string]$first.ProviderName; id = [int]$first.Id; count = [int]$_.Count; sample = $msg }
  }
}
@{ systemTotal = $sys.Count; appTotal = $app.Count; systemTop = @(Get-TopGroups $sys); appTop = @(Get-TopGroups $app) } | ConvertTo-Json -Compress -Depth 5
`
  const noise = (source, id) => {
    if (source === 'Microsoft-Windows-DistributedCOM' && id === 10010) return '噪音：DCOM 注册超时，通常不影响使用'
    if (source === 'Schannel' && id === 36876) return '噪音：证书验证失败，常见于代理/加速器'
    if (source === 'Microsoft-Windows-Security-SPP' && id === 8198) return '噪音：许可证激活检查失败'
    return ''
  }
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 45000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
    const map = (value) =>
      listify(value).map((item) => ({
        source: String(item.source || ''),
        id: Number(item.id) || 0,
        count: Number(item.count) || 0,
        sample: String(item.sample || ''),
        note: noise(String(item.source || ''), Number(item.id) || 0),
      }))
    return {
      systemTotal: Number(parsed.systemTotal) || 0,
      appTotal: Number(parsed.appTotal) || 0,
      systemTop: map(parsed.systemTop),
      appTop: map(parsed.appTop),
    }
  } catch (error) {
    return empty
  }
}

/** 应用残留探查（只读）：失效 PATH、幽灵服务、失效自启、失效计划任务 */
export function probeResidue() {
  const empty = { deadPath: [], ghostServices: [], deadStartup: [], deadTasks: [] }
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Resolve-Exe([string]$cmd) {
  if (-not $cmd) { return '' }
  $v = $cmd.Trim()
  if ($v.StartsWith('"')) {
    $end = $v.IndexOf('"', 1)
    $v = if ($end -gt 1) { $v.Substring(1, $end - 1) } else { $v.Substring(1) }
  } else {
    # 未加引号但路径含空格：先截到 .exe/.com/.bat/.cmd/.lnk 为止，别按空格切
    $m = [regex]::Match($v, '^(.*?\\.(exe|com|bat|cmd|lnk))(\\s|$)', 'IgnoreCase')
    if ($m.Success) { $v = $m.Groups[1].Value }
    elseif ($v -match '\\s') { $v = ($v -split '\\s+')[0] }
  }
  $v = [Environment]::ExpandEnvironmentVariables($v)
  if ($v -notmatch '^[A-Za-z]:\\\\') { return '' }
  return $v
}
function Test-Dead([string]$cmd) {
  $e = Resolve-Exe $cmd
  if (-not $e) { return $false }
  if (Test-Path $e) { return $false }
  if (Test-Path ($e + '.exe')) { return $false }
  return $true
}
$deadPath = @()
$allPath = ([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
foreach ($seg in ($allPath -split ';')) { $s = $seg.Trim(); if ($s -and $s -notmatch '^%' -and -not (Test-Path $s)) { $deadPath += $s } }
$deadPath = @($deadPath | Select-Object -Unique | Select-Object -First 15)
$ghostServices = @(Get-CimInstance Win32_Service | Where-Object { $_.PathName -and (Test-Dead $_.PathName) } | ForEach-Object { [pscustomobject]@{ name = $_.Name; path = $_.PathName } } | Select-Object -First 15)
$deadStartup = @(Get-CimInstance Win32_StartupCommand | Where-Object { $_.Command -and (Test-Dead $_.Command) } | ForEach-Object { [pscustomobject]@{ name = $_.Name; command = $_.Command } } | Select-Object -First 15)
$deadTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $t.Actions | Where-Object { $_.Execute -and (Test-Dead $_.Execute) } | ForEach-Object { [pscustomobject]@{ task = $t.TaskName; execute = $_.Execute } } } | Select-Object -First 15)
@{ deadPath = @($deadPath); ghostServices = @($ghostServices); deadStartup = @($deadStartup); deadTasks = @($deadTasks) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 45000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
    return {
      deadPath: listify(parsed.deadPath).map((item) => String(item)),
      ghostServices: listify(parsed.ghostServices).map((item) => ({ name: String(item.name || ''), path: String(item.path || '') })),
      deadStartup: listify(parsed.deadStartup).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
      deadTasks: listify(parsed.deadTasks).map((item) => ({ task: String(item.task || ''), execute: String(item.execute || '') })),
    }
  } catch (error) {
    return empty
  }
}

