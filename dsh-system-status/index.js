/**
 * dsh-system-status v0.1.0
 *
 * 一个工具看全局：把工作区的体系体检（_ops/system-health.mjs）包装成 system_status。
 *
 * 为什么要有它：现有 22 个插件各有一个 *_status，模型要了解全局得逐个查；
 * 脚本层其实早就有总览（system-health），只是工具层没有入口。
 * 这个插件只做一件事：把"整体"变成一次调用能看到的答案。
 *
 * 设计纪律：
 *   - 只读，不写任何文件（体检脚本自己写 health-log，这里不碰）
 *   - 不重写体检逻辑，spawn 现有脚本（单一实现，不造第二份口径）
 *   - 工作区可配，找不到脚本就明确报 unavailableReason，不编造"全部正常"
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'system-status'
export const inject = ['tools']

const MAX_RENDER_ROWS = 12

export function apply(ctx, config = {}) {
  const cfg = {
    workspaceDir:
      typeof config?.workspaceDir === 'string' && config.workspaceDir.trim() !== '' ? config.workspaceDir.trim() : '',
    timeoutMs: Number.isInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90000,
  }

  function resolveWorkspace() {
    if (cfg.workspaceDir !== '') return cfg.workspaceDir
    try {
      const wd = ctx.get('workingDirectory')
      const v = typeof wd?.get === 'function' ? wd.get() : undefined
      if (typeof v === 'string' && v !== '') return v
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  async function runHealth(dir) {
    const script = join(dir, '_ops', 'system-health.mjs')
    if (!existsSync(script)) {
      return {
        ok: false,
        unavailableReason: `该工作区没有体系体检脚本：${script}`,
        rows: [],
      }
    }
    const t0 = Date.now()
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, '--json'], {
        cwd: dir,
        timeout: cfg.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      })
      const data = JSON.parse(stdout)
      if (!Array.isArray(data?.rows)) {
        return { ok: false, unavailableReason: '体检脚本返回的 JSON 里没有 rows 数组', rows: [], durationMs: Date.now() - t0 }
      }
      return { ok: true, data, rows: data.rows, durationMs: Date.now() - t0 }
    } catch (err) {
      const msg = String(err?.message ?? err)
      return { ok: false, unavailableReason: `体检脚本执行失败：${msg}`, rows: [], durationMs: Date.now() - t0 }
    }
  }

  ctx.tools.register({
    name: 'system_status',
    description:
      'One-call workspace health. Runs the workspace system-health probe and returns a structured verdict ' +
      '(rows with layer/name/value/limit/ok/note). Use it before/after a broad change instead of querying ' +
      'each plugin status tool one by one. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        workspaceDir: {
          type: 'string',
          description: 'Workspace root to probe. Omit to use the current working directory.',
        },
        layers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only return rows whose layer matches one of these (e.g. ["L1"]). Omit for all layers.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          workspaceDir: { type: 'string' },
          at: { type: 'string' },
          verdict: { type: 'string' },
          failed: { type: 'integer' },
          total: { type: 'integer' },
          durationMs: { type: 'integer' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                layer: { type: 'string' },
                name: { type: 'string' },
                value: {},
                limit: {},
                ok: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['layer', 'name', 'ok'],
              additionalProperties: false,
            },
          },
          unavailableReason: { type: 'string' },
        },
        required: ['ok', 'workspaceDir', 'failed', 'total', 'rows'],
        additionalProperties: false,
      },
      render(_args, value) {
        const head = value.ok
          ? `体系体检 · ${value.failed === 0 ? '全绿' : value.failed + ' 项未过'} · ${value.total} 项 · ${value.durationMs}ms`
          : `体系体检不可用：${value.unavailableReason ?? '未知原因'}`
        const lines = [head]
        const bad = (value.rows ?? []).filter((r) => !r.ok)
        const show = bad.length > 0 ? bad : (value.rows ?? []).slice(0, MAX_RENDER_ROWS)
        for (const r of show) {
          lines.push(`  ${r.ok ? '✓' : '✗'} [${r.layer}] ${r.name} = ${String(r.value)}${r.limit === null || r.limit === undefined ? '' : ' / ' + String(r.limit)}${r.note ? ' — ' + r.note : ''}`)
        }
        if (bad.length === 0 && (value.rows ?? []).length > MAX_RENDER_ROWS) {
          lines.push(`  … 其余 ${value.rows.length - MAX_RENDER_ROWS} 项略`)
        }
        // DSH 工具契约：render 必须返回 content 数组（元素形如 {type:'text', text}），
        // 返回裸字符串会让宿主在 content.some 上崩（v0.1.0 真机踩到：content.some is not a function）。
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args = {}) {
      const dir = typeof args?.workspaceDir === 'string' && args.workspaceDir.trim() !== '' ? args.workspaceDir.trim() : resolveWorkspace()
      const probe = await runHealth(dir)
      if (!probe.ok) {
        return {
          ok: false,
          workspaceDir: dir,
          at: new Date().toISOString(),
          verdict: 'unavailable',
          failed: 0,
          total: 0,
          durationMs: probe.durationMs ?? 0,
          rows: [],
          unavailableReason: probe.unavailableReason,
        }
      }
      const want = Array.isArray(args?.layers) && args.layers.length > 0 ? new Set(args.layers.map(String)) : null
      // 规范化：源数据里个别行的 ok 可能缺失（undefined），必须收敛成布尔，
      // 否则会出现「failed=0 但 render 里打 ✗」的自相矛盾（v0.1.0 实测踩到）。
      const src = want === null ? probe.rows : probe.rows.filter((r) => want.has(String(r?.layer ?? '')))
      const rows = src.map((r) => ({
        layer: String(r?.layer ?? ''),
        name: String(r?.name ?? ''),
        value: r?.value,
        limit: r?.limit,
        ok: r?.ok === true,
        note: typeof r?.note === 'string' ? r.note : '',
      }))
      const failed = rows.filter((r) => !r.ok).length
      return {
        ok: true,
        workspaceDir: dir,
        at: typeof probe.data?.at === 'string' ? probe.data.at : new Date().toISOString(),
        verdict: typeof probe.data?.verdict === 'string' ? probe.data.verdict : '',
        failed,
        total: rows.length,
        durationMs: probe.durationMs ?? 0,
        rows,
      }
    },
  })
}
