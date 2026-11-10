/**
 * dsh-skill-forge —— 学习循环：事实信号 -> skill 候选 -> 复核入库。
 *
 * 官方组合包入口规范：export const name / inject / apply，只允许命名导出。
 * 工具契约（对齐官方 adding-a-tool）：每个工具都声明 output.schema + render，
 * 参数显式 additionalProperties:false，业务校验抛异常 = isError。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_HARVEST,
  DEFAULT_STORE,
  CANDIDATE_FILE,
  readCandidates,
  run,
  status,
  admitSkill,
  verifyCandidate,
} from './lib/core.js'

export const name = 'skill-forge'
export const inject = ['tools']

/** render 统一产物：一条文本块。 */
const text = (value) => ({ type: 'text', text: String(value) })

const fail = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}

/** 默认 skill 根：<dshHome>/skills（官方 dsh-skill-filesystem 的 rank 400 user-dsh 根）。 */
function defaultSkillsRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  return path.join(home, 'skills')
}

export function apply(ctx, config) {
  const cfg = config || {}
  const harvestDir = String(cfg.harvestDir || DEFAULT_HARVEST)
  const storeDir = String(cfg.storeDir || DEFAULT_STORE)
  const skillsRoot = String(cfg.skillsRoot || defaultSkillsRoot())
  const options = () => ({ harvestDir, storeDir, skillsRoot })
  let lastError = ''

  // ---- 1. status：只读健康度 ----
  ctx.tools.register({
    name: 'skill_forge_status',
    description: '学习循环就绪状态：harvest 候选多少条、skill 候选多少条、待审几条、技能根在哪。只读；改任何东西前先看它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
          harvestDir: { type: 'string' },
          storeDir: { type: 'string' },
          skillsRoot: { type: 'string' },
          harvestCandidates: { type: 'integer' },
          harvestEpisodes: { type: 'integer' },
          candidates: { type: 'integer' },
          pending: { type: 'integer' },
          admitted: { type: 'integer' },
          badLines: { type: 'integer' },
          lastError: { type: 'string' },
        },
        required: ['ready', 'storeDir', 'harvestDir', 'skillsRoot', 'harvestCandidates', 'candidates', 'pending'],
        additionalProperties: false,
      },
      render(_args, value) {
        const warn = value.badLines > 0 ? ' | 警告 ' + value.badLines + ' 行候选文件损坏（已跳过）' : ''
        const err = value.lastError ? ' | 上次错误：' + value.lastError : ''
        return [text(
          '技能蒸馏：harvest 候选 ' + value.harvestCandidates + ' 条 -> skill 候选 ' + value.candidates +
          ' 条（待审 ' + value.pending + '，已入库 ' + value.admitted + '）' +
          ' | 技能根：' + value.skillsRoot +
          ' | 数据：' + value.storeDir + warn + err
        )]
      },
    },
    async execute() {
      try {
        const result = status(options())
        lastError = ''
        return Object.assign({ lastError: '' }, result)
      } catch (error) {
        lastError = String((error && error.message) || error)
        throw fail('SFE_STATUS_FAILED', 'skill_forge_status 失败：' + lastError)
      }
    },
  })

  // ---- 2. run：主流程（读 harvest -> 聚类 -> 蒸馏候选） ----
  ctx.tools.register({
    name: 'skill_forge_run',
    description: '学习循环主流程：读 harvest 的事实候选（纠错/规则），按项目聚类，蒸馏出带证据链的 skill 候选。零 LLM、幂等；只写候选，不自动入库。',
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'number', minimum: 0.3, maximum: 0.95, description: '同主题聚类相似度阈值（默认 0.62；调低聚合更松）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scanned: { type: 'integer' },
          signals: { type: 'integer' },
          clusters: { type: 'integer' },
          created: { type: 'integer' },
          skipped: { type: 'integer' },
        },
        required: ['scanned', 'signals', 'clusters', 'created', 'skipped'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [text(
          '扫了 ' + value.scanned + ' 条 harvest 候选 -> 挑出 ' + value.signals + ' 条流程/坑信号 -> 聚成 ' +
          value.clusters + ' 组 -> 新增 ' + value.created + ' 个 skill 候选' +
          (value.skipped > 0 ? '（' + value.skipped + ' 个已存在，跳过）' : '') +
          ' | 下一步：skill_forge_candidates 看待审，复核后 skill_forge_admit 入库。'
        )]
      },
    },
    async execute(args) {
      const threshold = typeof args?.threshold === 'number' ? args.threshold : undefined
      try {
        const result = run(Object.assign(options(), { threshold }))
        lastError = ''
        return result
      } catch (error) {
        lastError = String((error && error.message) || error)
        throw fail('SFE_RUN_FAILED', 'skill_forge_run 失败：' + lastError)
      }
    },
  })

  // ---- 3. candidates：看待审候选 ----
  ctx.tools.register({
    name: 'skill_forge_candidates',
    description: '查看蒸馏出的 skill 候选（证据条数、置信度、状态）。复核正文用 read 直接读 SKILL.md。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'admitted', 'all'], description: 'pending（默认）/ admitted / all' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条（默认 20）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          shown: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                whenToUse: { type: 'string' },
                confidence: { type: 'string' },
                status: { type: 'string' },
                evidenceCount: { type: 'integer' },
              },
              required: ['id', 'name', 'description', 'confidence', 'status', 'evidenceCount'],
              additionalProperties: false,
            },
          },
        },
        required: ['total', 'shown', 'items'],
        additionalProperties: false,
      },
      render(_args, value) {
        if (value.shown === 0) return [text('没有' + (value.total === 0 ? '' : '符合条件的') + '候选。先 skill_forge_run 蒸馏。')]
        const list = value.items.map((item) =>
          '  [' + item.confidence + '] ' + item.name + ' (' + item.id + ')' +
          ' | ' + item.description +
          ' | 触发：' + (item.whenToUse || '?') +
          ' | 证据 ' + item.evidenceCount + ' 条 | 状态 ' + item.status
        ).join('\n')
        return [text('共 ' + value.total + ' 条，显示 ' + value.shown + ' 条：\n' + list)]
      },
    },
    async execute(args) {
      const filter = typeof args?.status === 'string' ? args.status : 'pending'
      const limit = Number.isInteger(args?.limit) ? args.limit : 20
      try {
        const { records } = readCandidates(options())
        const filtered = records.filter((c) => c && (filter === 'all' ? true : c.status === filter))
        const items = filtered.slice(0, limit).map((c) => ({
          id: String(c.id || ''),
          name: String(c.name || ''),
          description: String(c.description || ''),
          whenToUse: String(c.whenToUse || ''),
          confidence: String(c.confidence || 'medium'),
          status: String(c.status || 'pending'),
          evidenceCount: Array.isArray(c.evidence) ? c.evidence.length : 0,
        }))
        lastError = ''
        return { total: filtered.length, shown: items.length, items }
      } catch (error) {
        lastError = String((error && error.message) || error)
        throw fail('SFE_CANDIDATES_FAILED', 'skill_forge_candidates 失败：' + lastError)
      }
    },
  })

  // ---- 4. admit：采纳入库（危险动作要 confirm） ----
  ctx.tools.register({
    name: 'skill_forge_admit',
    description: '把一条 skill 候选写成 <技能根>/<name>/SKILL.md（status=draft）。危险动作：必须 confirm:true；同名已存在不覆盖，除非 force:true。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '候选 id（skill_forge_candidates 里看到的 sf-xxxx）' },
        confirm: { type: 'boolean', description: '必须为 true 才真的写文件（危险动作确认门）' },
        force: { type: 'boolean', description: '同名 SKILL.md 已存在时也覆盖（默认 false）' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          name: { type: 'string' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok', 'id'],
        additionalProperties: false,
      },
      render(_args, value) {
        if (value.ok) {
          return [text('已入库：' + value.name + ' | 路径：' + value.path + ' | 状态 draft —— 复核后把 metadata.status 改为 stable。')]
        }
        return [text('未入库：' + (value.reason || '未知原因'))]
      },
    },
    async execute(args) {
      const id = String(args?.id || '')
      if (id.trim() === '') throw fail('SFE_ARG_MISSING', 'skill_forge_admit 需要 id。')
      if (args?.confirm !== true) throw fail('SFE_CONFIRM_REQUIRED', 'skill_forge_admit 会写技能文件，必须传 confirm:true。')
      try {
        const { records } = readCandidates(options())
        const candidate = records.find((c) => c && c.id === id)
        if (!candidate) throw fail('SFE_NOT_FOUND', '找不到候选 ' + id + '（先 skill_forge_run + skill_forge_candidates）。')
        const verified = verifyCandidate(candidate)
        if (!verified.ok) throw fail('SFE_VERIFY_FAILED', '候选未通过 held-out 检查：' + verified.problems.join(', '))
        const result = admitSkill(candidate, Object.assign(options(), { force: args?.force === true }))
        if (!result.ok) throw fail('SFE_ADMIT_FAILED', result.reason || '写入失败')
        const next = records.map((c) => (c && c.id === id ? Object.assign({}, c, { status: 'admitted', admittedAt: Date.now() }) : c))
        writeFileSync(path.join(storeDir, CANDIDATE_FILE), next.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
        lastError = ''
        return { ok: true, id, name: String(candidate.name), path: result.path }
      } catch (error) {
        lastError = String((error && error.message) || error)
        throw error
      }
    },
  })

  // ---- 5. verify：held-out 检查 ----
  ctx.tools.register({
    name: 'skill_forge_verify',
    description: 'held-out 检查一条候选能否入库：证据是否带 session/quote、是否有触发条件与步骤。Voyager 的规矩——过不了检查的不留在库里。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '候选 id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          problems: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'id', 'problems'],
        additionalProperties: false,
      },
      render(_args, value) {
        if (value.ok) return [text('候选 ' + value.id + ' 通过 held-out 检查，可入库。')]
        return [text('候选 ' + value.id + ' 未通过：' + value.problems.join(', '))]
      },
    },
    async execute(args) {
      const id = String(args?.id || '')
      if (id.trim() === '') throw fail('SFE_ARG_MISSING', 'skill_forge_verify 需要 id。')
      const { records } = readCandidates(options())
      const candidate = records.find((c) => c && c.id === id)
      if (!candidate) throw fail('SFE_NOT_FOUND', '找不到候选 ' + id)
      const result = verifyCandidate(candidate)
      lastError = ''
      return { ok: result.ok, id, problems: result.problems }
    },
  })
}
