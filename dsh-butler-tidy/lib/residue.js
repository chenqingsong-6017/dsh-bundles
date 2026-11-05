// 残留处置（只动用户级、可撤销）：从 index.js 机械提取，逻辑零变化。
// 循环 import：从 ../index.js 反向 import appendLog/tryWriteManifest（function 声明 + 运行时调用，安全）。
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { stampOf } from './format.js'
import { appendLog, tryWriteManifest } from '../index.js'
// ───────────────────── 残留处置（只动用户级、可撤销） ─────────────────────

/** 统一跑一段 PowerShell 并解析 JSON 输出 */
export function runPowerShellJson(script, timeout = 45000) {
  const wrapped = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${script}
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { encoding: 'utf8', timeout, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return undefined
    return JSON.parse(raw)
  } catch (error) {
    return undefined
  }
}

export const RESIDUE_HELPERS = `
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
`

/** 分作用域探查残留：用户级（可移除）/ 系统级（需管理员） */
export function probeResidueScoped() {
  const script = `${RESIDUE_HELPERS}
$userPathDead = @()
$u = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($seg in ($u -split ';')) { $s = $seg.Trim(); if ($s -and -not (Test-Path $s)) { $userPathDead += $s } }
$userPathDuplicates = @()
$seenUser = @{}
foreach ($seg in ($u -split ';')) { $s = $seg.Trim(); if (-not $s) { continue }; $k = $s.ToLower(); if ($seenUser.ContainsKey($k)) { $userPathDuplicates += $s } else { $seenUser[$k] = $true } }
$machinePathDead = @()
$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
foreach ($seg in ($m -split ';')) { $s = $seg.Trim(); if ($s -and -not (Test-Path $s)) { $machinePathDead += $s } }
$machinePathDuplicates = @()
$seenMachine = @{}
foreach ($seg in ($m -split ';')) { $s = $seg.Trim(); if (-not $s) { continue }; $k = $s.ToLower(); if ($seenMachine.ContainsKey($k)) { $machinePathDuplicates += $s } else { $seenMachine[$k] = $true } }
$userRunDead = @()
$hkcu = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($hkcu) { foreach ($p in $hkcu.PSObject.Properties) { if ($p.Name -like 'PS*') { continue }; if ($p.Value -and (Test-Dead $p.Value)) { $userRunDead += [pscustomobject]@{ name = $p.Name; command = $p.Value } } } }
$machineRunDead = @()
$hklm = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($hklm) { foreach ($p in $hklm.PSObject.Properties) { if ($p.Name -like 'PS*') { continue }; if ($p.Value -and (Test-Dead $p.Value)) { $machineRunDead += [pscustomobject]@{ name = $p.Name; command = $p.Value } } } }
$deadTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $t.Actions | Where-Object { $_.Execute -and (Test-Dead $_.Execute) } | ForEach-Object { [pscustomobject]@{ task = $t.TaskName; path = $t.TaskPath; execute = $_.Execute } } } | Select-Object -First 15)
@{ userPathDead = @($userPathDead); userPathDuplicates = @($userPathDuplicates); machinePathDead = @($machinePathDead); machinePathDuplicates = @($machinePathDuplicates); userRunDead = @($userRunDead); machineRunDead = @($machineRunDead); deadTasks = @($deadTasks) } | ConvertTo-Json -Compress -Depth 4
`
  const parsed = runPowerShellJson(script) || {}
  const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  return {
    userPathDead: listify(parsed.userPathDead).map((item) => String(item)),
    userPathDuplicates: listify(parsed.userPathDuplicates).map((item) => String(item)),
    machinePathDead: listify(parsed.machinePathDead).map((item) => String(item)),
    machinePathDuplicates: listify(parsed.machinePathDuplicates).map((item) => String(item)),
    userRunDead: listify(parsed.userRunDead).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
    machineRunDead: listify(parsed.machineRunDead).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
    deadTasks: listify(parsed.deadTasks).map((item) => ({ task: String(item.task || ''), path: String(item.path || ''), execute: String(item.execute || '') })),
  }
}

/** 残留方案：用户级可移除项 + 系统级需管理员项 */
export function doPlanResidue(args, guard, store) {
  const base = {
    kind: 'residue',
    target: '',
    rule: '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    preview: [],
    candidates: [],
    renames: [],
    dupeGroups: [],
    residueItems: [],
    omitted: 0,
    truncated: false,
    hint: '',
  }
  const scoped = probeResidueScoped()
  const items = []
  for (const item of scoped.userPathDead) items.push({ kind: '用户 PATH', name: item, scope: 'user' })
  for (const item of scoped.userPathDuplicates) items.push({ kind: '用户 PATH（重复）', name: item, scope: 'user' })
  for (const item of scoped.userRunDead) items.push({ kind: '用户自启', name: item.name, scope: 'user' })
  for (const item of scoped.machinePathDead) items.push({ kind: '系统 PATH', name: item, scope: 'admin' })
  for (const item of scoped.machinePathDuplicates) items.push({ kind: '系统 PATH（重复）', name: item, scope: 'admin' })
  for (const item of scoped.machineRunDead) items.push({ kind: '系统自启', name: item.name, scope: 'admin' })
  for (const item of scoped.deadTasks) items.push({ kind: '计划任务', name: item.task, scope: 'admin' })
  const userCount = items.filter((item) => item.scope === 'user').length
  return {
    ...base,
    residueItems: items,
    totalFiles: userCount,
    hint:
      items.length === 0
        ? '没有发现残留，干净。'
        : `可直接移除的用户级残留 ${userCount} 条；其余 ${items.length - userCount} 条属系统级（服务/系统任务/系统 PATH），需要管理员权限，插件只报告不动手。`,
  }
}

