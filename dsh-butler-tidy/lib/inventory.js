// 安装/卸载台账（inventory）子系统：从 index.js 机械提取，逻辑零变化。
// 循环 import 说明：本文件从 ../index.js 反向 import measureDir/detectLocks/readText。
//   这三个都是 function 声明（ESM 提升），且只在工具运行时被调用、不在本模块求值时调用，
//   故循环安全。未来若要消除循环，把这三者抽到 lib/fs-tools.js 即可。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteText as atomicWriteStore } from '../../_lib/store.mjs'
import { text, fmtSize, fmtCount, pad2 } from './format.js'
import { norm, isUnder, lockHint, isProtected } from './path-safety.js'
import { measureDir, readText } from '../index.js'
import { detectLocks } from './probe.js'
// ───────────────────────────── 安装 / 卸载台账 ─────────────────────────────
//
// 台账 = storeDir/inventory.json（程序用）+ inventory.md（人看）。
// 四个工具只写这两个文件：不删用户文件、不改注册表、不停服务。
//   装完 → inventory_add；卸前 → plan_uninstall（只读预演）；卸后 → inventory_check（只读复核）。
// 台账解析失败时一律拒绝写入，并报出文件路径 —— 防止把用户手工改坏的文件静默清空。

export const INVENTORY_VERSION = 1
export const INVENTORY_KINDS = ['installer', 'portable', 'dsh-plugin', 'dev-tool']
export const INVENTORY_KIND_LABEL = {
  installer: '安装包',
  portable: '便携版',
  'dsh-plugin': 'DSH 插件',
  'dev-tool': '开发工具',
}
export const REF_FIELDS = ['services', 'startup', 'tasks', 'shortcuts', 'pathEntries', 'registryKeys']
export const REF_FIELD_LABEL = {
  services: '服务',
  startup: '开机自启',
  tasks: '计划任务',
  shortcuts: '开始菜单',
  pathEntries: 'PATH',
  registryKeys: '注册表键',
}

export function inventoryPaths(store) {
  return { jsonFile: path.join(store.dir, 'inventory.json'), mdFile: path.join(store.dir, 'inventory.md') }
}

export function emptyRefs() {
  const refs = {}
  for (const field of REF_FIELDS) refs[field] = []
  return refs
}

export function emptyInventoryEntry() {
  return {
    id: '',
    name: '',
    kind: 'installer',
    path: '',
    version: '',
    source: '',
    uninstallCmd: '',
    installedAt: '',
    updatedAt: '',
    dataDirs: [],
    refs: emptyRefs(),
    notes: '',
    status: 'active',
    removedAt: '',
    stale: false,
  }
}

/** 引用统一成 {name, detail}，避免 schema 出现可选字段 */
export function toRefItems(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ name: String(item.name || ''), detail: String(item.detail || '') }))
}

/** 把磁盘上的台账条目补齐成完整结构（旧版本/手改过的也不炸） */
export function normalizeEntry(raw) {
  const entry = emptyInventoryEntry()
  if (!raw || typeof raw !== 'object') return entry
  const str = (value) => (typeof value === 'string' ? value : '')
  entry.id = str(raw.id)
  entry.name = str(raw.name)
  entry.kind = INVENTORY_KINDS.includes(raw.kind) ? raw.kind : 'installer'
  entry.path = str(raw.path)
  entry.version = str(raw.version)
  entry.source = str(raw.source)
  entry.uninstallCmd = str(raw.uninstallCmd)
  entry.installedAt = str(raw.installedAt)
  entry.updatedAt = str(raw.updatedAt)
  entry.dataDirs = Array.isArray(raw.dataDirs)
    ? raw.dataDirs.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const refs = raw.refs && typeof raw.refs === 'object' ? raw.refs : {}
  entry.refs = emptyRefs()
  for (const field of REF_FIELDS) entry.refs[field] = toRefItems(refs[field])
  entry.notes = str(raw.notes)
  entry.status = raw.status === 'removed' ? 'removed' : 'active'
  entry.removedAt = str(raw.removedAt)
  entry.stale = Boolean(raw.stale)
  return entry
}

export function refCountOf(refs) {
  if (!refs) return 0
  return REF_FIELDS.reduce((sum, field) => sum + (Array.isArray(refs[field]) ? refs[field].length : 0), 0)
}

/** 六类引用摊平成一行行的 {kind, field, name, detail} */
export function flattenRefs(refs) {
  const rows = []
  for (const field of REF_FIELDS) {
    for (const item of Array.isArray(refs?.[field]) ? refs[field] : []) {
      rows.push({ field, kind: REF_FIELD_LABEL[field], name: String(item.name || ''), detail: String(item.detail || '') })
    }
  }
  return rows
}

export function refCountLine(refs) {
  const parts = REF_FIELDS.map((field) => REF_FIELD_LABEL[field] + ' ' + (Array.isArray(refs?.[field]) ? refs[field].length : 0))
  return parts.join(' · ') + '（共 ' + refCountOf(refs) + ' 处）'
}

export function fmtDateText(value, withTime = true) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
  if (!withTime) return day
  return day + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

