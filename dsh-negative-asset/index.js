/**
 * dsh-negative-asset —— 负资产只读扫描（P0）。
 *
 * 为什么独立于 dsh-butler-tidy：tidy 管「系统级垃圾 + 单目录整理」，判据是路径类型 + 扩展名；
 * 本插件管「项目/仓库级负资产」，判据是删除三查（过时 / 以后无用 / 无价值）+ 可达性，
 * 且 P0 只读——不提供 apply，不导入任何删除 / 移动 / 改名 API（测试断言源码里没有）。
 *
 * 数据落 config.storeDir（默认 D:\AI\dsh-data\negative-asset，本机约定不落 C 盘）：
 *   last-scan.json   上次扫描的时间 / 耗时 / 根目录 / 计数（诊断用）
 *
 * 工具：
 *   asset_scan    只读扫描，出候选 + 三查分层 + 预估释放字节
 *   asset_status  诊断：数据目录、红线数、上次扫描、上限、path-safety 来源、lastError
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { protectedDirs, storeLocation } from './lib/path-safety.js'
import { text, fmtCount, fmtSize } from './lib/format.js'
import { DEFAULT_LIMITS, gitAvailable, limitsText, normalizeLimits, scanAssets } from './lib/scan.js'

export const name = 'dsh-negative-asset'
export const inject = ['tools']

/** 内部分层 → 人话（plugin-ux R2：界面不暴露枚举值） */
const LAYER_LABEL = { SAFE: '可清', doubt: '存疑', ask: '请旨' }

const PATH_SAFETY_SOURCE =
  '本插件 lib/path-safety.js（机械复制自 dsh-butler-tidy/lib/path-safety.js：红线 9 项 + fail-closed + junction/UNC/设备路径防护）'

function emptyResult(limits, roots, errors) {
  return {
    scannedFiles: 0,
    scannedDirs: 0,
    roots,
    limits: limitsText(limits),
    truncated: false,
    counts: { safe: 0, doubt: 0, ask: 0, protected: 0 },
    bytes: { safeBytes: 0, doubtBytes: 0, askBytes: 0, estimatedReclaim: 0 },
    items: [],
    errors,
  }
}

const countSchema = {
  type: 'object',
  properties: {
    safe: { type: 'integer', description: '三查全中：可清（SAFE）' },
    doubt: { type: 'integer', description: '命中信号但缺一条三查判据：存疑' },
    ask: { type: 'integer', description: '唯一副本 / 可能不可再生：请旨，只列出' },
    protected: { type: 'integer', description: '红线 / 写法不安全 / reparse point：fail-closed 排除' },
  },
  required: ['safe', 'doubt', 'ask', 'protected'],
  additionalProperties: false,
}

const bytesSchema = {
  type: 'object',
  properties: {
    safeBytes: { type: 'integer' },
    doubtBytes: { type: 'integer' },
    askBytes: { type: 'integer' },
    estimatedReclaim: { type: 'integer', description: '预估可释放字节 = safeBytes（P0 只读，不执行任何删除）' },
  },
  required: ['safeBytes', 'doubtBytes', 'askBytes', 'estimatedReclaim'],
  additionalProperties: false,
}

const itemSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    layer: { type: 'string', description: 'SAFE | doubt | ask' },
    signal: { type: 'string', description: 'empty-dir | zero-byte | temp-artifact | duplicate | split-residue | replica-name' },
    reason: { type: 'string', description: '三查逐条结论 + 缺哪一条 / 唯一副本风险' },
    size: { type: 'integer' },
    ageDays: { type: 'integer' },
    gitTracked: { type: 'string', description: 'tracked | untracked | unknown（unknown 绝不当成无引用）' },
  },
  required: ['path', 'layer', 'signal', 'reason', 'size', 'ageDays', 'gitTracked'],
  additionalProperties: false,
}

const errorSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['path', 'error'],
  additionalProperties: false,
}

const scanResultSchema = {
  type: 'object',
  properties: {
    scannedFiles: { type: 'integer' },
    scannedDirs: { type: 'integer' },
    roots: { type: 'array', items: { type: 'string' } },
    limits: { type: 'string' },
    truncated: { type: 'boolean' },
    counts: countSchema,
    bytes: bytesSchema,
    items: { type: 'array', items: itemSchema },
    errors: { type: 'array', items: errorSchema },
  },
  required: ['scannedFiles', 'scannedDirs', 'roots', 'limits', 'truncated', 'counts', 'bytes', 'items', 'errors'],
  additionalProperties: false,
}