/** 执行残留移除：只处理用户 PATH 与用户自启，全部写清单可撤销 */
export function doApplyResidue(args, guard, store) {
  const base = {
    applied: false,
    kind: 'residue',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    blockers: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '改注册表/环境变量前必须先看清单；确认后传 confirm:true。' }
  }
  // 改前备份：把 HKCU 的 Run 与 Environment 两个键导出成 .reg，出事能还原
  const backupDir = path.join(store.dir, 'tools', 'backups')
  let backupFile = ''
  try {
    mkdirSync(backupDir, { recursive: true })
    const stamp = stampOf()
    const runBackup = path.join(backupDir, `run-${stamp}.reg`)
    const envBackup = path.join(backupDir, `env-${stamp}.reg`)
    execFileSync('reg.exe', ['export', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', runBackup, '/y'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    execFileSync('reg.exe', ['export', 'HKCU\\Environment', envBackup, '/y'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    backupFile = path.dirname(runBackup)
  } catch (error) {
    backupFile = ''
  }
  const scoped = probeResidueScoped()
  const wantedRun = Array.isArray(args.runNames) && args.runNames.length > 0 ? args.runNames : scoped.userRunDead.map((item) => item.name)
  const dropPath = args.dropUserPathDead !== false
  const script = `${RESIDUE_HELPERS}
$dropPath = ${dropPath ? '$true' : '$false'}
$wantedRun = @(${wantedRun.map((name) => `'${String(name).replace(/'/g, "''")}'`).join(',')})
$oldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$removedPath = @()
if ($dropPath) {
  $kept = @()
  $seen = @{}
  foreach ($seg in ($oldUserPath -split ';')) {
    $s = $seg.Trim(); if (-not $s) { continue }
    $k = $s.ToLower()
    if ($seen.ContainsKey($k)) { $removedPath += $s; continue }
    $seen[$k] = $true
    if (Test-Path $s) { $kept += $s } else { $removedPath += $s }
  }
  if ($removedPath.Count -gt 0) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User') }
}
$removedRun = @()
foreach ($name in $wantedRun) {
  $val = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $name -ErrorAction SilentlyContinue).$name
  if ($val) { Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $name -ErrorAction SilentlyContinue; $removedRun += [pscustomobject]@{ name = $name; value = $val } }
}
@{ oldUserPath = $oldUserPath; removedPath = @($removedPath); removedRun = @($removedRun) } | ConvertTo-Json -Compress -Depth 4
`
  const parsed = runPowerShellJson(script) || {}
  const removedPath = Array.isArray(parsed.removedPath) ? parsed.removedPath : parsed.removedPath ? [parsed.removedPath] : []
  const removedRun = Array.isArray(parsed.removedRun) ? parsed.removedRun : parsed.removedRun ? [parsed.removedRun] : []
  const records = []
  if (removedPath.length > 0) records.push({ type: 'path', oldValue: String(parsed.oldUserPath || '') })
  for (const item of removedRun) records.push({ type: 'run', name: String(item.name || ''), oldValue: String(item.value || '') })

  let manifest = ''
  let manifestError = ''
  if (records.length > 0) {
    const written = tryWriteManifest(store, 'residue', { at: new Date().toISOString(), records })
    manifest = written.file
    manifestError = written.error
  }
  if (manifestError !== '') base.errors = [...(base.errors || []), `清单写失败：${manifestError}`]
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'residue', removedPath: removedPath.length, removedRun: removedRun.length })
  const total = removedPath.length + removedRun.length
  return {
    ...base,
    applied: true,
    moved: total,
    manifest,
    ...(manifestError !== '' ? { code: 'MANIFEST_WRITE_FAILED' } : {}),
    hint:
      manifestError !== ''
        ? `已移除用户级残留 ${total} 条，但清单写失败（${manifestError}）→ 这次无法用 tidy_undo 恢复${backupFile ? `；注册表备份在 ${backupFile}` : ''}，请人工核对。`
        : total > 0
          ? `已移除用户级残留 ${total} 条（PATH ${removedPath.length} · 自启 ${removedRun.length}），清单可 tidy_undo 恢复${backupFile ? `；改前已备份注册表到 ${backupFile}` : ''}。`
          : '没有可移除的用户级残留。',
  }
}