export function shortenText(value, max = 120) {
  const text = String(value || '')
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * 六类引用采集（只读）：服务 / 开机自启 / 计划任务 / 开始菜单 / PATH / 注册表卸载键。
 * 沿用本插件既有的 PowerShell 采集写法；失败返回 ok:false，不阻断调用方。
 */
export function probeInstallRefs(target) {
  const empty = { ok: false, refs: emptyRefs(), processes: [] }
  if (typeof target !== 'string' || target.trim() === '') return empty
  let needle
  try {
    needle = path.resolve(target.trim())
  } catch (error) {
    return empty
  }
  const escaped = needle.replace(/'/g, "''")
  const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$p = '${escaped}'
$pl = $p.ToLower()
$script:services = @()
$script:startup = @()
$script:tasks = @()
$script:shortcuts = @()
$script:pathEntries = @()
$script:registryKeys = @()
$script:procs = @()
try {
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -and $_.PathName.ToLower().Contains($pl) } | ForEach-Object { $script:services += [pscustomobject]@{ name = [string]$_.Name; detail = [string]$_.PathName } }
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
    $t = $_
    $t.Actions | Where-Object { $_.Execute -and $_.Execute.ToLower().Contains($pl) } | ForEach-Object {
      $script:tasks += [pscustomobject]@{ name = [string]$t.TaskName; detail = [string]$_.Execute }
    }
  }
  Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Where-Object { $_.Command -and $_.Command.ToLower().Contains($pl) } | ForEach-Object { $script:startup += [pscustomobject]@{ name = [string]$_.Name; detail = [string]$_.Command } }
  $sh = New-Object -ComObject WScript.Shell
  @("$env:APPDATA\\Microsoft\\Windows\\Start Menu", "$env:ProgramData\\Microsoft\\Windows\\Start Menu") | ForEach-Object {
    $startDir = $_
    Get-ChildItem $startDir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      $shortcutPath = $_.FullName
      $shortcut = $sh.CreateShortcut($shortcutPath)
      if ($shortcut.TargetPath -and $shortcut.TargetPath.ToLower().Contains($pl)) {
        $script:shortcuts += [pscustomobject]@{ name = [string]$_.BaseName; detail = [string]$shortcut.TargetPath }
      }
    }
  }
  foreach ($scope in @('User', 'Machine')) {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if (-not $value) { continue }
    $label = if ($scope -eq 'User') { '用户 PATH' } else { '系统 PATH' }
    foreach ($seg in ($value -split ';')) {
      $s = $seg.Trim()
      if ($s -and $s.ToLower().Contains($pl)) { $script:pathEntries += [pscustomobject]@{ name = $label; detail = $s } }
    }
  }
  foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $key = $_
      $props = $null
      try { $props = Get-ItemProperty $key.PSPath -ErrorAction Stop } catch { return }
      $hit = $false
      foreach ($field in @($props.InstallLocation, $props.UninstallString, $props.DisplayIcon, $props.InstallPath)) {
        if ($field -and ([string]$field).ToLower().Contains($pl)) { $hit = $true }
      }
      if (-not $hit) { return }
      $display = if ($props.DisplayName) { [string]$props.DisplayName } else { [string]$key.PSChildName }
      $where = ([string]$key.PSPath).Replace('Microsoft.PowerShell.Core\\Registry::', '')
      $script:registryKeys += [pscustomobject]@{ name = $display; detail = $where }
    }
  }
  foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $key = $_
      $value = $null
      try { $value = (Get-ItemProperty $key.PSPath -ErrorAction Stop).'(default)' } catch { return }
      if ($value -and ([string]$value).ToLower().Contains($pl)) {
        $script:registryKeys += [pscustomobject]@{ name = [string]$key.PSChildName; detail = [string]$value }
      }
    }
  }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($pl) } | ForEach-Object { $script:procs += [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName; path = [string]$_.Path } }
} catch { }
@{ services = @($script:services); startup = @($script:startup); tasks = @($script:tasks); shortcuts = @($script:shortcuts); pathEntries = @($script:pathEntries); registryKeys = @($script:registryKeys); processes = @($script:procs) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '' || raw === 'null') return empty
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return empty
    const refs = emptyRefs()
    for (const field of REF_FIELDS) refs[field] = toRefItems(parsed[field])
    const rawProcs = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : []
    const processes = rawProcs
      .filter((item) => item && item.pid)
      .map((item) => ({ pid: Number(item.pid) || 0, name: String(item.name || ''), path: String(item.path || '') }))
    return { ok: true, refs, processes }
  } catch (error) {
    return empty
  }
}

/** 读台账；解析失败只报错、绝不返回可写对象（防止覆盖原文件） */
export function readInventory(store) {
  const { jsonFile } = inventoryPaths(store)
  const empty = { version: INVENTORY_VERSION, nextId: 1, entries: [] }
  if (!existsSync(jsonFile)) return { file: jsonFile, existed: false, data: empty }
  let raw
  try {
    raw = readText(jsonFile)
  } catch (error) {
    return { file: jsonFile, existed: true, error: '台账文件读不出来（' + lockHint(error) + '）。' }
  }
  if (String(raw).trim() === '') {
    return { file: jsonFile, existed: true, error: '台账文件是空的（可能被写坏）。' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { file: jsonFile, existed: true, error: '台账 JSON 解析失败：' + error.message }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    return { file: jsonFile, existed: true, error: '台账结构不对：缺少 entries 数组。' }
  }
  const entries = parsed.entries.map(normalizeEntry)
  const nextId = Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : entries.length + 1
  return { file: jsonFile, existed: true, data: { version: INVENTORY_VERSION, nextId, entries } }
}

/**
 * 原子写：交给共享内核 `_lib/store.mjs`（唯一临时名 + fsync + fail-closed + 机器可读错误码）。
 * 这里写的是台账 json/md（给人看的清单），所以**不留 .bak**：台账目录里凭空多文件是污染。
 * 旧实现在 rename 失败时只清理临时文件并原样抛错，也不 fsync——内核这两点都补齐了。
 */
export function atomicWriteText(file, content) {
  atomicWriteStore(file, content, { backup: false })
}

export function writeInventory(store, data) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const payload = { version: INVENTORY_VERSION, nextId: data.nextId, entries: data.entries }
  atomicWriteText(jsonFile, JSON.stringify(payload, null, 2))
  atomicWriteText(mdFile, renderInventoryMarkdown(payload))
  return { jsonFile, mdFile }
}

/** inventory.md：给人看的视图，每次写台账后重新生成 */
export function renderInventoryMarkdown(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : []
  const active = entries.filter((entry) => entry.status !== 'removed')
  const removed = entries.filter((entry) => entry.status === 'removed')
  const stale = entries.filter((entry) => entry.stale)
  const lines = []
  lines.push('# 安装 / 卸载台账')
  lines.push('')
  lines.push('> 由 dsh-butler-tidy 的台账工具维护：inventory_add 登记、plan_uninstall 卸前预演、inventory_check 卸后复核。')
  lines.push('> 生成时间：' + fmtDateText(new Date()))
  lines.push('')
  lines.push('共 ' + entries.length + ' 条：在用 ' + active.length + ' · 已卸载 ' + removed.length + ' · 待核对 ' + stale.length)
  lines.push('')

  const writeSection = (title, list, options) => {
    lines.push('## ' + title + '（' + list.length + '）')
    lines.push('')
    if (list.length === 0) {
      lines.push('（没有）')
      lines.push('')
      return
    }
    for (const entry of list) {
      const version = entry.version ? ' v' + entry.version : ''
      lines.push('### ' + entry.name + version)
      lines.push('')
      lines.push('- 编号：' + entry.id)
      lines.push('- 类型：' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind))
      lines.push('- 路径：' + (entry.path || '（未填）'))
      if (entry.source) lines.push('- 来源：' + entry.source)
      if (entry.uninstallCmd) lines.push('- 卸载命令：' + entry.uninstallCmd)
      if (entry.installedAt) lines.push('- 登记时间：' + fmtDateText(entry.installedAt))
      if (options && options.removed && entry.removedAt) lines.push('- 卸载时间：' + fmtDateText(entry.removedAt))
      if (entry.stale) lines.push('- 状态：待核对（记录与磁盘对不上，跑 inventory_check 复核）')
      if (entry.dataDirs.length > 0) {
        lines.push('- 数据目录：')
        for (const dir of entry.dataDirs) lines.push('  - ' + dir)
      }
      lines.push('- 关联引用：' + refCountLine(entry.refs))
      const refRows = flattenRefs(entry.refs)
      for (const row of refRows.slice(0, 6)) {
        lines.push('  - ' + row.kind + '：' + row.name + (row.detail ? '（' + shortenText(row.detail) + '）' : ''))
      }
      if (refRows.length > 6) lines.push('  - … 另有 ' + (refRows.length - 6) + ' 处引用')
      if (entry.notes) lines.push('- 备注：' + entry.notes)
      lines.push('')
    }
  }

  writeSection('在用', active, { removed: false })
  writeSection('已卸载（历史记录）', removed, { removed: true })
  return lines.join('\n')
}

