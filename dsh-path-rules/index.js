/**
 * dsh-path-rules v2 —— 分层路径规则（layered path rules）
 *
 * 学谁：Claude Code 的 .claude/rules（按路径分片）+ CLAUDE.md（每轮注入的核心纪律）。
 * DSH 默认只有 AGENTS.md 一种注入方式：全局、每轮、全量。规则一多就互相稀释。
 *
 * v2 的三层模型（数字越大越优先）：
 *
 *   1. 用户级   $DSH_HOME/rules/*.md        —— 跨项目通用纪律（always: true 时每轮注入）
 *   2. 项目级   <cwd>/.dsh/rules/*.md       —— 这个仓库的纪律（always: true 时每轮注入）
 *   3. 路径命中 与上面同一批文件，但靠 paths 的 glob 命中当前触及的文件才生效
 *
 * 优先级：用户级 < 项目级 < 路径命中；同一个 id 只保留优先级最高的一条
 * （更近 = 项目级，更具体 = 路径命中）。
 *
 * 规则文件格式（向后兼容 v1，老文件不用改）：
 *
 *   ---
 *   id: 前端规范            # 可选。同 id 时按优先级覆盖；不写就用文件路径当 id
 *   always: true            # 可选。true = 每轮注入（核心层），不需要 paths 命中
 *   paths:                  # always 为 true 时可省略
 *     - "src/**\/*.tsx"
 *   ---
 *   正文：真的会让模型改变行为的那一两句话。
 *
 * 预算分开：
 *   - 核心层（always）  maxAlwaysChars，默认 2000
 *   - 路径层（paths）   maxChars，默认 3000
 *   超预算按优先级（低 → 高）装填，单条过大就截断正文并说明，剩余放不下就整条跳过并说明。
 *
 * 已知边界（刻意不做）：
 *   - 不跟踪 shell 命令里提到的文件（只看结构化工具参数）
 *   - 规则目录只扫一层，不递归
 *   - 路径规则一次触发后在本会话内保持活跃（不自动退出），行为可预期
 *   - 不做语义匹配，只有 glob
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-path-rules'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const CONTEXT_ORDER = 850
const DEFAULT_MAX_CHARS = 3000
const DEFAULT_MAX_ALWAYS_CHARS = 2000
/** 剩余预算小到这个程度就不值得截断，整条跳过更干净。 */
const MIN_KEEP_CHARS = 80
const MAX_RULE_BYTES = 32 * 1024
/** 列表默认最多显示 20 条（plugin-ux R6）。 */
const LIST_LIMIT = 20
const PROJECT_RULES_SEGMENTS = ['.dsh', 'rules']
const USER_RULES_SUBDIR = 'rules'
const TOUCH_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'multi_edit', 'apply_patch'])
const PATH_ARG_NAMES = ['file_path', 'filePath', 'path']
const LAYER_LABELS = { user: '用户级', project: '项目级' }

const text = (value) => ({ type: 'text', text: value })
const toSlash = (value) => String(value).replaceAll('\\', '/')
const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)

/** 层的中文名：用户级 / 项目级。 */
export const layerLabel = (layer) => LAYER_LABELS[layer] ?? LAYER_LABELS.user

// ---------- glob ----------

/** 展开 {a,b,c} 花括号分支；嵌套只处理一层足够用。 */
export function expandBraces(pattern) {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  const close = pattern.indexOf('}', open)
  if (close < 0) return [pattern]
  const head = pattern.slice(0, open)
  const body = pattern.slice(open + 1, close).split(',')
  const tail = pattern.slice(close + 1)
  const out = []
  for (const option of body) {
    for (const expanded of expandBraces(head + option + tail)) out.push(expanded)
  }
  return out
}

/** 把一条 glob 编成正则：** 跨目录，* 单层，? 单字符。 */
export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      continue
    }
    if ('.+^$()|[]{}'.includes(ch)) {
      source += '\\' + ch
      continue
    }
    source += ch
  }
  return new RegExp('^' + source + '$')
}

