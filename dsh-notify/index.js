/**
 * dsh-notify —— 任务完成 / 失败的通知（通用场景插件）。
 *
 * 为什么需要：DSH 跑一个任务可能要几分钟。你切走去干别的，回来才发现"其实 8 分钟前就好了"
 * 或者"早就报错了"。这个插件在**回合结束**时按规则判断值不值得打扰你，然后发一条
 * 桌面通知（Windows Toast）+ 提示音。
 *
 * 规则（默认，全部可配）：
 *   - 回合耗时 ≥ `minDurationMs`（默认 60 秒）且正常完成 → 通知；
 *   - 回合**失败/中断** → 立刻通知（不受时长限制）；
 *   - 短回合（几秒的小问答）→ 一律不通知，避免变成噪音。
 *
 * 除了自动通知，还注册一个 `notify` 工具：agent 可以在长任务中途主动喊你
 * （"需要你确认一下"、"我跑完了"），不用等回合结束。
 *
 * 实现：Windows 走 PowerShell + WinRT 弹 Toast；其它平台退化成终端响铃 + 日志。
 * 通知发送是**fire-and-forget**，失败只记日志，绝不影响会话正常结束。
 *
 * 数据落 `config.storeDir`（默认 DSH_PROFILE_DIR 或 ~/.dsh/dsh-notify），按天记发送历史。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-notify'
export const inject = ['tools', 'subprocess']

const DAY_MS = 24 * 60 * 60 * 1000
const RANGES = { today: 1, '7d': 7, '30d': 30, all: null }
const MAX_BODY = 200

const text = (value) => ({ type: 'text', text: value })
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-notify')
        : path.join(os.homedir(), '.dsh', 'dsh-notify')
  return { dir: base }
}

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

/** XML 转义，Toast 的 text 节点不能直接塞裸 & < >。 */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 截断并压成单行（Toast 长度有限，也不希望正文里带换行）。 */
export function compact(value, max = MAX_BODY) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 判断一个回合结束时是否该通知。返回 null 表示不通知。 */
export function shouldNotify({ reason, durationMs, minDurationMs, notifyOnComplete, notifyOnError, notifyOnInterrupt }) {
  const kind = reason?.kind ?? 'unknown'
  if (kind === 'error') return notifyOnError ? 'error' : null
  if (kind === 'aborted' || kind === 'interrupted') return notifyOnInterrupt ? 'interrupt' : null
  if (kind === 'max-tokens') return notifyOnError ? 'max-tokens' : null
  if (kind === 'completed') {
    if (!notifyOnComplete) return null
    return durationMs >= minDurationMs ? 'complete' : null
  }
  return null
}