/** 台账里按编号 / 名字 / 路径找条目（精确优先，其次包含） */
export function findInventoryEntries(entries, query) {
  const needle = String(query || '').trim()
  if (needle === '') return []
  const lower = needle.toLowerCase()
  const exact = []
  const nameHit = []
  const pathHit = []
  for (const entry of entries) {
    const name = String(entry.name || '').toLowerCase()
    const id = String(entry.id || '').toLowerCase()
    const target = String(entry.path || '').toLowerCase()
    if (name === lower || id === lower) exact.push(entry)
    else if (name.includes(lower)) nameHit.push(entry)
    else if (target.includes(lower)) pathHit.push(entry)
  }
  return [...exact, ...nameHit, ...pathHit]
}

/** 生成下一个编号（inv-0001 起） */
export function nextInventoryId(data) {
  const used = new Set(data.entries.map((entry) => entry.id))
  let seq = Number.isInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1
  while (used.has('inv-' + String(seq).padStart(4, '0'))) seq += 1
  data.nextId = seq + 1
  return 'inv-' + String(seq).padStart(4, '0')
}

/** 登记一条：同名视为更新（只覆盖本次给的可选字段），同路径换个名字视为冲突 */
export function doInventoryAdd(args, store) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const base = {
    ok: false,
    created: false,
    id: '',
    entry: emptyInventoryEntry(),
    refsScanned: false,
    refCount: 0,
    total: 0,
    inventoryFile: jsonFile,
    markdownFile: mdFile,
    error: '',
    hint: '',
  }
  const fail = (message, hint, code) => ({ ...base, code: code || 'INVENTORY_ERROR', error: message, hint })
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (name === '') {
    return fail('没给名称（name）。', '登记一条需要 name + kind + path，例如 name="某软件"、kind="installer"、path="D:\\某软件"。', 'EMPTY_NAME')
  }
  const kind = typeof args?.kind === 'string' ? args.kind.trim() : 'installer'
  if (!INVENTORY_KINDS.includes(kind)) {
    return fail('类型取值不对：' + (kind || '（空）'), 'kind 只能是 installer / portable / dsh-plugin / dev-tool 之一。', 'INVALID_KIND')
  }
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (rawPath === '') {
    return fail('没给安装路径（path）。', '把程序主体所在目录或可执行文件写进 path，例如 D:\\某软件；登记前先确认它已经装好。', 'EMPTY_PATH')
  }
  let absPath
  try {
    absPath = path.resolve(rawPath)
  } catch (error) {
    return fail('路径看不懂：' + rawPath, '请给绝对路径，例如 D:\\某软件。', 'BAD_PATH')
  }
  if (!existsSync(absPath)) {
    return fail('这个路径不存在：' + absPath, '登记前先确认程序已经装好；路径写错就改 path，便携包请指到解压后的目录。', 'PATH_MISSING')
  }
  const spec = readInventory(store)
  if (spec.error) {
    return fail(spec.error, '台账解析失败时不会覆盖原文件。请先备份或修好 ' + spec.file + '，再重试登记。', 'INVENTORY_UNREADABLE')
  }
  const data = spec.data
  const lowerName = name.toLowerCase()
  const sameName = data.entries.find((entry) => String(entry.name || '').toLowerCase() === lowerName)
  const samePath = data.entries.find(
    (entry) => entry.path && norm(entry.path) === norm(absPath) && String(entry.name || '').toLowerCase() !== lowerName,
  )
  if (samePath) {
    return fail(
      '这个路径已经登记在「' + samePath.name + '」（' + samePath.id + '）名下。',
      '一个路径只记一条：要么改用已有条目，要么先确认旧条目已卸载（inventory_check 的 markRemoved）后再登记新的。',
      'PATH_CONFLICT',
    )
  }
  const dataDirs = Array.isArray(args?.dataDirs)
    ? args.dataDirs.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => path.resolve(item.trim()))
    : undefined
  const scanRefs = args?.scanRefs !== false
  let probe = { ok: false, refs: emptyRefs(), processes: [] }
  if (scanRefs) probe = probeInstallRefs(absPath)
  const now = new Date().toISOString()
  const textField = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  let entry
  let created
  if (sameName) {
    entry = sameName
    created = false
    entry.kind = kind
    entry.path = absPath
    const version = textField(args?.version)
    if (version !== undefined) entry.version = version
    const source = textField(args?.source)
    if (source !== undefined) entry.source = source
    const uninstallCmd = textField(args?.uninstallCmd)
    if (uninstallCmd !== undefined) entry.uninstallCmd = uninstallCmd
    const notes = textField(args?.notes)
    if (notes !== undefined) entry.notes = notes
    if (dataDirs !== undefined) entry.dataDirs = dataDirs
    if (scanRefs && probe.ok) entry.refs = probe.refs
    entry.updatedAt = now
    entry.stale = false
    if (entry.status === 'removed') {
      entry.status = 'active'
      entry.removedAt = ''
    }
  } else {
    created = true
    entry = emptyInventoryEntry()
    entry.id = nextInventoryId(data)
    entry.name = name
    entry.kind = kind
    entry.path = absPath
    entry.version = textField(args?.version) || ''
    entry.source = textField(args?.source) || ''
    entry.uninstallCmd = textField(args?.uninstallCmd) || ''
    entry.installedAt = now
    entry.updatedAt = now
    entry.dataDirs = dataDirs || []
    entry.refs = probe.ok ? probe.refs : emptyRefs()
    entry.notes = textField(args?.notes) || ''
    data.entries.push(entry)
  }
  try {
    writeInventory(store, data)
  } catch (error) {
    return fail('台账写不进去：' + lockHint(error) + '（' + jsonFile + '）', '检查数据目录是否可写；台账原文件没被动过，修好后重试。', 'INVENTORY_WRITE_FAILED')
  }
  const refsScanned = Boolean(scanRefs && probe.ok)
  let hint = created
    ? '装完就记，卸前用 plan_uninstall 预演一遍；确认卸载完再用 inventory_check 复核。'
    : '已按本次参数更新已有登记（没给的字段保持原值）。'
  if (scanRefs && !probe.ok) hint = hint + ' 引用扫描没跑成，登记里暂缺引用信息，稍后可重跑 inventory_add 补上。'
  return {
    ...base,
    ok: true,
    created,
    id: entry.id,
    entry,
    refsScanned,
    refCount: refCountOf(entry.refs),
    total: data.entries.length,
    error: '',
    hint,
  }
}