// ---------- 规则文件 ----------

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseInlineList(value) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  const inner = trimmed.slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((item) => unquote(item)).filter((item) => item !== '')
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0', ''])

/** 把 frontmatter 的布尔值翻成 true/false；认不出来的按 false（老文件不受影响）。 */
export function parseBoolFlag(value) {
  const word = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return false
}

/**
 * 解析 frontmatter，只认 paths / always / id 三个键，其余键忽略（不报错）。
 * 返回 { paths: string[], always: boolean, id: string }。
 */
export function parseFrontmatter(source) {
  const result = { paths: [], always: false, id: '' }
  let collectingPaths = false
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (collectingPaths) {
      const item = /^-\s*(.+)$/.exec(trimmed)
      if (item !== null) {
        const value = unquote(item[1])
        if (value !== '') result.paths.push(value)
        continue
      }
      collectingPaths = false
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed)
    if (pair === null) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim()
    if (key === 'paths') {
      if (value === '') {
        collectingPaths = true
        continue
      }
      const inline = parseInlineList(value)
      if (inline !== null) {
        for (const item of inline) result.paths.push(item)
        continue
      }
      const single = unquote(value)
      if (single !== '') result.paths.push(single)
      continue
    }
    if (key === 'always') {
      result.always = parseBoolFlag(value)
      continue
    }
    if (key === 'id') {
      result.id = unquote(value)
      continue
    }
  }
  return result
}

/**
 * 解析一条规则文件：--- frontmatter --- 正文。
 * 没有 frontmatter、既没有 paths 也没有 always、正文为空 —— 都返回 null（静默跳过，不抛错）。
 */
export function parseRule(rawText) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(rawText).replace(/^\uFEFF/, '').trimStart())
  if (match === null) return null
  const body = match[2].trim()
  if (body === '') return null
  const meta = parseFrontmatter(match[1])
  const paths = meta.paths.map((item) => item.trim()).filter((item) => item !== '')
  if (paths.length === 0 && meta.always !== true) return null
  return {
    paths,
    body,
    always: meta.always === true,
    id: meta.id,
    regexps: paths.map((pattern) => expandBraces(pattern).map((expanded) => globToRegExp(expanded))),
  }
}

/**
 * 把「文件 + 层 + 原文」装成规则对象。解析失败返回 null。
 * id：frontmatter 没写就用文件路径（归一化成 / 分隔的绝对路径）。
 */
export function createRule(options) {
  const file = options?.file
  const sourceText = options?.sourceText
  if (typeof file !== 'string' || file === '' || typeof sourceText !== 'string') return null
  const parsed = parseRule(sourceText)
  if (parsed === null) return null
  const normalized = toSlash(file)
  const explicitId = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  const layer = options?.layer === 'project' ? 'project' : 'user'
  return {
    file: normalized,
    layer,
    id: explicitId === '' ? normalized : explicitId,
    explicitId,
    paths: parsed.paths,
    body: parsed.body,
    chars: parsed.body.length,
    always: parsed.always,
    regexps: parsed.regexps,
  }
}

/** 相对路径是否命中某条规则（任一 glob 命中即算）。 */
export function ruleMatches(rule, relativePath) {
  if (rule === null || rule === undefined) return false
  const groups = rule.regexps
  if (!Array.isArray(groups)) return false
  return groups.some((group) => group.some((regexp) => regexp.test(relativePath)))
}

/** 把工具参数里的路径转成相对 cwd、分隔符统一为 / 的形式。 */
export function normalizePath(cwd, value) {
  const raw = String(value).trim()
  if (raw === '') return ''
  const relative = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw
  const normalized = toSlash(relative)
  return normalized === '' ? '.' : normalized
}

// ---------- 优先级 / 去重 / 预算 ----------

