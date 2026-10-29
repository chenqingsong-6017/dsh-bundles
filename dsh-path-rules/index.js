/**
 * dsh-path-rules —— 路径规则（path-scoped rules）
 *
 * 学谁：Claude Code 的 .claude/rules——规则文件头部写 paths: 通配符，
 * 只有当 agent 触及匹配的文件时，这条规则才进入上下文。
 *
 * 为什么需要它：DSH 现在的 AGENTS.md 是「全局、每轮、全量」注入。
 * 规则一多就互相稀释，而且和当前任务无关的规则也在花 token。
 * 路径规则把「什么时候该想起哪条纪律」变成自动的。
 *
 * 规则格式（项目级 <cwd>/.dsh/rules/*.md，用户级 $DSH_HOME/rules/*.md）：
 *
 *   ---
 *   paths:
 *     - "src/**\/*.ts"
 *     - "*.json"
 *   ---
 *   这里写规则正文，命中时进系统提示。
 *
 * 触发条件：read / write / edit / glob / grep 等工具的参数里出现
 * file_path / filePath / path，且相对当前工作目录的路径命中某条 glob。
 *
 * 已知边界（刻意不做）：
 *   - 不跟踪 shell 命令里提到的文件（只看结构化工具参数）
 *   - 规则目录只扫一层，不递归
 *   - 一次触发后在本会话内保持活跃（不自动退出），保证行为可预期
 *   - 不做语义匹配，只有 glob
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-path-rules'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const CONTEXT_ORDER = 850
const DEFAULT_MAX_CHARS = 3000
const MAX_RULE_BYTES = 32 * 1024
const PROJECT_RULES_SEGMENTS = ['.dsh', 'rules']
const USER_RULES_SUBDIR = 'rules'
const TOUCH_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'multi_edit', 'apply_patch'])
const PATH_ARG_NAMES = ['file_path', 'filePath', 'path']

const text = (value) => ({ type: 'text', text: value })
const toSlash = (value) => String(value).replaceAll('\\', '/')

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

/**
 * 解析一条规则文件：--- frontmatter --- 正文。
 * 没有 frontmatter、没有 paths、或正文为空都返回 null（静默跳过，不抛错）。
 */