/** 列出条目（默认只在用；可按类型 / 状态过滤） */
export function doInventoryList(args, store) {
  const { jsonFile } = inventoryPaths(store)
  const emptyResult = (error, hint, code) => ({
    storeDir: store.dir,
    total: 0,
    shown: 0,
    omitted: 0,
    activeCount: 0,
    removedCount: 0,
    staleCount: 0,
    storeBytes: 0,
    entries: [],
    inventoryFile: jsonFile,
    error,
    hint,
    ...(code ? { code } : {}),
  })
  const spec = readInventory(store)
  if (spec.error) return emptyResult(spec.error, '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。', 'INVENTORY_UNREADABLE')
  const kind = typeof args?.kind === 'string' ? args.kind.trim() : ''
  if (kind !== '' && !INVENTORY_KINDS.includes(kind)) {
    return emptyResult('类型筛选值不对：' + kind, 'kind 只能是 installer / portable / dsh-plugin / dev-tool。', 'INVALID_KIND')
  }
  const status = args?.status === 'removed' ? 'removed' : args?.status === 'all' ? 'all' : 'active'
  const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20
  const all = spec.data.entries
  const matched = all.filter((entry) => {
    if (status !== 'all' && entry.status !== status) return false
    if (kind !== '' && entry.kind !== kind) return false
    return true
  })
  const measured = existsSync(store.dir) ? measureDir(store.dir, { maxEntries: 6000, deadlineMs: 1500 }) : { bytes: 0 }
  const shown = matched.slice(0, limit)
  const activeCount = all.filter((entry) => entry.status !== 'removed').length
  const removedCount = all.length - activeCount
  const staleCount = all.filter((entry) => entry.stale).length
  let hint = ''
  if (all.length === 0) hint = '台账还是空的。装完新东西用 inventory_add 登记（name / kind / path 必填）。'
  else if (matched.length > shown.length) {
    hint = '还有 ' + (matched.length - shown.length) + ' 条未列出：调大 limit，或用 status="all" 看历史记录。'
  } else if (status === 'active' && removedCount > 0) {
    hint = '另有 ' + removedCount + ' 条已卸载的历史记录，要看用 status="all"。'
  }
  return {
    ...emptyResult('', hint),
    total: matched.length,
    shown: shown.length,
    omitted: matched.length - shown.length,
    activeCount,
    removedCount,
    staleCount,
    storeBytes: Math.round(measured.bytes),
    entries: shown,
  }
}

/** 卸前建议步骤：按条目实际查到的引用 / 进程 / 数据目录生成，不执行任何动作 */
export function buildUninstallSteps(entry, info) {
  const steps = []
  if (info.processes.length > 0) {
    steps.push(
      '先关掉正在运行的程序：' +
        info.processes
          .slice(0, 6)
          .map((item) => item.name + '(pid ' + item.pid + ')')
          .join('、') +
        (info.processes.length > 6 ? ' 等 ' + info.processes.length + ' 个' : ''),
    )
  }
  if (entry.uninstallCmd) {
    steps.push('运行卸载命令：' + entry.uninstallCmd)
  } else if (entry.kind === 'portable') {
    steps.push('便携版一般没有卸载器：确认不保留配置后直接删安装目录（建议先备份数据目录）。')
  } else {
    steps.push('没有登记卸载命令：去「设置 → 应用」或程序目录里找卸载器；找不到就按便携版处理，手动删目录。')
  }
  for (const field of REF_FIELDS) {
    const items = Array.isArray(info.refs[field]) ? info.refs[field] : []
    if (items.length === 0) continue
    const names = items
      .slice(0, 5)
      .map((item) => item.name || item.detail)
      .join('、')
    const suffix = items.length > 5 ? ' 等 ' + items.length + ' 处' : ''
    if (field === 'services') steps.push('停掉并删除服务（需管理员）：' + names + suffix)
    else if (field === 'tasks') steps.push('删除计划任务：' + names + suffix)
    else if (field === 'startup') steps.push('删除开机自启项：' + names + suffix)
    else if (field === 'shortcuts') steps.push('删掉开始菜单快捷方式：' + names + suffix)
    else if (field === 'pathEntries') steps.push('清掉 PATH 里的相关段（用户级可自己改，系统级需管理员）：' + names + suffix)
    else steps.push('删除注册表卸载键（需管理员；删前先导出 .reg 备份）：' + names + suffix)
  }
  if (info.refsSource === 'recorded') {
    steps.push('注意：本次引用清单来自登记时的记录，不是现扫的；动手前建议再跑一次 plan_uninstall。')
  }
  if (info.dataDirs.length > 0) {
    const remaining = info.dataDirs.filter((item) => item.exists)
    if (remaining.length > 0) {
      steps.push(
        '决定数据目录去留：' +
          remaining.map((item) => item.path + '（' + fmtSize(item.bytes) + '）').join('、') +
          '。里面有配置 / 存档 / 许可证就先备份。',
      )
    } else {
      steps.push('数据目录已经都不在了，无需处理。')
    }
  }
  if (info.redlineNotes.length > 0) steps.push('红线提醒：' + info.redlineNotes[0])
  steps.push('删完跑 inventory_check 复核残留；确认干净的条目用 inventory_check 的 markRemoved 收进历史。')
  return steps
}