/**
 * 优先级（数字越大越优先）：路径命中 > 项目级 > 用户级。
 * 同一 id 冲突时用它决定谁覆盖谁。
 */
export function rulePriority(rule, activation) {
  const hit = activation === 'path' ? 2 : 0
  const near = rule?.layer === 'project' ? 1 : 0
  return hit + near
}

/** 生效方式的展示名：核心层 / 路径命中。 */
export function activationLabel(activation) {
  return activation === 'always' ? '核心层' : '路径命中'
}

/**
 * 同 id 只留优先级最高的一条。同优先级时保留先扫到的那条
 * （扫描顺序是项目级 → 用户级，所以打平时项目级反而更该赢）。
 */
export function dedupeById(entries) {
  const byId = new Map()
  const dropped = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || entry === undefined || entry.rule === undefined) continue
    const id = entry.rule.id
    const existing = byId.get(id)
    if (existing === undefined) {
      byId.set(id, entry)
      continue
    }
    if (rulePriority(entry.rule, entry.activation) > rulePriority(existing.rule, existing.activation)) {
      byId.set(id, entry)
      dropped.push(existing)
    } else {
      dropped.push(entry)
    }
  }
  return { kept: [...byId.values()], dropped }
}

/**
 * 按预算装填一层规则（entries 已按优先级从低到高排好）。
 * - 整条装得下：原样放入
 * - 剩余空间还够 MIN_KEEP_CHARS：截断正文并标记
 * - 连截断都不够：整条跳过并计数
 * items: [{ header, body, entry }] → { blocks: [{ header, text, entry, truncated }], used, omitted, truncated }
 */
export function fitBudget(items, budget) {
  const blocks = []
  let used = 0
  let omitted = 0
  let truncated = 0
  for (const item of Array.isArray(items) ? items : []) {
    const header = String(item.header)
    const body = String(item.body)
    const full = header.length + 1 + body.length
    const available = budget - used
    if (full <= available) {
      blocks.push({ header, text: header + '\n' + body, entry: item.entry, truncated: false })
      used += full
      continue
    }
    const room = available - header.length - 1
    if (room >= Math.min(MIN_KEEP_CHARS, body.length)) {
      const marker = '\n…（正文已截断，原文 ' + body.length + ' 字符，超出本轮 ' + budget + ' 字符预算）'
      const keep = Math.max(0, room - marker.length)
      const chunk = header + '\n' + body.slice(0, keep) + marker
      blocks.push({ header, text: chunk, entry: item.entry, truncated: true })
      used += chunk.length
      truncated += 1
      continue
    }
    omitted += 1
  }
  return { blocks, used, omitted, truncated }
}

/** 规则的展示路径：在 cwd 内用相对路径，用户级或跨盘用绝对路径。 */
function displayPath(cwd, file) {
  const normalized = toSlash(file)
  if (typeof cwd !== 'string' || cwd === '') return normalized
  const relative = toSlash(path.relative(cwd, normalized))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return normalized
  return relative
}

/** 一条规则的注入块头：标明来源层 + 生效方式 + 匹配条件。 */
function chunkOf(entry, cwd) {
  const rule = entry.rule
  const display = displayPath(cwd, rule.file)
  const idPart = rule.explicitId === '' ? '' : '；id: ' + rule.explicitId
  const header = entry.activation === 'always'
    ? '▌ ' + layerLabel(rule.layer) + ' · ' + display + '（核心层，每轮生效' + idPart + '）'
    : '▌ ' + layerLabel(rule.layer) + ' · ' + display + '（路径命中，匹配 ' + rule.paths.join(' / ') + idPart + '）'
  return { header, body: rule.body, entry }
}

const summarize = (fit, maxChars) => ({
  maxChars,
  usedChars: fit.used,
  rules: fit.blocks.length,
  omitted: fit.omitted,
  truncated: fit.truncated,
})

