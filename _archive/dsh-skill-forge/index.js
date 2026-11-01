/**
 * dsh-skill-forge —— 「经验 → 技能」的沉淀炉。
 *
 * 学谁：Hermes Agent 的 `/learn`（把任意材料变成可复用 SKILL.md）+ Curator（用量驱动的归档）。
 * 与 Hermes 的差别：
 *   - 不自己调模型生成长文：由 agent 在会话里把「刚做完的事」写成结构化草稿，本插件只负责
 *     **校验、落盘、注册、归档**。这样不会出现「插件偷偷改自己」的不可控问题。
 *   - 不走独立检索通道：用 DSH 官方的 `ctx.skills.registerProvider()` 把锻造出的技能
 *     **原生注入技能目录**，于是 `skill` 工具、用户 `/name` 调用、系统提示里的技能索引
 *     全都自动生效——跟官方技能一个待遇。
 *
 * 硬规矩（抄 Hermes 的 HARDLINE，理由是这些字段会进系统提示、影响路由）：
 *   - name：kebab-case，≤64 字符，与 DSH 的 SKILL_NAME 语法一致；
 *   - description：一句话，≤60 字符，必须能被截断前看懂（超了就永远路由不到）；
 *   - body 必须含「何时用 / 步骤 / 验证」三节——没有验证方式的技能等于不可信。
 *
 * 存储：`config.storeDir`（本机 D:\AI\dsh-data\skills），布局 `<category?>/<name>/SKILL.md`；
 * 归档进 `_archive/<name>-<时间戳>/`，不删除（可人工恢复）。
 *
 * 已知边界：
 *   - 技能目录由 DSH 收集器缓存（官方 DEFAULT_COLLECT_CACHE_ENTRIES），刚锻造的技能
 *     可能要到下一次收集才出现在提示里；`skill_forge_search` 立即就能查到。
 *   - 不做语义检索：技能体量小，名字 + 描述 + 关键词足够。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-skill-forge'
export const inject = ['tools', 'skills']

const PROVIDER = 'dsh-skill-forge'
/** 高于官方 bundled(600)，同名的自造技能优先于内置技能。 */
const FORGED_RANK = 700
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME_CHARS = 64
const MAX_DESC_CHARS = 60
const MAX_BODY_CHARS = 60000
const ARCHIVE_DIR = '_archive'
const DEFAULT_CATEGORY = 'misc'

const text = (value) => ({ type: 'text', text: value })

function storeRoot(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  if (override !== '') return path.resolve(override)
  const profile = process.env.DSH_PROFILE_DIR
  if (profile) return path.join(profile, 'skill-forge')
  return path.join(os.homedir(), '.dsh', 'skill-forge')
}

/** 解析 SKILL.md 的 YAML frontmatter（只认 name / description 两行，够用且不引依赖）。 */
export function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!match) return { name: '', description: '', content: raw.trim() }
  const yaml = match[1]
  const read = (key) => {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'mu').exec(yaml)
    if (!m) return ''
    return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return {
    name: read('name'),
    description: read('description'),
    content: raw.slice(match[0].length).trim(),
  }
}

/** 校验草稿；返回 { ok, errors }。纯函数，便于单测。 */
export function validateDraft({ name: skillName, description, body }) {
  const errors = []
  const n = typeof skillName === 'string' ? skillName.trim() : ''
  const d = typeof description === 'string' ? description.trim() : ''
  const b = typeof body === 'string' ? body.trim() : ''

  if (n === '') errors.push('name 不能为空。')
  else if (n.length > MAX_NAME_CHARS) errors.push(`name 最长 ${MAX_NAME_CHARS} 字符，当前 ${n.length}。`)
  else if (!SKILL_NAME_RE.test(n)) errors.push('name 必须是 kebab-case：小写字母/数字，用 - 连接，例如 nvidia-driver-upgrade。')

  if (d === '') errors.push('description 不能为空。')
  else if (d.length > MAX_DESC_CHARS) {
    errors.push(
      `description 最长 ${MAX_DESC_CHARS} 字符（系统提示里的技能索引会截断到该长度，超了等于没写），当前 ${d.length}。请精简。`,
    )
  } else if (!/[.。]$/u.test(d)) {
    errors.push('description 应以句号结尾（英文 . 或中文 。）。')
  }

  if (b === '') errors.push('body 不能为空。')
  else {
    if (b.length > MAX_BODY_CHARS) errors.push(`body 最长 ${MAX_BODY_CHARS} 字符，当前 ${b.length}。请把长材料拆到同目录的 references/。`)
    const hasUse = /^##\s*(何时用|when to use)/imu.test(b)
    const hasSteps = /^##\s*(步骤|steps|做法)/imu.test(b)
    const hasVerify = /^##\s*(验证|verify|verification)/imu.test(b)
    if (!hasUse) errors.push('body 缺少「## 何时用」一节。')
    if (!hasSteps) errors.push('body 缺少「## 步骤」一节。')
    if (!hasVerify) errors.push('body 缺少「## 验证」一节（没有验证方式的技能不可信）。')
  }
  return { ok: errors.length === 0, errors }
}