/** 卸前预演：只读，不删任何东西 */
export function doPlanUninstall(args, store, guard) {
  const { jsonFile } = inventoryPaths(store)
  const base = {
    found: false,
    query: '',
    matches: 0,
    entry: emptyInventoryEntry(),
    targetExists: false,
    targetBytes: 0,
    targetFiles: 0,
    targetTruncated: false,
    refs: emptyRefs(),
    refCount: 0,
    refsScanned: false,
    refsSource: 'none',
    dataDirs: [],
    dataBytes: 0,
    processes: [],
    locks: [],
    locksChecked: false,
    redlineNotes: [],
    steps: [],
    removesNothing: true,
    notice: '这是只读预演：不删文件、不改注册表、不停服务。',
    inventoryFile: jsonFile,
    error: '',
    hint: '',
  }
  const nameQuery = typeof args?.name === 'string' ? args.name.trim() : ''
  const pathQuery = typeof args?.path === 'string' ? args.path.trim() : ''
  const query = nameQuery || pathQuery
  if (query === '') {
    return { ...base, code: 'EMPTY_QUERY', error: '没给要预演的对象。', hint: '用 name（台账里的名字或编号）或 path（安装路径）指定一条，例如 name="某软件"。' }
  }
  const spec = readInventory(store)
  if (spec.error) {
    return { ...base, code: 'INVENTORY_UNREADABLE', query, error: spec.error, hint: '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。' }
  }
  const matched = findInventoryEntries(spec.data.entries, query)
  if (matched.length === 0) {
    return {
      ...base,
      query,
      code: 'NOT_FOUND',
      error: '台账里没有匹配「' + query + '」的条目。',
      hint: '先用 inventory_list 看已登记的名字；确实是新装的，用 inventory_add 补录后再预演。',
    }
  }
  const entry = matched[0]
  const target = entry.path
  const targetExists = target !== '' && existsSync(target)
  const measured = targetExists ? measureDir(target, { maxEntries: 40000, deadlineMs: 4000 }) : { bytes: 0, files: 0, truncated: false }
  const scanRefs = args?.scanRefs !== false
  const probe = scanRefs ? probeInstallRefs(target) : { ok: false, refs: emptyRefs(), processes: [] }
  let refs = emptyRefs()
  let refsScanned = false
  let refsSource = 'none'
  if (probe.ok) {
    refs = probe.refs
    refsScanned = true
    refsSource = 'fresh'
  } else if (refCountOf(entry.refs) > 0) {
    refs = entry.refs
    refsSource = 'recorded'
  }
  const dataDirs = []
  let dataBytes = 0
  const startedAt = Date.now()
  let measuredDirs = 0
  for (const dir of entry.dataDirs) {
    const dirExists = existsSync(dir)
    let size = { bytes: 0, files: 0, truncated: false }
    if (dirExists && measuredDirs < 8 && Date.now() - startedAt < 8000) {
      size = measureDir(dir, { maxEntries: 20000, deadlineMs: 1500 })
      measuredDirs += 1
    } else if (dirExists) {
      size = { bytes: 0, files: 0, truncated: true }
    }
    dataBytes += size.bytes
    dataDirs.push({ path: dir, exists: dirExists, bytes: Math.round(size.bytes), files: size.files, truncated: size.truncated })
  }
  const processes = probe.ok ? probe.processes : []
  const locksResult = args?.locks ? detectLocks(target, store) : { checked: false, holders: [] }
  const redlineNotes = []
  if (target !== '' && isProtected(target, guard)) {
    redlineNotes.push('安装路径在红线目录内（系统目录 / 插件源码 / 学习空间）：真要删请逐项人工确认，插件不会代删。')
  }
  for (const dir of entry.dataDirs) {
    if (isProtected(dir, guard)) redlineNotes.push('数据目录在红线目录内：' + dir)
  }
  if (store && target !== '' && isUnder(target, store.dir)) {
    redlineNotes.push('安装路径就是本插件自己的数据目录：删掉会连整理记录和台账一起丢。')
  }
  const steps = buildUninstallSteps(entry, {
    dataDirs,
    refs,
    refsSource,
    processes,
    redlineNotes,
  })
  const hint =
    matched.length > 1
      ? '匹配到 ' + matched.length + ' 条，本次只预演「' + entry.name + '」；要预演别的条目，用 name 写全名或编号。'
      : '按上面步骤执行；卸完用 inventory_check 复核残留，确认干净后再标记为已卸载。'
  return {
    ...base,
    found: true,
    query,
    matches: matched.length,
    entry,
    targetExists,
    targetBytes: Math.round(measured.bytes),
    targetFiles: measured.files,
    targetTruncated: Boolean(measured.truncated),
    refs,
    refCount: refCountOf(refs),
    refsScanned,
    refsSource,
    dataDirs,
    dataBytes: Math.round(dataBytes),
    processes,
    locks: locksResult.holders,
    locksChecked: locksResult.checked,
    redlineNotes,
    steps,
    error: '',
    hint,
  }
}

/** 卸后复核：只读；只改 inventory.json 里的 stale / removed 标记，不删记录、不动用户文件 */
export function doInventoryCheck(args, store) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const base = {
    checked: 0,
    missingCount: 0,
    residueCount: 0,
    okCount: 0,
    missing: [],
    residue: [],
    ok: [],
    staleMarked: 0,
    removedMarked: 0,
    probes: 0,
    inventoryFile: jsonFile,
    markdownFile: mdFile,
    error: '',
    hint: '',
  }
  const spec = readInventory(store)
  if (spec.error) return { ...base, code: 'INVENTORY_UNREADABLE', error: spec.error, hint: '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。' }
  const query = typeof args?.name === 'string' ? args.name.trim() : ''
  let scoped = spec.data.entries
  if (query !== '') {
    const matched = findInventoryEntries(scoped, query)
    if (matched.length === 0) {
      return { ...base, code: 'NOT_FOUND', error: '台账里没有匹配「' + query + '」的条目。', hint: '先用 inventory_list 看已登记的名字。' }
    }
    scoped = matched
  }
  const active = scoped.filter((entry) => entry.status !== 'removed')
  if (active.length === 0) {
    return {
      ...base,
      hint: query !== '' ? '这条已经标记为已卸载（历史记录），不需要再复核。' : '台账里没有在用的条目，先 inventory_add 登记。',
    }
  }
  const markStale = args?.markStale !== false
  const markRemoved = args?.markRemoved === true
  const scanRefs = args?.scanRefs !== false
  const budget = { probes: 0, maxProbes: 8, deadline: Date.now() + 25000 }
  const missing = []
  const residue = []
  const ok = []
  let staleMarked = 0
  let removedMarked = 0
  let changed = false
  const now = new Date().toISOString()
  for (const entry of active) {
    const pathExists = entry.path !== '' && existsSync(entry.path)
    const dirsGone = entry.dataDirs.filter((dir) => !existsSync(dir))
    const allDirsGone = dirsGone.length === entry.dataDirs.length
    if (pathExists) {
      let detail = '路径与数据目录都在。'
      if (dirsGone.length > 0) {
        detail = '路径在；数据目录缺 ' + dirsGone.length + '/' + entry.dataDirs.length + ' 个：' + dirsGone.slice(0, 3).join(' / ')
      }
      ok.push({ id: entry.id, name: entry.name, detail })
      if (entry.stale) {
        entry.stale = false
        changed = true
      }
      continue
    }
    let fresh = null
    if (scanRefs && budget.probes < budget.maxProbes && Date.now() < budget.deadline) {
      budget.probes += 1
      const probed = probeInstallRefs(entry.path)
      if (probed.ok) fresh = probed.refs
    }
    const refsInUse = fresh || entry.refs
    const refItems = flattenRefs(refsInUse)
    if (refItems.length > 0) {
      for (const item of refItems.slice(0, 20)) {
        residue.push({
          id: entry.id,
          name: entry.name,
          refKind: item.kind,
          detail: shortenText(item.name + (item.detail ? ' · ' + item.detail : ''), 300),
        })
      }
      missing.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        detail: '安装路径已不在；引用残留 ' + refItems.length + ' 处' + (fresh ? '' : '（引用取自登记时的记录，本次未重扫）'),
      })
      if (markStale && !entry.stale) {
        entry.stale = true
        changed = true
        staleMarked += 1
      }
      continue
    }
    let detail = '安装路径已不在，也没有查到关联引用。'
    if (entry.dataDirs.length > 0) {
      detail = allDirsGone
        ? '安装路径与数据目录都已不在，也没有关联引用。'
        : '安装路径已不在；数据目录还留着 ' + (entry.dataDirs.length - dirsGone.length) + ' 个，删前确认。'
    }
    missing.push({ id: entry.id, name: entry.name, kind: entry.kind, path: entry.path, detail })
    if (markRemoved && allDirsGone) {
      entry.status = 'removed'
      entry.removedAt = now
      entry.stale = false
      changed = true
      removedMarked += 1
    } else if (markStale && !entry.stale) {
      entry.stale = true
      changed = true
      staleMarked += 1
    }
  }
  let error = ''
  if (changed) {
    try {
      writeInventory(store, spec.data)
    } catch (writeError) {
      error = '复核算完了，但台账写不进去：' + lockHint(writeError) + '（' + jsonFile + '）'
    }
  }
  const missingCount = missing.length
  const residueCount = residue.length
  let hint = ''
  if (missingCount === 0 && residueCount === 0) hint = '对账通过：在用条目都还在，没有引用残留。'
  else if (missingCount > 0) {
    hint = '确认已卸载且数据也清干净的条目，用 inventory_check 的 markRemoved 收进历史；引用残留按 plan_uninstall 的步骤逐条清。'
  } else hint = '引用有残留，建议用 plan_uninstall 看建议步骤逐条清理。'
  return {
    ...base,
    checked: active.length,
    missing,
    residue,
    ok,
    missingCount,
    residueCount,
    okCount: ok.length,
    staleMarked,
    removedMarked,
    probes: budget.probes,
    error,
    hint,
  }
}