/**
 * 纯函数：把「已激活的规则条目」拼成注入文本。不碰文件系统、不依赖会话。
 * entries: [{ rule, activation }]，activation 为 'always' | 'path'。
 * options: { cwd, maxAlwaysChars, maxChars }
 * 返回 { text, always, path, active }：text 为空表示这轮不该注入任何东西。
 */
export function composeInjection(entries, options = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : ''
  const maxAlwaysChars = positiveInt(options.maxAlwaysChars, DEFAULT_MAX_ALWAYS_CHARS)
  const maxChars = positiveInt(options.maxChars, DEFAULT_MAX_CHARS)
  const deduped = dedupeById(entries)
  const alwaysEntries = []
  const pathEntries = []
  for (const entry of deduped.kept) {
    if (entry.activation === 'always') alwaysEntries.push(entry)
    else pathEntries.push(entry)
  }
  const byPriority = (left, right) => {
    const diff = rulePriority(left.rule, left.activation) - rulePriority(right.rule, right.activation)
    if (diff !== 0) return diff
    return left.rule.file < right.rule.file ? -1 : left.rule.file > right.rule.file ? 1 : 0
  }
  alwaysEntries.sort(byPriority)
  pathEntries.sort(byPriority)

  const alwaysFit = fitBudget(alwaysEntries.map((entry) => chunkOf(entry, cwd)), maxAlwaysChars)
  const pathFit = fitBudget(pathEntries.map((entry) => chunkOf(entry, cwd)), maxChars)
  const alwaysBudget = summarize(alwaysFit, maxAlwaysChars)
  const pathBudget = summarize(pathFit, maxChars)
  const active = [...alwaysFit.blocks, ...pathFit.blocks].map((block) => block.entry)

  const sections = []
  if (alwaysFit.blocks.length > 0) {
    sections.push('【核心层 · 每轮生效】\n' + alwaysFit.blocks.map((block) => block.text).join('\n\n'))
  }
  if (pathFit.blocks.length > 0) {
    sections.push('【路径层 · 触及匹配文件后生效】\n' + pathFit.blocks.map((block) => block.text).join('\n\n'))
  }
  if (sections.length === 0) {
    return { text: '', always: alwaysBudget, path: pathBudget, active: [] }
  }

  const notices = []
  if (alwaysFit.truncated > 0) notices.push('（核心层有 ' + alwaysFit.truncated + ' 条规则正文过长，已按 ' + maxAlwaysChars + ' 字符预算截断）')
  if (alwaysFit.omitted > 0) notices.push('（另有 ' + alwaysFit.omitted + ' 条核心层规则超出本轮 ' + maxAlwaysChars + ' 字符预算，未展开）')
  if (pathFit.truncated > 0) notices.push('（路径层有 ' + pathFit.truncated + ' 条规则正文过长，已按 ' + maxChars + ' 字符预算截断）')
  if (pathFit.omitted > 0) notices.push('（另有 ' + pathFit.omitted + ' 条路径层规则超出本轮 ' + maxChars + ' 字符预算，未展开）')

  const lines = [
    '<path-rules>',
    '以下是本轮生效的规则，优先级从低到高：用户级 < 项目级 < 路径命中；同一个 id 只保留优先级最高的一条。',
    '',
    sections.join('\n\n'),
  ]
  if (notices.length > 0) {
    lines.push('')
    for (const notice of notices) lines.push(notice)
  }
  lines.push('</path-rules>')
  return { text: lines.join('\n'), always: alwaysBudget, path: pathBudget, active }
}

// ---------- 插件 ----------