/** 各类结局的标题/正文（说人话，不暴露内部实现）。 */
export function describeOutcome(kind, { durationMs, sessionShort, title }) {
  const seconds = Math.round(durationMs / 1000)
  const timeText = seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`
  const where = sessionShort ? ` · 会话 ${sessionShort}` : ''
  if (kind === 'complete') return { title: '任务完成', body: `「${title || '未命名会话'}」跑完了，用了 ${timeText}${where}` }
  if (kind === 'error') return { title: '任务出错', body: `「${title || '未命名会话'}」这一轮失败了（${timeText}）${where}` }
  if (kind === 'interrupt') return { title: '任务被中断', body: `「${title || '未命名会话'}」被中断（${timeText}）${where}` }
  if (kind === 'max-tokens') return { title: '达到上限', body: `「${title || '未命名会话'}」撞到 max-tokens 上限${where}` }
  return { title: '任务状态', body: `${kind}` }
}

/**
 * 方案 A：Windows PowerShell 5.1 + WinRT 原生 Toast。
 *
 * ⚠️ 必须用 powershell.exe（5.1）执行：pwsh 7 基于 .NET Core，**不再提供 WinRT 类型投影**，
 * `[Windows.UI.Notifications.*]` 会直接"找不到类型"（实测 pwsh 7.6 复现）。5.1 能加载，
 * 但它拿到的 WinRT XmlElement 没有可写的 InnerText，因此用 `XmlDocument.LoadXml`
 * 直接构造整段 XML —— 这是两个坑里最稳的写法。
 */
export function buildToastScript(title, body, silent = false) {
  const audio = silent ? '<audio silent="true"/>' : ''
  const xml = `<toast><visual><binding template="ToastText02"><text id="1">${xmlEscape(compact(title, 80))}</text><text id="2">${xmlEscape(compact(body))}</text></binding></visual>${audio}</toast>`
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    "  $xmlText = @'",
    xml,
    "'@",
    '  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $doc.LoadXml($xmlText)',
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Harness').Show($toast)",
    '  Write-Output "toast-ok"',
    '  exit 0',
    '} catch {',
    '  Write-Output ("toast-failed: " + $_.Exception.Message)',
    '  exit 2',
    '}',
  ].join('\n')
}

/**
 * 方案 B：WinForms 托盘气泡（不依赖 WinRT，pwsh 7 也能跑）。
 * 原生 Toast 被系统策略禁用、或 WinRT 不可用时用它兜底。
 */
export function buildBalloonScript(title, body) {
  const safeTitle = (compact(title, 80) || 'DSH').replace(/'/g, "''")
  const safeBody = compact(body).replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  $n = New-Object System.Windows.Forms.NotifyIcon',
    '  $n.Icon = [System.Drawing.SystemIcons]::Information',
    '  $n.Visible = $true',
    `  $n.ShowBalloonTip(5000, '${safeTitle}', '${safeBody}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    '  Start-Sleep -Milliseconds 900',
    '  $n.Dispose()',
    '  Write-Output "balloon-ok"',
    '  exit 0',
    '} catch {',
    '  Write-Output ("balloon-failed: " + $_.Exception.Message)',
    '  exit 2',
    '}',
  ].join('\n')
}