/** 渲染 SKILL.md 文本。 */
export function renderSkillFile({ name: skillName, description, body, createdAt }) {
  const when = createdAt || new Date().toISOString()
  return [
    '---',
    `name: ${skillName}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  source: forged',
    `  created: ${when}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}

/** 递归扫描技能根目录，跳过 _archive 与隐藏目录。 */
export function scanSkills(root) {
  const found = []
  const walk = (dir) => {
    let items = []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (!item.isDirectory()) continue
      if (item.name.startsWith('.') || item.name === ARCHIVE_DIR) continue
      const child = path.join(dir, item.name)
      const skillFile = path.join(child, 'SKILL.md')
      if (existsSync(skillFile)) {
        try {
          const parsed = parseFrontmatter(readFileSync(skillFile, 'utf8'))
          const fallbackName = item.name
          const skillName = SKILL_NAME_RE.test(parsed.name) ? parsed.name : fallbackName
          if (parsed.description) {
            found.push({
              name: skillName,
              description: parsed.description,
              category: path.basename(path.dirname(child)),
              dir: child,
              locator: skillFile,
            })
          }
        } catch {
          /* 坏文件跳过，不阻断整张目录 */
        }
      } else {
        walk(child)
      }
    }
  }
  walk(root)
  return found
}

function toCandidate(entry) {
  return {
    name: entry.name,
    description: entry.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'forged',
    rank: FORGED_RANK,
    resourceBase: { kind: 'directory', path: entry.dir },
    locator: entry.locator,
  }
}