/** 给 tidy_status 用的台账统计（读不出来也不抛） */
export function inventoryStats(store) {
  const spec = readInventory(store)
  if (spec.error) return { entries: 0, active: 0, removed: 0, stale: 0, error: spec.error }
  const entries = spec.data.entries
  const active = entries.filter((entry) => entry.status !== 'removed').length
  return {
    entries: entries.length,
    active,
    removed: entries.length - active,
    stale: entries.filter((entry) => entry.stale).length,
    error: '',
  }
}

// ───────────────────────────── 台账：人话输出 ─────────────────────────────

export function renderInventoryAdd(_args, value) {
  const entry = value?.entry || emptyInventoryEntry()
  if (!value?.ok) {
    const failed = ['登记没成：' + (value?.error || '未知原因')]
    if (value?.hint) failed.push(value.hint)
    return [text(failed.join('\n'))]
  }
  const lines = []
  if (value?.created) {
    lines.push(
      '陛下，已登记「' + entry.name + '」（' + entry.id + ' · ' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + '）。',
    )
  } else {
    lines.push('陛下，已更新「' + entry.name + '」的登记（' + entry.id + '）。')
  }
  lines.push('  路径：' + (entry.path || '（未填）'))
  if (entry.version) lines.push('  版本：' + entry.version)
  if (entry.dataDirs.length > 0) {
    const shown = entry.dataDirs.slice(0, 3).join(' · ')
    lines.push('  数据目录：' + entry.dataDirs.length + ' 个（' + shown + (entry.dataDirs.length > 3 ? ' …' : '') + '）')
  }
  lines.push('  关联引用：' + refCountLine(entry.refs))
  lines.push('  台账：' + (value?.inventoryFile || '') + '（共 ' + fmtCount(value?.total ?? 0) + ' 条）')
  if (!value?.refsScanned) lines.push('  （本次没拿到关联引用：可能跳过了扫描或扫描失败；需要的话再跑一次 inventory_add）')
  if (value?.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

export function renderInventoryList(_args, value) {
  if (value?.error) {
    return [text(['台账读不出来：' + value.error, value?.hint].filter(Boolean).join('\n'))]
  }
  const lines = []
  const allCount = (Number(value?.activeCount) || 0) + (Number(value?.removedCount) || 0)
  if (allCount === 0) {
    lines.push('陛下，台账还是空的。')
    if (value?.hint) lines.push(value.hint)
    lines.push('数据目录：' + (value?.storeDir || '') + '（约 ' + fmtSize(value?.storeBytes ?? 0) + '）')
    return [text(lines.join('\n'))]
  }
  lines.push(
    '陛下，台账共 ' +
      fmtCount(allCount) +
      ' 条（在用 ' +
      fmtCount(value?.activeCount ?? 0) +
      ' · 已卸载 ' +
      fmtCount(value?.removedCount ?? 0) +
      ' · 待核对 ' +
      fmtCount(value?.staleCount ?? 0) +
      '），本次列 ' +
      fmtCount(value?.total ?? 0) +
      ' 条：',
  )
  for (const entry of Array.isArray(value?.entries) ? value.entries : []) {
    const version = entry.version ? ' · v' + entry.version : ''
    const statusText = entry.status === 'removed' ? '已卸载' : entry.stale ? '待核对' : '在用'
    lines.push('  • ' + entry.name + '（' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + version + '） · ' + statusText)
    lines.push('      ' + (entry.path || '（未填路径）'))
    if (entry.dataDirs.length > 0 || refCountOf(entry.refs) > 0) {
      lines.push('      数据目录 ' + entry.dataDirs.length + ' 个 · ' + refCountOf(entry.refs) + ' 处引用')
    }
  }
  if ((value?.omitted ?? 0) > 0) lines.push('  … 还有 ' + fmtCount(value.omitted) + ' 条未列出')
  lines.push('数据目录：' + (value?.storeDir || '') + '（约 ' + fmtSize(value?.storeBytes ?? 0) + '）')
  if (value?.hint) lines.push(value.hint)
  return [text(lines.join('\n'))]
}

export function renderPlanUninstall(_args, value) {
  if (!value?.found) {
    const lines = ['陛下，这次预演没成：' + (value?.error || '未知原因')]
    if (value?.hint) lines.push(value.hint)
    return [text(lines.join('\n'))]
  }
  const entry = value.entry || emptyInventoryEntry()
  const lines = []
  lines.push('陛下，卸载预演（只读，不删任何东西）：「' + entry.name + '」（' + entry.id + ' · ' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + '）')
  lines.push('  状态：' + (entry.status === 'removed' ? '已卸载（历史）' : entry.stale ? '待核对' : '在用') + (entry.version ? ' · 版本 ' + entry.version : ''))
  lines.push(
    '  安装路径：' +
      (entry.path || '（未填）') +
      (value.targetExists
        ? '（还在，' + fmtSize(value.targetBytes ?? 0) + ' / ' + fmtCount(value.targetFiles ?? 0) + ' 个文件' + (value.targetTruncated ? '，只量了一部分' : '') + '）'
        : '（已不在）'),
  )
  if (entry.uninstallCmd) lines.push('  卸载命令：' + entry.uninstallCmd)
  if (value.dataDirs.length > 0) {
    lines.push('  数据目录：' + value.dataDirs.length + ' 个，共 ' + fmtSize(value.dataBytes ?? 0))
    for (const dir of value.dataDirs.slice(0, 8)) {
      lines.push('    • ' + dir.path + '（' + (dir.exists ? '在，' + fmtSize(dir.bytes) : '已不在') + '）')
    }
    if (value.dataDirs.length > 8) lines.push('    … 另有 ' + (value.dataDirs.length - 8) + ' 个')
  }
  const refs = value.refs || emptyRefs()
  const refGroups = REF_FIELDS.filter((field) => (refs[field] || []).length > 0)
  if (refGroups.length === 0) {
    lines.push(value.refsSource === 'recorded' ? '  受影响引用：本次没重扫，登记时记录的引用也没有' : '  受影响引用：没查到')
  } else {
    const note = value.refsSource === 'recorded' ? '（取自登记记录，本次未重扫）' : ''
    lines.push('  受影响引用：共 ' + fmtCount(value.refCount ?? 0) + ' 处' + note)
    for (const field of refGroups) {
      lines.push('    ' + REF_FIELD_LABEL[field] + ' ' + refs[field].length + ' 处')
      for (const item of refs[field].slice(0, 5)) {
        lines.push('      · ' + (item.name || '（未命名）') + (item.detail ? '（' + shortenText(item.detail, 90) + '）' : ''))
      }
      if (refs[field].length > 5) lines.push('      … 另有 ' + (refs[field].length - 5) + ' 处')
    }
  }
  const processes = Array.isArray(value.processes) ? value.processes : []
  if (processes.length > 0) {
    lines.push('  正在运行的进程：' + processes.slice(0, 6).map((item) => item.name + '(pid ' + item.pid + ')').join('、') + (processes.length > 6 ? ' 等' : ''))
  }
  const locks = Array.isArray(value.locks) ? value.locks : []
  if (value.locksChecked) {
    lines.push('  文件占用：' + (locks.length === 0 ? '无' : locks.slice(0, 5).map((item) => item.process + '(pid ' + item.pid + ')').join('、')))
  }
  for (const note of Array.isArray(value.redlineNotes) ? value.redlineNotes : []) lines.push('【红线】' + note)
  const steps = Array.isArray(value.steps) ? value.steps : []
  if (steps.length > 0) {
    lines.push('【建议步骤】')
    steps.forEach((step, index) => lines.push('  ' + (index + 1) + '. ' + step))
  }
  if (value.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

export function renderInventoryCheck(_args, value) {
  if (value?.error) {
    const lines = ['复核没成：' + value.error]
    if (value?.hint) lines.push(value.hint)
    return [text(lines.join('\n'))]
  }
  const lines = []
  if ((value?.checked ?? 0) === 0) {
    lines.push('陛下，' + (value?.hint || '台账里没有要复核的条目。'))
    return [text(lines.join('\n'))]
  }
  lines.push(
    '陛下，台账复核完毕（在用 ' +
      fmtCount(value.checked ?? 0) +
      ' 条）：正常 ' +
      fmtCount(value.okCount ?? 0) +
      ' 条 · 记录有但已不在 ' +
      fmtCount(value.missingCount ?? 0) +
      ' 条 · 引用残留 ' +
      fmtCount(value.residueCount ?? 0) +
      ' 处。',
  )
  const missing = Array.isArray(value.missing) ? value.missing : []
  if (missing.length > 0) {
    lines.push('【记录有但已不在】')
    for (const item of missing.slice(0, 10)) {
      lines.push('  • ' + item.name + '（' + (item.path || '未填路径') + '）')
      lines.push('      ' + item.detail)
    }
    if (missing.length > 10) lines.push('  … 另有 ' + (missing.length - 10) + ' 条')
  }
  const residue = Array.isArray(value.residue) ? value.residue : []
  if (residue.length > 0) {
    lines.push('【引用残留】')
    for (const item of residue.slice(0, 12)) lines.push('  • ' + item.name + ' ← ' + item.refKind + '：' + item.detail)
    if (residue.length > 12) lines.push('  … 另有 ' + (residue.length - 12) + ' 处')
  }
  const okRows = Array.isArray(value.ok) ? value.ok : []
  if (okRows.length > 0) {
    lines.push('【正常】')
    for (const item of okRows.slice(0, 6)) lines.push('  • ' + item.name + '：' + item.detail)
    if (okRows.length > 6) lines.push('  … 另有 ' + (okRows.length - 6) + ' 条')
  }
  if ((value?.staleMarked ?? 0) > 0) lines.push('已把 ' + fmtCount(value.staleMarked) + ' 条标记为待核对（只改台账，没删记录）。')
  if ((value?.removedMarked ?? 0) > 0) lines.push('已把 ' + fmtCount(value.removedMarked) + ' 条标记为已卸载（历史保留）。')
  if ((value?.staleMarked ?? 0) === 0 && (value?.removedMarked ?? 0) === 0) lines.push('台账没有需要改动的标记。')
  if (value?.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

// ───────────────────────────── 台账：schema 与参数 ─────────────────────────────

export const inventoryRefItemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['name', 'detail'],
  additionalProperties: false,
}

export const inventoryRefsSchema = {
  type: 'object',
  properties: {
    services: { type: 'array', items: inventoryRefItemSchema },
    startup: { type: 'array', items: inventoryRefItemSchema },
    tasks: { type: 'array', items: inventoryRefItemSchema },
    shortcuts: { type: 'array', items: inventoryRefItemSchema },
    pathEntries: { type: 'array', items: inventoryRefItemSchema },
    registryKeys: { type: 'array', items: inventoryRefItemSchema },
  },
  required: ['services', 'startup', 'tasks', 'shortcuts', 'pathEntries', 'registryKeys'],
  additionalProperties: false,
}

export const inventoryEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    uninstallCmd: { type: 'string' },
    installedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    dataDirs: { type: 'array', items: { type: 'string' } },
    refs: inventoryRefsSchema,
    notes: { type: 'string' },
    status: { type: 'string' },
    removedAt: { type: 'string' },
    stale: { type: 'boolean' },
  },
  required: [
    'id',
    'name',
    'kind',
    'path',
    'version',
    'source',
    'uninstallCmd',
    'installedAt',
    'updatedAt',
    'dataDirs',
    'refs',
    'notes',
    'status',
    'removedAt',
    'stale',
  ],
  additionalProperties: false,
}

export const inventoryAddSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    created: { type: 'boolean' },
    id: { type: 'string' },
    entry: inventoryEntrySchema,
    refsScanned: { type: 'boolean' },
    refCount: { type: 'integer' },
    total: { type: 'integer' },
    inventoryFile: { type: 'string' },
    markdownFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'ok',
    'created',
    'id',
    'entry',
    'refsScanned',
    'refCount',
    'total',
    'inventoryFile',
    'markdownFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

export const inventoryAddParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Display name; acts as the natural key. Passing an existing name updates that entry.' },
    kind: {
      type: 'string',
      enum: ['installer', 'portable', 'dsh-plugin', 'dev-tool'],
      description: 'installer (with uninstaller) | portable (no uninstaller) | dsh-plugin (DSH bundle) | dev-tool.',
    },
    path: { type: 'string', description: 'Install directory or main executable (absolute path, must exist).' },
    version: { type: 'string', description: 'Version string, if known.' },
    source: { type: 'string', description: 'Where it came from (URL / store / download page).' },
    uninstallCmd: { type: 'string', description: 'Uninstall command or path to the uninstaller, if known.' },
    dataDirs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Extra data/config directories to remember for later cleanup (AppData, saves, plugin data dirs).',
    },
    notes: { type: 'string', description: 'Free-form note.' },
    scanRefs: {
      type: 'boolean',
      description:
        'Also scan services / startup / scheduled tasks / shortcuts / PATH / registry keys that reference the path and store them in the entry. Default true (takes a few seconds).',
    },
  },
  required: ['name', 'kind', 'path'],
  additionalProperties: false,
}