export function parseRule(rawText) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(rawText).replace(/^\uFEFF/, '').trimStart())
  if (match === null) return null
  const body = match[2].trim()
  if (body === '') return null

  const paths = []
  let collecting = false
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^paths\s*:\s*$/.test(line)) {
      collecting = true
      continue
    }
    const inline = /^paths\s*:\s*(.+)$/.exec(line)
    if (inline !== null) {
      const parsed = parseInlineList(inline[1])
      if (parsed !== null) paths.push(...parsed)
      else paths.push(unquote(inline[1]))
      collecting = false
      continue
    }
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (item !== null && collecting) {
      paths.push(unquote(item[1]))
      continue
    }
    collecting = false
  }

  const clean = paths.map((item) => item.trim()).filter((item) => item !== '')
  if (clean.length === 0) return null
  return {
    paths: clean,
    body,
    regexps: clean.map((pattern) => expandBraces(pattern).map((expanded) => globToRegExp(expanded))),
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

// ---------- 插件 ----------

export function apply(ctx, config) {
  const maxChars = Number.isInteger(config?.maxChars) && config.maxChars > 0 ? config.maxChars : DEFAULT_MAX_CHARS
  const fileCache = new Map()
  const triggeredEver = new Map()
  const activeBySession = new WeakMap()
  const activeFallback = new Map()

  const dshHome = () => {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return path.join(os.homedir(), '.dsh')
  }

  let lastKnownCwd = ''
  const cwdOf = (session) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      const workingDirectory = service ?? ctx.workingDirectory
      if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value !== '') {
          lastKnownCwd = value
          return value
        }
      }
    } catch {
      /* 工作目录服务还没就绪时退回最近一次已知 cwd */
    }
    return lastKnownCwd === '' ? process.cwd() : lastKnownCwd
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

  const loadRuleFile = (filePath, source) => {
    try {
      const stat = statSync(filePath)
      if (!stat.isFile() || stat.size > MAX_RULE_BYTES) return null
      const cached = fileCache.get(filePath)
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.rule
      const parsed = parseRule(readFileSync(filePath, 'utf8'))
      const rule = parsed === null
        ? null
        : {
            file: filePath,
            source,
            paths: parsed.paths,
            body: parsed.body,
            regexps: parsed.regexps,
            chars: parsed.body.length,
          }
      fileCache.set(filePath, { mtimeMs: stat.mtimeMs, rule })
      return rule
    } catch {
      return null
    }
  }

  const ruleDirs = (cwd) => {
    const dirs = []
    if (typeof cwd === 'string' && cwd !== '') {
      dirs.push({ dir: path.join(cwd, ...PROJECT_RULES_SEGMENTS), source: '项目' })
    }
    dirs.push({ dir: path.join(dshHome(), USER_RULES_SUBDIR), source: '用户' })
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
        const rule = loadRuleFile(path.join(entry.dir, entryName), entry.source)
        if (rule !== null) rules.push(rule)
      }
    }
    return rules
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
      const map = activeMap(session)
      if (map.size === 0) return ''
      const cwd = cwdOf(session)
      const blocks = []
      let used = 0
      let omitted = 0
      for (const rule of map.values()) {
        const relative = toSlash(path.relative(cwd, rule.file))
        const display = relative.startsWith('..') ? toSlash(rule.file) : relative
        const chunk = '▌ ' + display + '（匹配 ' + rule.paths.join(' / ') + '）\n' + rule.body
        if (used + chunk.length > maxChars) {
          omitted += 1
          continue
        }
        blocks.push(chunk)
        used += chunk.length
      }
      if (blocks.length === 0) return ''
      const footer = omitted > 0
        ? '\n\n（另有 ' + omitted + ' 条路径规则超出本轮注入预算，未展开）\n</path-rules>'
        : '\n</path-rules>'
      return '<path-rules>\n以下路径规则因你触及了匹配的文件而生效：\n\n' + blocks.join('\n\n') + footer
    } catch {
      return ''
    }
  }

  // ---- 触发：工具动过某个文件后，检查命中的规则 ----
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    try {
      const toolName = String(exec?.name ?? '')
      if (!TOUCH_TOOLS.has(toolName)) return decision
      const raw = pickPath(exec?.arguments)
      if (raw === undefined) return decision
      const session = exec?.agent?.session ?? exec?.session
      const cwd = cwdOf(session)
      const relative = normalizePath(cwd, raw)
      if (relative === '') return decision
      const map = activeMap(session)
      for (const rule of scanRules(cwd)) {
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
  const statusSchema = {
    type: 'object',
    properties: {
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
      maxChars: { type: 'integer' },
    },
    required: ['ruleDirs', 'totalRules', 'triggeredRules', 'maxChars'],
    additionalProperties: false,
  }

  const statusRender = (_args, value) => {
    const dirs = Array.isArray(value?.ruleDirs) ? value.ruleDirs : []
    const triggered = Array.isArray(value?.triggeredRules) ? value.triggeredRules : []
    const lines = ['路径规则：共扫到 ' + (value?.totalRules ?? 0) + ' 条，本次运行触发过 ' + triggered.length + ' 条（注入预算 ' + (value?.maxChars ?? 0) + ' 字符）']
    for (const entry of dirs) {
      lines.push((entry.exists ? '✓ ' : '✗ ') + entry.dir + ' —— ' + entry.rules + ' 条')
    }
    if (triggered.length === 0) {
      lines.push('还没有规则被触发。做法：在 .dsh/rules/ 下建一个 .md，头部写 paths，正文写纪律。')
    } else {
      lines.push('已触发：')
      for (const rule of triggered) {
        lines.push('■ ' + rule.file + '（' + rule.source + '，' + rule.paths.join(' / ') + '，' + rule.chars + ' 字符）')
      }
    }
    return [text(lines.join('\n'))]
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'path_rules_status',
      description:
        'Diagnose the path-scoped rules plugin: which rule directories exist, how many rules were found, and which rules have fired in this run.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: statusSchema, render: statusRender },
      async execute(_args, exec) {
        const cwd = cwdOf(exec?.agent?.session)
        const dirs = ruleDirs(cwd).map((entry) => {
          let exists = false
          let rules = 0
          try {
            const names = readdirSync(entry.dir)
            exists = true
            for (const name of names) {
              if (!name.toLowerCase().endsWith('.md')) continue
              if (loadRuleFile(path.join(entry.dir, name), entry.source) !== null) rules += 1
            }
          } catch {
            exists = false
          }
          return { dir: entry.dir, exists, rules }
        })
        return {
          ruleDirs: dirs,
          totalRules: dirs.reduce((sum, entry) => sum + entry.rules, 0),
          triggeredRules: [...triggeredEver.values()].map((rule) => ({
            file: toSlash(rule.file),
            source: rule.source,
            paths: rule.paths,
            chars: rule.chars,
          })),
          maxChars,
        }
      },
    }),
  )
}
