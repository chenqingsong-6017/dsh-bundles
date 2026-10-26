/**
 * dsh-usage —— 跨会话 token 用量与成本报表（通用场景插件）。
 *
 * 数据从哪来：DSH 把每个会话的完整事件流压缩存在 `~/.dsh/sessions/**\/session.v4.jsonl.zstd`。
 * 每条 `assistant/message` 事件都带 `usage`（input / output / cacheRead / cacheWrite）和
 * `message.source`（provider + model），所以我们**不需要实时订阅事件**就能回溯全部历史。
 *
 * 做几件事：
 *   1. 扫描会话日志（zstd 解压 + 逐行解析），按 (日期, provider, model) 聚合成桶；
 *   2. 每个文件按 (size, mtimeMs) 做指纹缓存 —— 没变就不重扫，变了的那个文件才重解析；
 *   3. 给 agent 两个工具：`usage_report`（按天/模型/会话出报表，可带成本）和 `usage_status`（诊断）。
 *
 * 刻意的取舍：
 *   - **不做实时事件订阅**：只读历史日志，插件不在热路径上，零上下文税、零 token 开销；
 *   - **成本默认不算**：价格表必须由使用者配置（模型价格随时变，硬编码会给出错的数字）。
 *     没配价格就只报 token 数，`priced: false`；
 *   - **不把会话日志内容带出来**：只提取数字与 model 名，绝不输出 prompt / 回复正文；
 *   - 数据落 `config.storeDir`，未配置时退到 `DSH_PROFILE_DIR` 或 `~/.dsh/dsh-usage`。
 *
 * 已知边界：
 *   - 只认 `*.jsonl.zstd`（DSH 0.2.x 的 v4 会话格式）；更早或未压缩格式扫不到；
 *   - 增量以「文件」为单位：文件一变就整文件重解析（1.5 MB 压缩约 50 ms，可接受）；
 *   - 日期按本地时区切分（可用 `timeZone` 覆盖），跨时区迁移会让历史日期边界略有偏移；
 *   - 会话被删除后，其历史也会从报表里消失（报表永远反映磁盘现状，不做独立归档）。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-usage'
export const inject = ['tools']

const STORE_VERSION = 1
const SESSION_SUFFIX = '.jsonl.zstd'
const MAX_WALK_DEPTH = 6
const MAX_FILES = 2000
const DAY_MS = 24 * 60 * 60 * 1000
const RANGES = { today: 1, '7d': 7, '30d': 30, all: null }

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** 会话日志根目录：DSH_HOME 优先，否则 ~/.dsh/sessions */
export function sessionsRoot() {
  const home = process.env.DSH_HOME?.trim()
  return path.join(home && home !== '' ? path.resolve(home) : path.join(os.homedir(), '.dsh'), 'sessions')
}

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-usage')
        : path.join(os.homedir(), '.dsh', 'dsh-usage')
  return { dir: base, file: path.join(base, 'usage.json') }
}

/** 本地时区下的 YYYY-MM-DD；sv-SE 的格式天然就是 ISO 日期，可直接做字符串比较。 */
export function dayOf(ms, timeZone) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    ...(typeof timeZone === 'string' && timeZone !== '' ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d)
}

/** 从会话日志路径里取会话 id（父目录名，形如 session-xxxx 或裸 uuid）。 */
export function sessionIdOf(file) {
  return path.basename(path.dirname(file))
}

/** 递归列出会话日志文件。 */
export function listSessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

/**
 * 解压会话日志缓冲区。
 *
 * ⚠️ 会话日志是**多帧 zstd**（DSH 每块追加一帧，一个几 MB 的文件可能有上千帧）。
 * `zlib.createZstdDecompress()` 的**流式**解压在不同 Node 版本上行为不同：Node 26 会
 * 自动续解后续帧，而 DSH 自带的 Node 24 只解第一帧就走完 —— 实测直接导致读到 0 行。
 * `zstdDecompressSync` 整体解压在这两个版本上都能正确处理多帧，所以主路径用它，
 * 只有它失败时才按 frame magic 切开逐帧兜底。
 */