const statusSchema = {
  type: 'object',
  properties: {
    ready: { type: 'boolean' },
    unavailableReason: { type: 'string' },
    storeDir: { type: 'string' },
    protectCount: { type: 'integer' },
    lastScanAt: { type: 'string' },
    lastScanMs: { type: 'integer' },
    lastScanRoots: { type: 'array', items: { type: 'string' } },
    limits: { type: 'string' },
    pathSafety: { type: 'string' },
    git: { type: 'string', description: 'available | unavailable' },
    lastError: { type: 'string' },
    notices: { type: 'array', items: { type: 'string' } },
  },
  required: ['ready', 'storeDir', 'protectCount', 'lastScanAt', 'lastScanMs', 'lastScanRoots', 'limits', 'pathSafety', 'git', 'lastError', 'notices'],
  additionalProperties: false,
}

function renderScan(_args, value) {
  const result = value || {}
  const counts = result.counts || {}
  const roots = Array.isArray(result.roots) ? result.roots : []
  if (roots.length === 0) {
    const errors = Array.isArray(result.errors) ? result.errors : []
    const reason = errors.length > 0 ? errors[0].error : '未指定扫描根目录。'
    return [text('没有扫描：' + reason + '\nP0 只读：不会删除、移动或改名任何文件。')]
  }
  const lines = []
  lines.push('负资产扫描（只读）：根 ' + fmtCount(roots.length) + ' 个 · 文件 ' + fmtCount(result.scannedFiles) + ' · 目录 ' + fmtCount(result.scannedDirs))
  lines.push(
    '候选：可清 ' + fmtCount(counts.safe) + ' · 存疑 ' + fmtCount(counts.doubt) + ' · 请旨 ' + fmtCount(counts.ask) +
      '；预估可释放 ' + fmtSize(result.bytes && result.bytes.safeBytes) + '（仅可清项，P0 不执行删除）',
  )
  if ((counts.protected || 0) > 0) lines.push('红线拦截 ' + fmtCount(counts.protected) + ' 处（fail-closed，未计入候选）')
  if (result.truncated) lines.push('结果已截断：' + result.limits)
  const items = Array.isArray(result.items) ? result.items : []
  if (items.length > 0) {
    lines.push('明细（列出 ' + fmtCount(items.length) + ' 条，可清在前）：')
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      lines.push('  ' + (i + 1) + '. [' + (LAYER_LABEL[item.layer] || item.layer) + '] ' + item.path)
      lines.push('     ' + fmtSize(item.size) + ' · ' + item.ageDays + ' 天 · ' + item.signal + ' · ' + item.reason)
    }
  } else {
    lines.push('没有发现候选。如果确实有负资产，先确认 roots 是否覆盖了目标目录、minAgeDays 是否设得过严。')
  }
  const errors = Array.isArray(result.errors) ? result.errors : []
  if (errors.length > 0) {
    lines.push('异常 / 拒扫（' + fmtCount(errors.length) + ' 条，只列前 5 条）：')
    for (const error of errors.slice(0, 5)) lines.push('  ' + (error.path || '(全局)') + '：' + error.error)
  }
  lines.push('P0 只读：本插件不删除、不移动、不改名任何文件。')
  return [text(lines.join('\n'))]
}

function renderStatus(_args, value) {
  const result = value || {}
  const lines = []
  if (result.ready === false) lines.push('不可用：' + (result.unavailableReason || '未知原因'))
  lines.push('数据目录：' + (result.storeDir || '?'))
  lines.push('红线目录：' + fmtCount(result.protectCount) + ' 个（系统目录、插件源码、学习空间等，fail-closed）')
  if (result.lastScanAt) {
    lines.push('上次扫描：' + result.lastScanAt + ' · 耗时 ' + fmtCount(result.lastScanMs) + 'ms · 根 ' + fmtCount((result.lastScanRoots || []).length) + ' 个')
    for (const root of (result.lastScanRoots || []).slice(0, 6)) lines.push('  · ' + root)
  } else {
    lines.push('上次扫描：（还没有）')
  }
  lines.push('上限：' + (result.limits || '—'))
  lines.push('path-safety：' + (result.pathSafety || '—'))
  lines.push('git 可达性：' + (result.git === 'available' ? '可用（按 git 索引判「以后无用」）' : '不可用（该维度记 unknown，不会当成无引用）'))
  lines.push('最近错误：' + (result.lastError || '（无）'))
  for (const notice of Array.isArray(result.notices) ? result.notices : []) lines.push(notice)
  return [text(lines.join('\n'))]
}