export function apply(ctx, config) {
  const root = storeRoot(config?.storeDir)
  const tools = ctx.tools
  mkdirSync(root, { recursive: true })

  // ---- 原生技能注册：让锻造出的技能进 DSH 的技能目录 ----
  ctx.effect(function* () {
    const provider = {
      name: PROVIDER,
      async list() {
        return scanSkills(root).map(toCandidate)
      },
      async get(entry) {
        const { rank: _rank, locator, ...summary } = entry
        const raw = readFileSync(locator, 'utf8')
        const parsed = parseFrontmatter(raw)
        return { ...summary, content: parsed.content }
      },
    }
    yield ctx.skills.registerProvider(() => provider)
  }, 'forged skill provider')

  // ---- 工具 1：锻造 ----
  ctx.effect(() =>
    tools.register({
      name: 'skill_forge',
      description:
        'Turn work you just finished into a reusable skill (SKILL.md) registered in the native skill catalog. Use after a task succeeds and its steps are worth repeating. Requires name (kebab-case), a one-sentence description (<=60 chars), and a body with the sections "## 何时用 / ## 步骤 / ## 验证".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'kebab-case skill name, <=64 chars, e.g. nvidia-driver-upgrade.' },
          description: { type: 'string', description: 'ONE sentence, <=60 chars, ends with a period. Shown in the skill index.' },
          body: { type: 'string', description: 'Markdown body. Must contain "## 何时用", "## 步骤", "## 验证".' },
          category: { type: 'string', description: `Optional bucket folder, default "${DEFAULT_CATEGORY}". e.g. windows, dev, docs.` },
          overwrite: { type: 'boolean', description: 'Replace an existing skill with the same name (the old copy is archived).' },
        },
        required: ['name', 'description', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string' },
            category: { type: 'string' },
            archived: { type: 'string' },
          },
          required: ['name', 'path', 'category'],
          additionalProperties: false,
        },
        render(_args, value) {
          const extra = value?.archived ? `\n旧版已归档：${value.archived}` : ''
          return [text(`技能已锻造：${value?.name}\n落盘：${value?.path}${extra}\n（下一次技能收集后出现在技能目录；skill_forge_search 可立即查到）`)]
        },
      },
      async execute(args) {
        const skillName = typeof args?.name === 'string' ? args.name.trim() : ''
        const description = typeof args?.description === 'string' ? args.description.trim() : ''
        const body = typeof args?.body === 'string' ? args.body.trim() : ''
        const verdict = validateDraft({ name: skillName, description, body })
        if (!verdict.ok) throw new Error('技能不合规矩，未写入：\n- ' + verdict.errors.join('\n- '))

        const rawCategory = typeof args?.category === 'string' ? args.category.trim() : ''
        const category = rawCategory === '' ? DEFAULT_CATEGORY : rawCategory.replace(/[^a-zA-Z0-9_-]/g, '')
        const dir = path.join(root, category, skillName)
        let archived = ''

        if (existsSync(dir)) {
          if (args?.overwrite !== true) {
            throw new Error(`技能 ${skillName} 已存在：${dir}\n要替换请传 overwrite: true（旧版会归档到 ${ARCHIVE_DIR}/）。`)
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const archiveDir = path.join(root, ARCHIVE_DIR, `${skillName}-${stamp}`)
          mkdirSync(path.dirname(archiveDir), { recursive: true })
          renameSync(dir, archiveDir)
          archived = archiveDir
        }

        mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'SKILL.md')
        writeFileSync(file, renderSkillFile({ name: skillName, description, body }), 'utf8')
        return { name: skillName, path: file, category, ...(archived ? { archived } : {}) }
      },
    }),
  )

  // ---- 工具 2：检索 ----
  ctx.effect(() =>
    tools.register({
      name: 'skill_forge_search',
      description:
        'Search forged skills by keyword across name, description and body. Use it when the injected skill index does not obviously contain what you need.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; space-separated terms are AND-weighted.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results, default 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, score: { type: 'integer' } },
                required: ['name', 'description', 'category', 'score'],
                additionalProperties: false,
              },
            },
          },
          required: ['matches'],
          additionalProperties: false,
        },
        render(_args, value) {
          const list = value?.matches ?? []
          if (list.length === 0) return [text('没有匹配的自造技能。可用 skill_forge 把这次做法沉淀下来。')]
          return [text(list.map((m) => `- ${m.name} [${m.category}] ${m.description}`).join('\n'))]
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('skill_forge_search 需要 query。')
        const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 20) : 5
        const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
        const matches = []
        for (const entry of scanSkills(root)) {
          let haystack = `${entry.name} ${entry.description}`
          try {
            haystack += ' ' + readFileSync(entry.locator, 'utf8').toLowerCase()
          } catch {
            /* 读不到就按名字+描述打分 */
          }
          const lower = haystack.toLowerCase()
          let score = 0
          for (const term of terms) {
            if (lower.includes(term)) score += 1
            if (entry.name.includes(term)) score += 3
            if (entry.description.toLowerCase().includes(term)) score += 2
          }
          if (score > 0) matches.push({ name: entry.name, description: entry.description, category: entry.category, score })
        }
        matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        return { matches: matches.slice(0, limit) }
      },
    }),
  )

  // ---- 工具 3：归档 ----
  ctx.effect(() =>
    tools.register({
      name: 'skill_forge_retire',
      description:
        'Retire a forged skill: move it to the _archive folder so it stops appearing in the skill catalog. Nothing is deleted; a human can restore it.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Forged skill name to retire.' } },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, archivedTo: { type: 'string' } },
          required: ['name', 'archivedTo'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(`已归档：${value?.name}\n位置：${value?.archivedTo}\n（未删除，可从该目录搬回原处以恢复）`)]
        },
      },
      async execute(args) {
        const skillName = typeof args?.name === 'string' ? args.name.trim() : ''
        if (skillName === '') throw new Error('skill_forge_retire 需要 name。')
        const entry = scanSkills(root).find((item) => item.name === skillName)
        if (!entry) throw new Error(`找不到自造技能：${skillName}。用 skill_forge_search 确认名字。`)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const archiveDir = path.join(root, ARCHIVE_DIR, `${skillName}-${stamp}`)
        mkdirSync(path.dirname(archiveDir), { recursive: true })
        renameSync(entry.dir, archiveDir)
        return { name: skillName, archivedTo: archiveDir }
      },
    }),
  )
}