export function apply(ctx, config) {
  if (config?.enabled === false) return
  const maxChars = positiveInt(config?.maxChars, DEFAULT_MAX_CHARS)
  const maxAlwaysChars = positiveInt(config?.maxAlwaysChars, DEFAULT_MAX_ALWAYS_CHARS)
  const fileCache = new Map()
  const triggeredEver = new Map()
  const activeBySession = new WeakMap()
  const activeFallback = new Map()
  const cwdBySession = new WeakMap()
  const cwdFallback = { current: '' }

  const dshHome = () => {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return path.join(os.homedir(), '.dsh')
  }

  /** 会话工作目录：优先问 workingDirectory 服务，拿不到就退回该会话上次已知值。 */
  const resolveCwd = (session) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      const workingDirectory = service ?? ctx.workingDirectory
      if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value !== '') {
          cwdFallback.current = value
          if (session !== undefined && session !== null && typeof session === 'object') cwdBySession.set(session, value)
          return value
        }
      }
    } catch {
      /* 工作目录服务还没就绪 */
    }
    if (session !== undefined && session !== null && typeof session === 'object') {
      const cached = cwdBySession.get(session)
      if (typeof cached === 'string' && cached !== '') return cached
    }
    return cwdFallback.current
  }

  const activeMap = (session) => {
    if (session === undefined || session === null || typeof session !== 'object') return activeFallback
    let map = activeBySession.get(session)
    if (map === undefined) {
      map = new Map()
      activeBySession.set(session, map)
    }
    return map
  }

  const loadRuleFile = (filePath, layer) => {
    try {
      const stat = statSync(filePath)
      if (!stat.isFile() || stat.size > MAX_RULE_BYTES) return null
      const cached = fileCache.get(filePath)
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.rule
      const rule = createRule({ file: filePath, layer, sourceText: readFileSync(filePath, 'utf8') })
      fileCache.set(filePath, { mtimeMs: stat.mtimeMs, rule })
      return rule
    } catch {
      return null
    }
  }

  /** 规则目录：项目级在前、用户级在后（同优先级打平时项目级先赢）。 */
  const ruleDirs = (cwd) => {
    const dirs = []
    if (typeof cwd === 'string' && cwd !== '') {
      dirs.push({ dir: path.join(cwd, ...PROJECT_RULES_SEGMENTS), layer: 'project' })
    }
    dirs.push({ dir: path.join(dshHome(), USER_RULES_SUBDIR), layer: 'user' })
    return dirs
  }

  const scanRules = (cwd) => {
    const rules = []
    for (const entry of ruleDirs(cwd)) {
      let names = []
      try {
        names = readdirSync(entry.dir)
      } catch {
        continue
      }
      for (const entryName of names) {
        if (!entryName.toLowerCase().endsWith('.md')) continue
        const rule = loadRuleFile(path.join(entry.dir, entryName), entry.layer)
        if (rule !== null) rules.push(rule)
      }
    }
    return rules
  }

  /** 当前会话实际激活的规则：always 永远激活，path 规则要本会话触发过。 */
  const collectEntries = (session, cwd) => {
    const map = activeMap(session)
    const entries = []
    for (const rule of scanRules(cwd)) {
      if (rule.always) {
        entries.push({ rule, activation: 'always' })
        continue
      }
      if (rule.paths.length > 0 && map.has(rule.file)) entries.push({ rule, activation: 'path' })
    }
    return entries
  }

  const pickPath = (args) => {
    if (args === null || typeof args !== 'object') return undefined
    for (const key of PATH_ARG_NAMES) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }

  const render = (context) => {
    try {
      const session = context?.agent?.session
      const cwd = resolveCwd(session)
      if (cwd === '') return ''
      return composeInjection(collectEntries(session, cwd), { cwd, maxChars, maxAlwaysChars }).text
    } catch {
      return ''
    }
  }

  // ---- 触发：工具动过某个文件后，检查命中的路径规则 ----
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    try {
      const toolName = String(exec?.name ?? '')
      if (!TOUCH_TOOLS.has(toolName)) return decision
      const raw = pickPath(exec?.arguments)
      if (raw === undefined) return decision
      const session = exec?.agent?.session ?? exec?.session
      const cwd = resolveCwd(session)
      if (cwd === '') return decision
      const relative = normalizePath(cwd, raw)
      if (relative === '') return decision
      const map = activeMap(session)
      for (const rule of scanRules(cwd)) {
        if (rule.always) continue
        if (!ruleMatches(rule, relative)) continue
        map.set(rule.file, rule)
        triggeredEver.set(rule.file, rule)
      }
    } catch (error) {
      ctx.logger?.warn?.('path-rules: 匹配规则失败 %o', error)
    }
    return decision
  })

  // ---- 注入：装配系统提示时渲染当前会话的活跃规则 ----
  const systemPrompt = ctx.systemPrompt ?? (typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined)
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.context === 'function') {
    ctx.effect(() =>
      systemPrompt.context({
        name: 'dsh-path-rules',
        order: CONTEXT_ORDER,
        text: (context) => render(context),
      }),
    )
  }

  // ---- 诊断 ----
  const budgetSchema = {
    type: 'object',
    properties: {
      maxChars: { type: 'integer' },
      usedChars: { type: 'integer' },
      rules: { type: 'integer' },
      omitted: { type: 'integer' },
      truncated: { type: 'integer' },
    },
    required: ['maxChars', 'usedChars', 'rules', 'omitted', 'truncated'],
    additionalProperties: false,
  }

  const statusSchema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      ruleDirs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            exists: { type: 'boolean' },
            rules: { type: 'integer' },
          },
          required: ['dir', 'exists', 'rules'],
          additionalProperties: false,
        },
      },
      totalRules: { type: 'integer' },
      maxChars: { type: 'integer' },
      maxAlwaysChars: { type: 'integer' },
      layers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            layer: { type: 'string' },
            scanned: { type: 'integer' },
            active: { type: 'integer' },
          },
          required: ['layer', 'scanned', 'active'],
          additionalProperties: false,
        },
      },
      alwaysBudget: budgetSchema,
      pathBudget: budgetSchema,
      activeRules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            source: { type: 'string' },
            activation: { type: 'string' },
            id: { type: 'string' },
            priority: { type: 'integer' },
            chars: { type: 'integer' },
            paths: { type: 'array', items: { type: 'string' } },
          },
          required: ['file', 'source', 'activation', 'id', 'priority', 'chars', 'paths'],
          additionalProperties: false,
        },
      },
      triggeredRules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            source: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            chars: { type: 'integer' },
          },
          required: ['file', 'source', 'paths', 'chars'],
          additionalProperties: false,
        },
      },
    },
    required: [
      'enabled',
      'ruleDirs',
      'totalRules',
      'maxChars',
      'maxAlwaysChars',
      'layers',
      'alwaysBudget',
      'pathBudget',
      'activeRules',
      'triggeredRules',
    ],
    additionalProperties: false,
  }

  const statusRender = (_args, value) => {
    const dirs = Array.isArray(value?.ruleDirs) ? value.ruleDirs : []
    const layers = Array.isArray(value?.layers) ? value.layers : []
    const active = Array.isArray(value?.activeRules) ? value.activeRules : []
    const triggered = Array.isArray(value?.triggeredRules) ? value.triggeredRules : []
    const always = value?.alwaysBudget
    const pathBudget = value?.pathBudget
    const lines = ['路径规则：共扫到 ' + (value?.totalRules ?? 0) + ' 条，当前生效 ' + active.length + ' 条']
    for (const item of layers) lines.push('- ' + item.layer + '：扫到 ' + String(item.scanned) + ' 条，生效 ' + String(item.active) + ' 条')
    lines.push('预算：核心层 ' + String(always?.maxChars ?? 0) + ' 字符（已用 ' + String(always?.usedChars ?? 0) + '，截断 ' + String(always?.truncated ?? 0) + ' 条，未展开 ' + String(always?.omitted ?? 0) + ' 条）')
    lines.push('　　　路径层 ' + String(pathBudget?.maxChars ?? 0) + ' 字符（已用 ' + String(pathBudget?.usedChars ?? 0) + '，截断 ' + String(pathBudget?.truncated ?? 0) + ' 条，未展开 ' + String(pathBudget?.omitted ?? 0) + ' 条）')
    for (const entry of dirs) lines.push((entry.exists ? '✓ ' : '✗ ') + entry.dir + ' —— ' + String(entry.rules) + ' 条')
    if (active.length === 0) {
      lines.push('还没有规则生效。做法：在 .dsh/rules/ 下建一个 .md，头部写 paths（触及匹配文件才生效）或 always: true（每轮生效）。')
    } else {
      lines.push('生效中的规则（优先级从低到高）：')
      const shown = active.slice(0, LIST_LIMIT)
      for (let i = 0; i < shown.length; i += 1) {
        const rule = shown[i]
        const extra = rule.activation === '路径命中' ? '，匹配 ' + rule.paths.join(' / ') : ''
        lines.push(String(i + 1) + '. ' + rule.source + ' · ' + rule.file + '（' + rule.activation + extra + '，' + String(rule.chars) + ' 字符）')
      }
      if (active.length > LIST_LIMIT) lines.push('… 还有 ' + String(active.length - LIST_LIMIT) + ' 条')
    }
    if (triggered.length > 0) lines.push('本次运行命中过 ' + String(triggered.length) + ' 条路径规则（含同 id 被覆盖的）')
    return [text(lines.join('\n'))]
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'path_rules_status',
      description:
        'Diagnose the layered path-rules plugin: per-layer scan/active counts, per-rule source layer and priority, and the separate budgets for the always-on core layer and the path-scoped layer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: statusSchema, render: statusRender },
      async execute(_args, exec) {
        const session = exec?.agent?.session
        const resolved = resolveCwd(session)
        const cwd = resolved === '' ? process.cwd() : resolved
        const scanned = scanRules(cwd)
        const composed = composeInjection(collectEntries(session, cwd), { cwd, maxChars, maxAlwaysChars })
        const dirs = ruleDirs(cwd).map((entry) => {
          let exists = false
          let rules = 0
          try {
            const names = readdirSync(entry.dir)
            exists = true
            for (const name of names) {
              if (!name.toLowerCase().endsWith('.md')) continue
              if (loadRuleFile(path.join(entry.dir, name), entry.layer) !== null) rules += 1
            }
          } catch {
            exists = false
          }
          return { dir: entry.dir, exists, rules }
        })
        const activeRules = composed.active.map((entry) => ({
          file: toSlash(entry.rule.file),
          source: layerLabel(entry.rule.layer),
          activation: activationLabel(entry.activation),
          id: entry.rule.id,
          priority: rulePriority(entry.rule, entry.activation),
          chars: entry.rule.chars,
          paths: entry.rule.paths,
        }))
        const layers = [
          {
            layer: '用户级',
            scanned: scanned.filter((rule) => rule.layer === 'user').length,
            active: composed.active.filter((entry) => entry.rule.layer === 'user').length,
          },
          {
            layer: '项目级',
            scanned: scanned.filter((rule) => rule.layer === 'project').length,
            active: composed.active.filter((entry) => entry.rule.layer === 'project').length,
          },
          {
            layer: '核心层',
            scanned: scanned.filter((rule) => rule.always).length,
            active: composed.active.filter((entry) => entry.activation === 'always').length,
          },
        ]
        return {
          enabled: true,
          ruleDirs: dirs,
          totalRules: dirs.reduce((sum, entry) => sum + entry.rules, 0),
          maxChars,
          maxAlwaysChars,
          layers,
          alwaysBudget: composed.always,
          pathBudget: composed.path,
          activeRules,
          triggeredRules: [...triggeredEver.values()].map((rule) => ({
            file: toSlash(rule.file),
            source: layerLabel(rule.layer),
            paths: rule.paths,
            chars: rule.chars,
          })),
        }
      },
    }),
  )
}