export function apply(ctx, config) {
  const timeZone = typeof config?.timeZone === 'string' && config.timeZone.trim() !== '' ? config.timeZone.trim() : undefined
  const minDurationMs =
    Number.isInteger(config?.minDurationMs) && config.minDurationMs >= 0
      ? Math.min(config.minDurationMs, 24 * 60 * 60 * 1000)
      : 60 * 1000
  const notifyOnComplete = config?.notifyOnComplete !== false
  const notifyOnError = config?.notifyOnError !== false
  const notifyOnInterrupt = config?.notifyOnInterrupt === true
  const sound = config?.sound !== false
  const { dir: storeDir } = storeLocation(config?.storeDir)
  const tools = ctx.tools
  const subprocess = ctx.get('subprocess')
  const canToast = process.platform === 'win32' && Boolean(subprocess)

  /** 会话 id -> 当前 turn 的开始时间 */
  const turnStartedAt = new Map()
  let sent = 0
  let failed = 0
  let lastError = ''
  let lastSentAt = ''
  let lastTransport = ''
  let pwshPath = ''
  let ps51Path = ''

  function ensureDir() {
    try {
      mkdirSync(storeDir, { recursive: true })
      return true
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function logSend(entry) {
    if (!ensureDir()) return
    try {
      appendFileSync(path.join(storeDir, `notify-${dayOf(num(entry.time), timeZone)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  async function resolvePwsh() {
    if (pwshPath !== '') return pwshPath
    if (!subprocess) return ''
    for (const name of [process.platform === 'win32' ? 'pwsh' : 'sh', 'powershell']) {
      try {
        const found = await subprocess.resolveExecutable(name)
        if (typeof found === 'string' && found !== '') {
          pwshPath = found
          return pwshPath
        }
      } catch {
        /* 试下一个 */
      }
    }
    pwshPath = ''
    return pwshPath
  }

  /** Windows PowerShell 5.1：唯一能稳定加载 WinRT 投影的解释器（pwsh 7 不行）。 */
  async function resolvePs51() {
    if (ps51Path !== '') return ps51Path
    if (!subprocess || process.platform !== 'win32') return ''
    try {
      ps51Path = await subprocess.resolveExecutable('powershell')
    } catch {
      ps51Path = ''
    }
    return ps51Path
  }

  /** 跑一段 PowerShell 脚本，返回它是否 exit 0。 */
  function runPowerShell(executable, script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    try {
      const handle = subprocess.spawn({
        argv: [executable, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        cwd: storeDir,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 2500,
      })
      return handle.done.then(
        (outcome) => {
          const exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : 0
          return exitCode === 0
        },
        () => false,
      )
    } catch {
      return Promise.resolve(false)
    }
  }

  /**
   * 三级回退：5.1 原生 Toast → pwsh WinForms 气泡 → 只记日志（响铃由系统兜底）。
   * 任何一级失败都不抛错、不影响会话，只把原因写进 lastError。
   */
  async function deliver(title, body, meta = {}) {
    const at = Date.now()
    lastSentAt = new Date(at).toISOString()
    let transport = 'log'

    if (canToast) {
      const ps51 = await resolvePs51()
      if (ps51 !== '' && (await runPowerShell(ps51, buildToastScript(title, body, !sound)))) {
        transport = 'toast'
      } else {
        const pw = await resolvePwsh()
        if (pw !== '' && (await runPowerShell(pw, buildBalloonScript(title, body)))) {
          transport = 'balloon'
        } else if (ps51 === '' && pw === '') {
          lastError = '找不到 powershell.exe / pwsh，通知未发送'
        } else {
          lastError = '原生 Toast 与托盘气泡都失败（检查系统通知/专注助手设置）'
        }
      }
    }

    logSend({
      ts: lastSentAt,
      time: at,
      title: compact(title, 80),
      body: compact(body),
      kind: typeof meta.kind === 'string' ? meta.kind : 'manual',
      transport,
      ...(typeof meta.session === 'string' && meta.session !== '' ? { session: meta.session } : {}),
    })

    if (transport === 'log' && canToast) failed += 1
    else sent += 1
    lastTransport = transport
    return transport
  }

  ensureDir()

  // ---- 订阅回合事件：记录开始时间 + 结束时判定 ----
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = String(session?.header?.id ?? session?.id ?? 'unknown')
        if (event?.type === 'turn/start') {
          turnStartedAt.set(sessionId, num(event.time) || Date.now())
          return
        }
        if (event?.type !== 'turn/end') return
        const startedAt = turnStartedAt.get(sessionId)
        turnStartedAt.delete(sessionId)
        const endedAt = num(event.time) || Date.now()
        const durationMs = startedAt ? endedAt - startedAt : 0
        const kind = shouldNotify({
          reason: event?.data?.reason,
          durationMs,
          minDurationMs,
          notifyOnComplete,
          notifyOnError,
          notifyOnInterrupt,
        })
        if (!kind) return
        const sessionShort = sessionId.length > 12 ? sessionId.slice(-8) : sessionId
        // SessionHeader 没有 title 字段；用工作目录名当「任务名」更好认
        const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
        const title = cwd !== '' ? path.basename(cwd) : ''
        const { title: toastTitle, body } = describeOutcome(kind, { durationMs, sessionShort, title })
        void deliver(toastTitle, body, { kind, session: sessionShort })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }),
  )

  // ---- 工具：手动通知 ----
  ctx.effect(() =>
    tools.register({
      name: 'notify',
      description:
        'Send a desktop notification to the human right now (Windows toast + sound). Use it to report a long-running result, ask for attention, or flag something they may be waiting on. Keep the body short and actionable.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (<= 80 chars).' },
          body: { type: 'string', description: 'One or two sentences the human should see without opening DSH.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sent: { type: 'boolean' },
            code: { type: 'string' },
            transport: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            lastError: { type: 'string' },
          },
          required: ['sent', 'code', 'transport', 'title', 'body', 'lastError'],
          additionalProperties: false,
        },
        render(_args, value) {
          const label =
            value?.transport === 'toast'
              ? '桌面通知（Toast）'
              : value?.transport === 'balloon'
                ? '托盘气泡'
                : '仅记录日志（无可用通知通道）'
          return [
            text(
              value?.sent
                ? `已发送${label}：${value?.title ?? ''}\n${value?.body ?? ''}`
                : `发送失败（${label}）${value?.code ? `[${value.code}] ` : ''}：${value?.lastError || '未知原因'}`,
            ),
          ]
        },
      },
      async execute(args) {
        const title = compact(typeof args?.title === 'string' ? args.title : '', 80) || 'DSH 提醒'
        const body = compact(typeof args?.body === 'string' ? args.body : '')
        const transport = await deliver(title, body, { kind: 'manual' })
        const ok = transport !== 'log' || !canToast
        return {
          sent: ok,
          // 稳定错误码：脚本按 code 命中，不用去正则匹配自然语言。
          code: ok ? '' : 'NOTIFY_TRANSPORT_UNAVAILABLE',
          transport,
          title,
          body,
          lastError: ok ? '' : lastError,
        }
      },
    }),
  )

  // ---- 工具：诊断 ----
  ctx.effect(() =>
    tools.register({
      name: 'notify_status',
      description:
        'Diagnostics for the notification plugin: transport availability, thresholds, how many were sent/failed, the store path, and the most recent notification.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            transport: { type: 'string' },
            toastAvailable: { type: 'boolean' },
            minDurationMs: { type: 'integer' },
            notifyOnComplete: { type: 'boolean' },
            notifyOnError: { type: 'boolean' },
            notifyOnInterrupt: { type: 'boolean' },
            sound: { type: 'boolean' },
            storeDir: { type: 'string' },
            files: { type: 'integer' },
            entries: { type: 'integer' },
            sent: { type: 'integer' },
            failed: { type: 'integer' },
            lastSentAt: { type: 'string' },
            lastTransport: { type: 'string' },
            lastError: { type: 'string' },
          },
          required: [
            'ready',
            'unavailableReason',
            'transport',
            'toastAvailable',
            'minDurationMs',
            'notifyOnComplete',
            'notifyOnError',
            'notifyOnInterrupt',
            'sound',
            'storeDir',
            'files',
            'entries',
            'sent',
            'failed',
            'lastSentAt',
            'lastTransport',
            'lastError',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          const channel = value?.lastTransport
            ? { toast: '原生 Toast', balloon: '托盘气泡', log: '仅日志' }[value.lastTransport] ?? value.lastTransport
            : '（还没发过）'
          return [
            text(
              [
                value?.ready === true
                  ? '状态：就绪（桌面通知通道可用）'
                  : `不可用：${value?.unavailableReason || '未知原因'}`,
                `通知通道：${value?.toastAvailable ? '可用（5.1 Toast → WinForms 气泡 回退）' : '仅日志（非 Windows 或无 subprocess）'}`,
                `最近实际通道：${channel}`,
                `触发：完成(≥${Math.round(num(value?.minDurationMs) / 1000)}s)=${value?.notifyOnComplete ? '开' : '关'} · 失败=${value?.notifyOnError ? '开' : '关'} · 中断=${value?.notifyOnInterrupt ? '开' : '关'}`,
                `日志：${value?.storeDir ?? '?'}（${value?.files ?? 0} 天 / ${value?.entries ?? 0} 条）`,
                `本次运行：成功 ${value?.sent ?? 0} / 失败 ${value?.failed ?? 0}`,
                `最近发送：${value?.lastSentAt || '—'}`,
                value?.lastError ? `最近错误：${value.lastError}` : '最近错误：（无）',
              ].join('\n'),
            ),
          ]
        },
      },
      async execute() {
        let files = 0
        let entries = 0
        if (existsSync(storeDir)) {
          let names = []
          try {
            names = readdirSync(storeDir)
          } catch {
            names = []
          }
          for (const name of names) {
            if (!/^notify-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
            files += 1
            const full = path.join(storeDir, name)
            try {
              entries += readFileSync(full, 'utf8').split('\n').filter(Boolean).length
            } catch {
              /* 忽略单文件读取失败 */
            }
          }
        }
        // 判据就是既有的 toastAvailable：拿不到 WinRT Toast 通道时通知仍会写日志，但契约要如实说「不可用」。
        const ready = canToast
        return {
          ready,
          unavailableReason: ready ? '' : '非 Windows 或无 subprocess 服务，通知只能落日志（不会弹窗）',
          transport: ready ? 'toast' : 'log',
          toastAvailable: canToast,
          minDurationMs,
          notifyOnComplete,
          notifyOnError,
          notifyOnInterrupt,
          sound,
          storeDir,
          files,
          entries,
          sent,
          failed,
          lastSentAt,
          lastTransport,
          lastError,
        }
      },
    }),
  )
}
