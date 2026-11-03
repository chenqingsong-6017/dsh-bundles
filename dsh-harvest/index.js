/**
 * dsh-harvest v0.1.0 — 先榨后删。
 *
 * 工具：
 *   harvest_status      就绪状态（会话可读、候选库位置、待审数量）
 *   harvest_run         扫会话→抽候选（幂等，按 mtime 跳过）
 *   harvest_candidates  看待审候选（带证据）
 *   harvest_gate        删除闸门：没被 harvest 覆盖的会话不许删
 *
 * 设计主见见 lib/core.js 顶部注释；数据默认落 D:\AI\dsh-data\harvest。
 */
import { DEFAULT_STORE, defaultSessionsRoot, gate, readCandidates, scan, status } from './lib/core.js'
import { workspaceStatus } from './lib/workspace.js'

export const name = 'dsh-harvest'
export const inject = ['tools']

const text = (value) => ({ type: 'text', text: value })

export function apply(ctx, config) {
  const cfg = config || {}
  const storeDir = String(cfg.storeDir || DEFAULT_STORE)
  const sessionsRoot = String(cfg.sessionsRoot || defaultSessionsRoot())
  const workspaceFile = String(cfg.workspaceFile || '')
  let lastError = ''

  const options = () => ({ storeDir: storeDir, sessionsRoot: sessionsRoot })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'harvest_status',
      description:
        'Readiness of the session-to-memory harvester: can it read sessions, where candidates live, how many are pending. Read-only; nothing is injected into the prompt.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            sessionsRoot: { type: 'string' },
            storeDir: { type: 'string' },
            sessionFiles: { type: 'integer' },
            processedSessions: { type: 'integer' },
            candidates: { type: 'integer' },
            pending: { type: 'integer' },
            lastError: { type: 'string' },
          },
          required: ['ready'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value || value.ready !== true) return [text('harvest 未就绪：' + String((value && value.unavailableReason) || '未知原因'))]
          return [text('harvest 就绪：会话 ' + value.sessionFiles + ' 个，已处理 ' + value.processedSessions + ' 个，候选 ' + value.pending + ' 条待审')]
        },
      },
      async execute() {
        try {
          const result = status(options())
          return Object.assign(result, { lastError: lastError })
        } catch (error) {
          lastError = String((error && error.message) || error)
          return { ready: false, unavailableReason: 'harvest_status 失败: ' + lastError, sessionsRoot: sessionsRoot, storeDir: storeDir, sessionFiles: 0, processedSessions: 0, candidates: 0, pending: 0, lastError: lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'harvest_run',
      description:
        'Harvest local sessions into evidence-bearing memory candidates (rules/corrections/preferences only). Idempotent: already-processed sessions are skipped by file mtime. Writes candidates to the D: store; never writes memory directly.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Only sessions whose cwd ends with this path (optional).' },
          session: { type: 'string', description: 'Only this session id, with or without the session- prefix (optional).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max sessions to process this run (default all).' },
          redo: { type: 'boolean', description: 'Reprocess sessions even if already harvested (default false).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            scanned: { type: 'integer' },
            skipped: { type: 'integer' },
            candidatesAdded: { type: 'integer' },
            episodesAdded: { type: 'integer' },
            pendingTotal: { type: 'integer' },
            processedSessions: { type: 'integer' },
            errors: { type: 'array', items: { type: 'string' } },
            samples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  text: { type: 'string' },
                  session: { type: 'string' },
                  seq: { type: 'integer' },
                },
              },
            },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value || value.ok !== true) {
            const reasons = value && Array.isArray(value.errors) && value.errors.length > 0 ? value.errors.join('；') : '未知原因'
            return [text('harvest 未完成：' + reasons)]
          }
          return [text('本会话榨取完成：处理 ' + value.scanned + ' 个、跳过 ' + value.skipped + ' 个、新增候选 ' + value.candidatesAdded + ' 条；候选库共 ' + value.pendingTotal + ' 条待审')]
        },
      },
      async execute(args) {
        try {
          const result = scan(Object.assign(options(), {
            workspace: args && args.workspace ? String(args.workspace) : '',
            sessionId: args && args.session ? String(args.session) : '',
            limit: args && args.limit ? Number(args.limit) : 0,
            redo: Boolean(args && args.redo),
          }))
          return {
            ok: result.ok,
            scanned: result.scanned,
            skipped: result.skipped,
            candidatesAdded: result.candidatesAdded,
            episodesAdded: result.episodesAdded,
            pendingTotal: result.pendingTotal,
            processedSessions: result.processedSessions,
            errors: result.errors,
            samples: result.samples.map((item) => ({ type: item.type, text: item.text, session: item.evidence ? item.evidence.session : '', seq: item.evidence ? item.evidence.seq : 0 })),
          }
        } catch (error) {
          lastError = String((error && error.message) || error)
          return { ok: false, scanned: 0, skipped: 0, candidatesAdded: 0, episodesAdded: 0, pendingTotal: 0, processedSessions: 0, errors: [lastError], samples: [] }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'harvest_candidates',
      description:
        'List harvested memory candidates with their evidence (session, seq, time). Reviewable; nothing is written to memory until a human or agent accepts it via memory_add.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'all'], description: 'Filter by status (default pending).' },
          keyword: { type: 'string', description: 'Case-insensitive substring filter over candidate text.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max items (default 20).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            matched: { type: 'integer' },
            total: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  text: { type: 'string' },
                  session: { type: 'string' },
                  seq: { type: 'integer' },
                  time: { type: 'integer' },
                  status: { type: 'string' },
                },
              },
            },
          },
          required: ['matched'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text('候选 ' + ((value && value.matched) || 0) + ' 条（共 ' + ((value && value.total) || 0) + ' 条）')]
        },
      },
      async execute(args) {
        try {
          const result = readCandidates(Object.assign(options(), {
            status: args && args.status ? String(args.status) : 'pending',
            keyword: args && args.keyword ? String(args.keyword) : '',
            limit: args && args.limit ? Number(args.limit) : 20,
          }))
          return {
            matched: result.matched,
            total: result.total,
            items: result.items.map((item) => ({
              id: item.id,
              type: item.type,
              text: item.text,
              session: item.evidence ? item.evidence.session : '',
              seq: item.evidence ? item.evidence.seq : 0,
              time: item.evidence ? item.evidence.time : 0,
              status: item.status || 'pending',
            })),
          }
        } catch (error) {
          lastError = String((error && error.message) || error)
          return { matched: 0, total: 0, items: [] }
        }
      },
    }),
  )


  ctx.effect(() =>
    ctx.tools.register({
      name: 'workspace_status',
      description:
        'Audit DSH workspaces against disk and harvest coverage: per-workspace session counts, stale references, orphaned sessions, sizes, archived count. Read-only; run before deleting any session or workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            workspaceFile: { type: 'string' },
            workspaces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  path: { type: 'string' },
                  sessions: { type: 'integer' },
                  present: { type: 'integer' },
                  missing: { type: 'integer' },
                  harvested: { type: 'integer' },
                  archived: { type: 'integer' },
                  bytes: { type: 'integer' },
                },
              },
            },
            drift: {
              type: 'object',
              properties: {
                missingTotal: { type: 'integer' },
                missingByWorkspace: { type: 'object', additionalProperties: true },
                orphanSessions: { type: 'array', items: { type: 'string' } },
              },
            },
            totals: { type: 'object', additionalProperties: true },
            lastError: { type: 'string' },
          },
          required: ['ready'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value || value.ready !== true) return [text('工作区审计未就绪：' + String((value && value.unavailableReason) || '未知原因'))]
          const drift = value.drift || {}
          const totals = value.totals || {}
          return [text('工作区 ' + (totals.workspaces || 0) + ' 个，磁盘会话 ' + (totals.onDisk || 0) + ' 个；引用缺失 ' + (drift.missingTotal || 0) + ' 个，未登记会话 ' + ((drift.orphanSessions || []).length) + ' 个')]
        },
      },
      async execute() {
        try {
          return workspaceStatus({ storeDir: storeDir, sessionsRoot: sessionsRoot, workspaceFile: workspaceFile })
        } catch (error) {
          lastError = String((error && error.message) || error)
          return { ready: false, unavailableReason: 'workspace_status 失败: ' + lastError, workspaceFile: '', workspaces: [], drift: { missingTotal: 0, missingByWorkspace: {}, orphanSessions: [] }, totals: {}, lastError: lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'harvest_gate',
      description:
        'Deletion gate: refuse to delete sessions that have no harvest record. Call before deleting any session files; if blocked, run harvest_run first.',
      parameters: {
        type: 'object',
        properties: {
          sessions: { type: 'array', items: { type: 'string' }, description: 'Session ids (with or without the session- prefix) you intend to delete.' },
        },
        required: ['sessions'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            allowed: { type: 'boolean' },
            checked: { type: 'integer' },
            covered: { type: 'array', items: { type: 'string' } },
            missing: { type: 'array', items: { type: 'string' } },
            hint: { type: 'string' },
          },
          required: ['allowed'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value || value.allowed !== true) return [text('闸门拒绝：有 ' + ((value && value.missing && value.missing.length) || 0) + ' 个会话没被 harvest 覆盖，先榨再删。')]
          return [text('闸门放行：' + value.checked + ' 个会话都有 harvest 记录。')]
        },
      },
      async execute(args) {
        try {
          return gate(Object.assign(options(), { sessionIds: args && Array.isArray(args.sessions) ? args.sessions : [] }))
        } catch (error) {
          lastError = String((error && error.message) || error)
          return { allowed: false, checked: 0, covered: [], missing: [], hint: 'harvest_gate 失败: ' + lastError }
        }
      },
    }),
  )
}
