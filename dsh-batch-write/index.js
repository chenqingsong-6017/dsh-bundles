/**
 * dsh-batch-write v0.1.0 —— 把「记得用 _ops/bulk-write.mjs」这条提示词规则下沉成工具。
 *
 * 一次调用改 N 个文件：内部先 read 再写（绕开 read-before-write 摩擦），
 * 默认 dry-run，落盘前备份，受保护路径一律拒绝。
 *
 * 与 _ops/bulk-write.mjs 同一份口径，但不再需要模型「记得」去调脚本。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-batch-write'
export const inject = ['tools', 'workingDirectory']

const DEFAULT_BACKUP = 'D:\\AI\\dsh-data\\batch-write\\backup'
// 自保护：护栏、规则、凭据、系统目录一律不经此通道
const DENY = [
  '.dsh/rules/', '.dsh/hooks', 'hooks.json', 'guard-', '_ops/net-guard.mjs',
  'C:/Windows', 'C:/Program Files', '/.ssh/', '.credentials', '.npmrc',
]

const norm = (p) => String(p || '').replace(/\\/g, '/')
const hitDeny = (abs) => DENY.some((d) => norm(abs).includes(d))
const text = (v) => ({ type: 'text', text: v })
const fail = (code, message) => Object.assign(new Error(message), { code })

export function apply(ctx, config) {
  const cfg = config || {}
  const backupRoot = String(cfg.backupDir || DEFAULT_BACKUP)
  const configuredWorkspaceDir = typeof cfg.workspaceDir === 'string' ? cfg.workspaceDir : ''
  const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  let last = null
  let lastDryKey = '' // B4 write gate：apply 前必须用完全相同的 ops 跑过 dry-run

  function opsKey(ops) {
    try {
      return createHash('sha256').update(JSON.stringify(ops)).digest('hex').slice(0, 16)
    } catch {
      return ''
    }
  }

  async function baseOf(exec) {
    if (wd && typeof wd.ensure === 'function' && exec && exec.agent) {
      const ensured = await wd.ensure(exec.agent, exec.signal).catch(() => undefined)
      if (typeof ensured === 'string' && ensured.trim() !== '') return { base: path.resolve(ensured.trim()), source: 'workingDirectory' }
    }
    if (configuredWorkspaceDir !== '') return { base: path.resolve(configuredWorkspaceDir), source: 'workspaceDir' }
    throw fail('BATCH_NO_WORKSPACE', '拿不到会话工作目录，也没有配置 workspaceDir。请传绝对路径，或设 config.workspaceDir。')
  }

  function runOps(ops, willApply, base) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(backupRoot, ts)
    const results = []
    let changed = 0, unchanged = 0, failed = 0
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i] || {}
      const label = String(op.path || '(no path)')
      try {
        if (!op.path) throw fail('BATCH_NO_PATH', '缺少 path')
        const abs = path.isAbsolute(String(op.path)) ? path.resolve(String(op.path)) : path.resolve(base, String(op.path))
        if (hitDeny(abs)) throw fail('BATCH_DENY', '该路径受保护，不经批量通道改：' + abs)
        const exists = existsSync(abs)
        const before = exists ? readFileSync(abs, 'utf8') : ''
        let after = before
        if (op.mode === 'write') after = String(op.content ?? '')
        else if (op.mode === 'append') after = before + String(op.content ?? '')
        else if (op.mode === 'replace') {
          const oldS = String(op.old ?? ''), newS = String(op.new ?? '')
          if (!oldS) throw fail('BATCH_NO_OLD', 'replace 缺少 old')
          const hits = before.split(oldS).length - 1
          if (hits === 0) throw fail('BATCH_OLD_MISS', 'old 未命中（文件里没有这段）')
          if (hits > 1 && !op.all) throw fail('BATCH_OLD_AMBIGUOUS', 'old 命中 ' + hits + ' 处，歧义；给更多上下文或用 all:true')
          after = op.all ? before.split(oldS).join(newS) : before.replace(oldS, newS)
        } else throw fail('BATCH_BAD_MODE', '未知 mode: ' + op.mode)
        if (after === before) { unchanged += 1; results.push({ path: label, status: 'unchanged', delta: 0 }); continue }
        if (willApply) {
          mkdirSync(backupDir, { recursive: true })
          if (exists) copyFileSync(abs, path.join(backupDir, i + '-' + path.basename(abs)))
          mkdirSync(path.dirname(abs), { recursive: true })
          writeFileSync(abs, after, 'utf8')
        }
        changed += 1
        results.push({ path: label, status: willApply ? 'written' : 'would-write', delta: after.length - before.length })
      } catch (e) {
        failed += 1
        results.push({ path: label, status: 'FAIL', delta: 0, error: String(e?.code || '') + ' ' + String(e?.message || e) })
      }
    }
    return { results, changed, unchanged, failed, backupDir: willApply && changed ? backupDir : '' }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'batch_write',
    description:
      'Batch file edits in one call: N files, auto read-before-write, dry-run by default, backup before write. Prefer it over many read+write/edit pairs (and over _ops/bulk-write.mjs) when touching 2+ files. Modes: write (replace whole file), append, replace (old to new; old must be unique unless all:true). Protected paths (rules, hooks, credentials, system dirs) are always refused.',
    parameters: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'Edits, applied in order. Relative paths resolve against the session working directory.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              mode: { type: 'string', enum: ['write', 'append', 'replace'] },
              old: { type: 'string', description: 'replace: literal text to replace' },
              new: { type: 'string', description: 'replace: replacement' },
              content: { type: 'string', description: 'write/append: text' },
              all: { type: 'boolean', description: 'replace: replace every match' },
            },
            required: ['path', 'mode'],
            additionalProperties: false,
          },
        },
        apply: { type: 'boolean', description: 'false (default) = dry-run, writes nothing; true = write and back up.' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          applied: { type: 'boolean' },
          base: { type: 'string' },
          baseSource: { type: 'string' },
          changed: { type: 'integer' },
          unchanged: { type: 'integer' },
          failed: { type: 'integer' },
          backupDir: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                status: { type: 'string' },
                delta: { type: 'integer' },
                error: { type: 'string' },
              },
              required: ['path', 'status', 'delta'],
              additionalProperties: false,
            },
          },
        },
        required: ['applied', 'base', 'baseSource', 'changed', 'unchanged', 'failed', 'backupDir', 'results'],
        additionalProperties: false,
      },
      render(_args, value) {
        const head = (value.applied ? '已应用' : '预演（dry-run，未落盘）') + ' · 变更 ' + value.changed + ' · 未变 ' + value.unchanged + ' · 失败 ' + value.failed
        const lines = (value.results || []).map((r) => {
          const tag = r.status === 'FAIL' ? 'FAIL' : r.status === 'unchanged' ? ' -- ' : ' ok '
          return '[' + tag + '] ' + String(r.path).padEnd(56) + ' ' + r.status + (r.delta ? ' (' + (r.delta > 0 ? '+' : '') + r.delta + 'B)' : '') + (r.error ? '  ' + r.error : '')
        })
        const tail = value.backupDir ? '\n备份：' + value.backupDir : (value.applied ? '' : '\n落盘请再调一次 apply:true')
        return [text(head + '\n' + lines.join('\n') + tail)]
      },
    },
    async execute(args, exec) {
      const ops = Array.isArray(args?.ops) ? args.ops : []
      if (!ops.length) throw fail('BATCH_NO_OPS', 'ops 为空')
      const willApply = args?.apply === true
      const { base, source } = await baseOf(exec)
      const key = opsKey(ops)
      if (willApply && key !== lastDryKey) {
        throw fail('BATCH_NO_PREVIEW', 'write gate：apply 前必须先用完全相同的 ops 跑一次 dry-run 预览。先不带 apply 调一次、确认 would-write 结果无误，再原样传 apply:true。')
      }
      const r = runOps(ops, willApply, base)
      if (!willApply && r.failed === 0) lastDryKey = key
      last = { at: new Date().toISOString(), applied: willApply, changed: r.changed, failed: r.failed, base }
      return { applied: willApply, base, baseSource: source, ...r }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'batch_write_status',
    description: 'Readiness of the batch writer: tool mounted, backup root, protected-path rules, last run. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
          backupRoot: { type: 'string' },
          denyCount: { type: 'integer' },
          lastRun: { type: 'string' },
        },
        required: ['ready', 'backupRoot', 'denyCount', 'lastRun'],
        additionalProperties: false,
      },
      render(_a, v) { return [text('batch_write 就绪 · 备份根 ' + v.backupRoot + ' · 保护规则 ' + v.denyCount + ' 条 · 上次运行 ' + (v.lastRun || '无'))] },
    },
    async execute() {
      return { ready: true, backupRoot, denyCount: DENY.length, lastRun: last ? JSON.stringify(last) : '' }
    },
  }))
}