export function apply(ctx, config) {
  const store = storeLocation(config && config.storeDir)
  const guard = protectedDirs(config)
  const configuredRoots = Array.isArray(config && config.roots)
    ? config.roots.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  const tools = ctx.tools

  const state = { lastScanAt: '', lastScanMs: 0, lastScanRoots: [], lastError: '' }
  try {
    const parsed = JSON.parse(readFileSync(store.lastScan, 'utf8'))
    state.lastScanAt = typeof parsed.at === 'string' ? parsed.at : ''
    state.lastScanMs = Number.isInteger(parsed.ms) ? parsed.ms : 0
    state.lastScanRoots = Array.isArray(parsed.roots) ? parsed.roots.filter((item) => typeof item === 'string') : []
  } catch (error) {
    if (existsSync(store.lastScan)) {
      state.lastError = '上次扫描记录读不出来（' + store.lastScan + '）：' + ((error && error.message) || String(error))
    }
  }

  const probeStore = () => {
    try {
      mkdirSync(store.dir, { recursive: true })
      return { ready: true, reason: '' }
    } catch (error) {
      return {
        ready: false,
        reason: '数据目录建不出来：' + ((error && error.message) || String(error)) + '（扫描本身仍可用，只是记不下上次扫描）',
      }
    }
  }

  ctx.effect(() =>
    tools.register({
      name: 'asset_scan',
      description:
        'Read-only negative-asset scan for project-level leftovers: empty dirs, zero-byte files, stale temp artifacts (.tmp/.bak/.old/.orig/.partial/.crdownload/.log), duplicate copies (content hash), split-volume residue and replica-name copies (- copy / 副本 / (1) / 最终版 / final_v2). Every candidate carries a signal, a human-readable reason and a three-check layer: SAFE (stale + unreferenced in git + valueless), doubt (missing one check, reason says which) and ask (possible unique copy, list only). Roots come from args or plugin config and are required — this tool never scans whole disks by default. It NEVER deletes, moves or renames anything.',
      parameters: {
        type: 'object',
        properties: {
          roots: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths to scan. Empty falls back to plugin config roots; if both are empty the tool returns a guidance error instead of scanning a whole disk.',
          },
          maxFiles: { type: 'integer', description: 'Max files visited (default 20000, clamp 1-200000).' },
          maxDepth: { type: 'integer', description: 'Max directory depth below each root (default 6, clamp 0-32).' },
          minAgeDays: { type: 'integer', description: 'Staleness threshold in days (default 30, clamp 0-3650).' },
          maxRows: { type: 'integer', description: 'Max candidate rows returned (default 60, clamp 1-500).' },
        },
        additionalProperties: false,
      },
      output: { schema: scanResultSchema, render: renderScan },
      async execute(args) {
        const input = args || {}
        const limits = normalizeLimits(input)
        const roots = Array.isArray(input.roots) && input.roots.length > 0 ? input.roots : configuredRoots
        if (roots.length === 0) {
          return emptyResult(limits, [], [
            {
              path: '',
              error: '未给扫描根目录：请在参数 roots 或插件配置 roots 里指定（例如 D:\\AI\\dsh-data\\tmp）。本插件不会默认扫全盘。',
            },
          ])
        }
        const startedAt = Date.now()
        let result
        try {
          result = scanAssets({ roots, limits, guard, storeDir: store.dir })
        } catch (error) {
          state.lastError = '扫描异常：' + ((error && error.message) || String(error))
          return emptyResult(limits, [], [{ path: '', error: state.lastError }])
        }
        state.lastScanAt = new Date().toISOString()
        state.lastScanMs = Date.now() - startedAt
        state.lastScanRoots = result.roots
        state.lastError = ''
        try {
          mkdirSync(store.dir, { recursive: true })
          writeFileSync(
            store.lastScan,
            JSON.stringify({ at: state.lastScanAt, ms: state.lastScanMs, roots: state.lastScanRoots, counts: result.counts, truncated: result.truncated }, null, 2) + '\n',
            'utf8',
          )
        } catch (error) {
          state.lastError = '上次扫描记录写不进去（' + store.lastScan + '）：' + ((error && error.message) || String(error))
        }
        return result
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'asset_status',
      description:
        'Diagnostics for the negative-asset plugin: data dir, protection count, last scan time / duration / roots, limits, path-safety module source, git availability and lastError. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: statusSchema, render: renderStatus },
      async execute() {
        const probe = probeStore()
        const notices = []
        const missingGuards = guard.filter((dir) => !existsSync(dir))
        if (missingGuards.length > 0) {
          notices.push(
            '红线目录有 ' + missingGuards.length + ' 个当前不存在（改名/迁移后保护可能失效，请复核）：' +
              missingGuards.slice(0, 5).join(' / ') + (missingGuards.length > 5 ? ' …' : ''),
          )
        }
        if (state.lastScanAt === '') notices.push('还没有扫描记录；第一次 asset_scan 之后这里会有上次扫描时间 / 耗时 / 根目录。')
        if (probe.reason !== '' && probe.ready === false) notices.push(probe.reason)
        return {
          ready: probe.ready,
          unavailableReason: probe.reason,
          storeDir: store.dir,
          protectCount: guard.length,
          lastScanAt: state.lastScanAt,
          lastScanMs: state.lastScanMs,
          lastScanRoots: state.lastScanRoots,
          limits: limitsText(DEFAULT_LIMITS) + '（每次调用可用参数覆盖，配置里也可改默认）',
          pathSafety: PATH_SAFETY_SOURCE,
          git: gitAvailable() ? 'available' : 'unavailable',
          lastError: state.lastError,
          notices,
        }
      },
    }),
  )
}