export const inventoryListSchema = {
  type: 'object',
  properties: {
    storeDir: { type: 'string' },
    total: { type: 'integer' },
    shown: { type: 'integer' },
    omitted: { type: 'integer' },
    activeCount: { type: 'integer' },
    removedCount: { type: 'integer' },
    staleCount: { type: 'integer' },
    storeBytes: { type: 'integer' },
    entries: { type: 'array', items: inventoryEntrySchema },
    inventoryFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'storeDir',
    'total',
    'shown',
    'omitted',
    'activeCount',
    'removedCount',
    'staleCount',
    'storeBytes',
    'entries',
    'inventoryFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

export const inventoryListParameters = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['installer', 'portable', 'dsh-plugin', 'dev-tool'],
      description: 'Only list entries of this kind.',
    },
    status: {
      type: 'string',
      enum: ['active', 'removed', 'all'],
      description: 'active (default: still installed) | removed (history) | all.',
    },
    limit: { type: 'integer', description: 'Max entries to return, 1-200. Default 20.' },
  },
  additionalProperties: false,
}

export const planUninstallDataDirSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    exists: { type: 'boolean' },
    bytes: { type: 'integer' },
    files: { type: 'integer' },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'exists', 'bytes', 'files', 'truncated'],
  additionalProperties: false,
}