export function decompressSessionBuffer(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const positions = []
  let idx = buf.indexOf(magic)
  while (idx !== -1) {
    positions.push(idx)
    idx = buf.indexOf(magic, idx + 1)
  }
  // 多帧：逐帧解压。Node 24 的 zstdDecompressSync 与流式 API 都**只解第一帧**
  // （实测 DSH 的 node 24.21 解出 0 行，而 node 26 整体解压能拿到全部 1399 行）。
  if (positions.length > 1) {
    try {
      const chunks = []
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i]
        const end = i + 1 < positions.length ? positions[i + 1] : buf.length
        chunks.push(zstdDecompressSync(buf.subarray(start, end)))
      }
      return Buffer.concat(chunks)
    } catch {
      // 帧边界误判（压缩数据里偶然出现 magic）：退回整体解压
    }
  }
  return zstdDecompressSync(buf)
}

/**
 * 解析一个会话日志，返回按 (date, provider, model) 聚合的桶。
 * 只读数字，不保留任何 prompt / 回复内容。
 */
export async function parseSessionFile(file, options = {}) {
  const timeZone = options.timeZone
  const buckets = new Map()
  let calls = 0
  let lines = 0

  let text
  try {
    text = decompressSessionBuffer(readFileSync(file)).toString('utf8')
  } catch (error) {
    return { buckets: [], calls: 0, lines: 0, error: error instanceof Error ? error.message : String(error) }
  }
  // 让出一次事件循环：多文件连续解压时不要让单个大文件把 Host 卡住。
  await Promise.resolve()

  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue
    lines += 1
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (!usage) continue
    const source = event?.data?.message?.source
    const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : 'unknown'
    const model = typeof source?.model === 'string' && source.model !== '' ? source.model : 'unknown'
    const date = dayOf(typeof event.time === 'number' ? event.time : Date.now(), timeZone)
    if (date === '') continue

    const key = `${date}\u0000${provider}\u0000${model}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { date, provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      buckets.set(key, bucket)
    }
    const inputTokens = num(usage.inputTokens)
    const outputTokens = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    bucket.calls += 1
    bucket.input += inputTokens
    bucket.output += outputTokens
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    bucket.total += num(usage.totalTokens) || inputTokens + outputTokens + cacheRead + cacheWrite
    calls += 1
  }
  return { buckets: [...buckets.values()], calls, lines }
}

/** 价格查找：先精确匹配 model / provider/model，再按前缀匹配（价格表键可以写模型族前缀）。 */
export function priceFor(prices, provider, model) {
  if (!prices || typeof prices !== 'object') return null
  const direct = prices[model] ?? prices[`${provider}/${model}`]
  if (direct) return direct
  for (const key of Object.keys(prices)) {
    if (key !== '' && model.startsWith(key)) return prices[key]
  }
  return null
}

/** 成本 = Σ(tokens × 每百万单价) / 1e6；没配价格返回 0。 */
export function costOf(bucket, prices) {
  const price = priceFor(prices, bucket.provider, bucket.model)
  if (!price) return null
  const sum =
    num(bucket.input) * num(price.input) +
    num(bucket.output) * num(price.output) +
    num(bucket.cacheRead) * num(price.cacheRead) +
    num(bucket.cacheWrite) * num(price.cacheWrite)
  return sum / 1e6
}

const emptyTotals = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 })

export function apply(ctx, config) {
  const timeZone = typeof config?.timeZone === 'string' && config.timeZone.trim() !== '' ? config.timeZone.trim() : undefined
  const prices = config?.prices && typeof config.prices === 'object' ? config.prices : null
  const currency = typeof config?.currency === 'string' && config.currency.trim() !== '' ? config.currency.trim() : 'CNY'
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)
  const tools = ctx.tools
  const sessions = sessionsRoot()

  let state = { version: STORE_VERSION, files: {}, lastScanAt: null }
  let refreshing = null

  function persist() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(state)
      const temp = `${storeFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, storeFile)
      } catch {
        writeFileSync(storeFile, body, 'utf8')
      }
      return true
    } catch {
      return false
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
      if (parsed?.version === STORE_VERSION && parsed?.files && typeof parsed.files === 'object') {
        state = { version: STORE_VERSION, files: parsed.files, lastScanAt: parsed.lastScanAt ?? null }
      }
    } catch {
      // 没有存档 / 版本不符：从空开始
    }
  }

  load()

  async function refresh() {
    const files = listSessionFiles(sessions)
    const next = {}
    let refreshed = 0
    let failed = 0
    for (const file of files) {
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      const prev = state.files[file]
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
        next[file] = prev
        continue
      }
      try {
        const parsed = await parseSessionFile(file, { timeZone })
        if (parsed.error) {
          failed += 1
          if (prev) next[file] = prev
          continue
        }
        next[file] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sessionId: sessionIdOf(file),
          calls: parsed.calls,
          buckets: parsed.buckets,
        }
        refreshed += 1
      } catch {
        failed += 1
        if (prev) next[file] = prev
      }
    }
    state.files = next
    state.lastScanAt = new Date().toISOString()
    if (refreshed > 0) persist()
    return { total: files.length, refreshed, failed }
  }

  /** 并发调用只跑一次刷新，避免同一时刻重复扫盘。 */
  function ensureFresh() {
    if (refreshing) return refreshing
    refreshing = refresh().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  function cutoffFor(range) {
    const days = RANGES[range] ?? RANGES['7d']
    if (days === null) return ''
    return dayOf(Date.now() - (days - 1) * DAY_MS, timeZone)
  }

  function buildReport(args) {
    const range = typeof args?.range === 'string' && args.range in RANGES ? args.range : '7d'
    const groupBy = ['day', 'model', 'session'].includes(args?.groupBy) ? args.groupBy : 'day'
    const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 14
    const cutoff = cutoffFor(range)

    const groups = new Map()
    const totals = emptyTotals()
    const bump = (target, bucket, cost) => {
      target.calls += bucket.calls
      target.input += bucket.input
      target.output += bucket.output
      target.cacheRead += bucket.cacheRead
      target.cacheWrite += bucket.cacheWrite
      target.total += bucket.total
      if (cost !== null) target.cost += cost
    }

    for (const entry of Object.values(state.files)) {
      if (!entry || !Array.isArray(entry.buckets)) continue
      for (const bucket of entry.buckets) {
        if (cutoff !== '' && typeof bucket.date === 'string' && bucket.date < cutoff) continue
        const cost = costOf(bucket, prices)
        let key
        if (groupBy === 'day') key = bucket.date
        else if (groupBy === 'model') key = `${bucket.provider}/${bucket.model}`
        else key = entry.sessionId ?? 'unknown'
        let group = groups.get(key)
        if (!group) {
          group = { key, ...emptyTotals() }
          groups.set(key, group)
        }
        bump(group, bucket, cost)
        bump(totals, bucket, cost)
      }
    }

    const rows = [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    const trimmed = groupBy === 'day' || groupBy === 'session' ? rows.slice(0, limit) : rows

    return {
      range,
      groupBy,
      from: cutoff === '' ? 'all' : cutoff,
      rows: trimmed.map((row) => ({
        key: String(row.key),
        calls: Math.round(row.calls),
        input: Math.round(row.input),
        output: Math.round(row.output),
        cacheRead: Math.round(row.cacheRead),
        cacheWrite: Math.round(row.cacheWrite),
        total: Math.round(row.total),
        cost: Number.isFinite(row.cost) ? Math.round(row.cost * 1e4) / 1e4 : 0,
      })),
      totals: {
        calls: Math.round(totals.calls),
        input: Math.round(totals.input),
        output: Math.round(totals.output),
        cacheRead: Math.round(totals.cacheRead),
        cacheWrite: Math.round(totals.cacheWrite),
        total: Math.round(totals.total),
        cost: Number.isFinite(totals.cost) ? Math.round(totals.cost * 1e4) / 1e4 : 0,
      },
      currency,
      priced: Boolean(prices),
      models: [...new Set(Object.values(state.files).flatMap((entry) => (entry.buckets ?? []).map((b) => `${b.provider}/${b.model}`)))].sort(),
      files: { total: Object.keys(state.files).length, refreshed: 0 },
    }
  }

  const fmtTokens = (value) => {
    const n = num(value)
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
    return String(Math.round(n))
  }

  const totalsSchema = {
    type: 'object',
    properties: {
      calls: { type: 'integer' },
      input: { type: 'integer' },
      output: { type: 'integer' },
      cacheRead: { type: 'integer' },
      cacheWrite: { type: 'integer' },
      total: { type: 'integer' },
      cost: { type: 'number' },
    },
    required: ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'total', 'cost'],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'usage_report',
      description:
        'Token usage and optional cost report built from every session log on disk (~/.dsh/sessions). Group by day, model, or session. Read-only: it never sends a model request. Configure prices in the bundle config to get cost numbers.',
      parameters: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'Window to report; defaults to 7d.' },
          groupBy: { type: 'string', enum: ['day', 'model', 'session'], description: 'Aggregation key; defaults to day.' },
          limit: { type: 'integer', description: 'Max rows for day/session grouping (1-50, default 14).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            range: { type: 'string' },
            groupBy: { type: 'string' },
            from: { type: 'string' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  calls: { type: 'integer' },
                  input: { type: 'integer' },
                  output: { type: 'integer' },
                  cacheRead: { type: 'integer' },
                  cacheWrite: { type: 'integer' },
                  total: { type: 'integer' },
                  cost: { type: 'number' },
                },
                required: ['key', 'calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'total', 'cost'],
                additionalProperties: false,
              },
            },
            totals: totalsSchema,
            currency: { type: 'string' },
            priced: { type: 'boolean' },
            models: { type: 'array', items: { type: 'string' } },
            files: {
              type: 'object',
              properties: { total: { type: 'integer' }, refreshed: { type: 'integer' } },
              required: ['total', 'refreshed'],
              additionalProperties: false,
            },
          },
          required: ['range', 'groupBy', 'from', 'rows', 'totals', 'currency', 'priced', 'models', 'files'],
          additionalProperties: false,
        },
        render(_args, value) {
          const totals = value?.totals ?? {}
          const rows = Array.isArray(value?.rows) ? value.rows : []
          const head = `${value?.from === 'all' ? '全部历史' : `${value?.from ?? '?'} 起`} · 按${value?.groupBy === 'day' ? '天' : value?.groupBy === 'model' ? '模型' : '会话'}`
          const money = (n) => (value?.priced ? ` ${value?.currency ?? ''}${num(n).toFixed(2)}` : '')
          const lines = rows.map(
            (row) =>
              `  ${row.key}  ${row.calls} 次 · in ${fmtTokens(row.input)} / out ${fmtTokens(row.output)} / 缓存读 ${fmtTokens(row.cacheRead)}${money(row.cost)}`,
          )
          const totalLine = `合计：${totals.calls ?? 0} 次 · in ${fmtTokens(totals.input)} / out ${fmtTokens(totals.output)} / 缓存读 ${fmtTokens(totals.cacheRead)} / 缓存写 ${fmtTokens(totals.cacheWrite)}${money(totals.cost)}`
          const priceNote = value?.priced ? '' : '\n（未配置价格表，只报 token 数；要算钱请在 bundle config 里配 prices）'
          return [text(`${head}\n${lines.length > 0 ? lines.join('\n') : '  （该区间没有记录）'}\n${totalLine}${priceNote}`)]
        },
      },
      async execute(args) {
        const fresh = await ensureFresh()
        const report = buildReport(args)
        report.files.refreshed = fresh.refreshed
        return report
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'usage_status',
      description:
        'Diagnostics for the usage index: where the store lives, how many session logs were indexed, when the last scan ran, and whether a price table is configured.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionsRoot: { type: 'string' },
            storeDir: { type: 'string' },
            storeFile: { type: 'string' },
            storeBytes: { type: 'integer' },
            indexedFiles: { type: 'integer' },
            totalCalls: { type: 'integer' },
            lastScanAt: { type: 'string' },
            pricesConfigured: { type: 'boolean' },
            currency: { type: 'string' },
            timeZone: { type: 'string' },
            models: { type: 'array', items: { type: 'string' } },
            diagnostics: {
              type: 'object',
              properties: {
                node: { type: 'string' },
                electron: { type: 'string' },
                zstd: { type: 'string' },
              },
              required: ['node', 'electron', 'zstd'],
              additionalProperties: false,
            },
            probe: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                lines: { type: 'integer' },
                calls: { type: 'integer' },
                error: { type: 'string' },
              },
              required: ['file', 'lines', 'calls', 'error'],
              additionalProperties: false,
            },
          },
          required: [
            'sessionsRoot',
            'storeDir',
            'storeFile',
            'storeBytes',
            'indexedFiles',
            'totalCalls',
            'lastScanAt',
            'pricesConfigured',
            'currency',
            'timeZone',
            'models',
            'diagnostics',
            'probe',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          const models = Array.isArray(value?.models) ? value.models : []
          return [
            text(
              [
                `会话日志：${value?.sessionsRoot ?? '?'}`,
                `索引存档：${value?.storeFile ?? '?'}（${fmtTokens(value?.storeBytes ?? 0)}B）`,
                `已索引：${value?.indexedFiles ?? 0} 个会话文件 / ${value?.totalCalls ?? 0} 次模型调用`,
                `最后扫描：${value?.lastScanAt ?? '（还没扫过）'}`,
                `价格表：${value?.pricesConfigured ? `已配置（${value?.currency ?? ''}）` : '未配置（只报 token）'}`,
                `时区：${value?.timeZone ?? '系统默认'}`,
                `模型：${models.length > 0 ? models.join(', ') : '（未知）'}`,
                `运行时：node ${value?.diagnostics?.node ?? '?'} / electron ${value?.diagnostics?.electron ?? '?'} / zstd ${value?.diagnostics?.zstd ?? '?'}`,
                `探针（${value?.probe?.file ?? '无文件'}）：lines ${value?.probe?.lines ?? 0} / calls ${value?.probe?.calls ?? 0}${value?.probe?.error ? ` / error: ${value.probe.error}` : ''}`,
              ].join('\n'),
            ),
          ]
        },
      },
      async execute() {
        await ensureFresh()
        let storeBytes = 0
        try {
          storeBytes = statSync(storeFile).size
        } catch {
          storeBytes = 0
        }
        // 实时探针：对第一个会话文件当场解析一次，用来区分「扫描没跑」和「解压/解析没出数」。
        let probe = { file: '', lines: 0, calls: 0, error: '' }
        const firstFile = listSessionFiles(sessions)[0]
        if (firstFile) {
          const label = sessionIdOf(firstFile)
          try {
            const parsed = await parseSessionFile(firstFile, { timeZone })
            probe = { file: label, lines: parsed.lines ?? 0, calls: parsed.calls ?? 0, error: parsed.error ?? '' }
          } catch (error) {
            probe = { file: label, lines: 0, calls: 0, error: error instanceof Error ? error.message : String(error) }
          }
        }
        const files = Object.values(state.files)
        return {
          sessionsRoot: sessions,
          storeDir,
          storeFile,
          storeBytes: Math.round(storeBytes),
          indexedFiles: files.length,
          totalCalls: Math.round(files.reduce((sum, entry) => sum + (entry?.calls ?? 0), 0)),
          lastScanAt: typeof state.lastScanAt === 'string' ? state.lastScanAt : '',
          pricesConfigured: Boolean(prices),
          currency,
          timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
          models: [
            ...new Set(files.flatMap((entry) => (entry?.buckets ?? []).map((b) => `${b.provider}/${b.model}`))),
          ].sort(),
          diagnostics: {
            node: process.versions.node ?? '',
            electron: process.versions.electron ?? '',
            zstd: typeof zstdDecompressSync === 'function' ? 'sync-available' : 'missing',
          },
          probe,
        }
      },
    }),
  )
}

const text = (value) => ({ type: 'text', text: value })