export const planUninstallProcessSchema = {
  type: 'object',
  properties: {
    pid: { type: 'integer' },
    name: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['pid', 'name', 'path'],
  additionalProperties: false,
}

export const planUninstallLockSchema = {
  type: 'object',
  properties: {
    process: { type: 'string' },
    pid: { type: 'integer' },
  },
  required: ['process', 'pid'],
  additionalProperties: false,
}

export const planUninstallSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    query: { type: 'string' },
    matches: { type: 'integer' },
    entry: inventoryEntrySchema,
    targetExists: { type: 'boolean' },
    targetBytes: { type: 'integer' },
    targetFiles: { type: 'integer' },
    targetTruncated: { type: 'boolean' },
    refs: inventoryRefsSchema,
    refCount: { type: 'integer' },
    refsScanned: { type: 'boolean' },
    refsSource: { type: 'string' },
    dataDirs: { type: 'array', items: planUninstallDataDirSchema },
    dataBytes: { type: 'integer' },
    processes: { type: 'array', items: planUninstallProcessSchema },
    locks: { type: 'array', items: planUninstallLockSchema },
    locksChecked: { type: 'boolean' },
    redlineNotes: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    removesNothing: { type: 'boolean' },
    notice: { type: 'string' },
    inventoryFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'found',
    'query',
    'matches',
    'entry',
    'targetExists',
    'targetBytes',
    'targetFiles',
    'targetTruncated',
    'refs',
    'refCount',
    'refsScanned',
    'refsSource',
    'dataDirs',
    'dataBytes',
    'processes',
    'locks',
    'locksChecked',
    'redlineNotes',
    'steps',
    'removesNothing',
    'notice',
    'inventoryFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

export const planUninstallParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Ledger entry name or id to preview.' },
    path: { type: 'string', description: 'Install path (or a fragment of it) to preview.' },
    scanRefs: {
      type: 'boolean',
      description:
        'Re-scan services / startup / scheduled tasks / shortcuts / PATH / registry now. Default true; false falls back to the refs stored in the ledger.',
    },
    locks: {
      type: 'boolean',
      description: 'Also use Sysinternals handle64 (if present) to find processes holding files open. Slower.',
    },
  },
  additionalProperties: false,
}

export const inventoryCheckMissingSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'kind', 'path', 'detail'],
  additionalProperties: false,
}

export const inventoryCheckResidueSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    refKind: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'refKind', 'detail'],
  additionalProperties: false,
}

export const inventoryCheckOkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'detail'],
  additionalProperties: false,
}

export const inventoryCheckSchema = {
  type: 'object',
  properties: {
    checked: { type: 'integer' },
    missingCount: { type: 'integer' },
    residueCount: { type: 'integer' },
    okCount: { type: 'integer' },
    missing: { type: 'array', items: inventoryCheckMissingSchema },
    residue: { type: 'array', items: inventoryCheckResidueSchema },
    ok: { type: 'array', items: inventoryCheckOkSchema },
    staleMarked: { type: 'integer' },
    removedMarked: { type: 'integer' },
    probes: { type: 'integer' },
    inventoryFile: { type: 'string' },
    markdownFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'checked',
    'missingCount',
    'residueCount',
    'okCount',
    'missing',
    'residue',
    'ok',
    'staleMarked',
    'removedMarked',
    'probes',
    'inventoryFile',
    'markdownFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

export const inventoryCheckParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Only check one entry (name / id / path fragment). Default: every active entry.' },
    markStale: {
      type: 'boolean',
      description: 'Mark entries whose path (and data dirs) vanished as stale=true in the ledger. Default true; only inventory.json changes.',
    },
    markRemoved: {
      type: 'boolean',
      description:
        'Also move entries whose path and data dirs are gone, with no leftover references, to status=removed (kept as history). Default false — confirm first.',
    },
    scanRefs: {
      type: 'boolean',
      description: 'Re-scan the six reference kinds for vanished paths. Default true; false is faster but may miss leftover references.',
    },
  },
  additionalProperties: false,
}

