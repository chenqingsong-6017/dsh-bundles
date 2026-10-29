/**
 * dsh-verify —— 改完自检：自动识别并运行项目自己的检查命令。
 *
 * 学谁：Aider / Cline 的"改完跑测试"闭环，以及 `git hook + CI` 那套"检查先于交付"的习惯。
 * 但没做成"每次编辑后自动跑"——那会让每一步都变慢、输出还吵（UX 优先）。
 * 这里做成**按需工具**：agent 改完代码后自己调 `verify`，拿到的是一段人话结论 + 失败片段。
 *
 * 识别顺序（root = 会话工作目录或 path 参数）：
 *   1. bundle patch 里的 `customCommand`（字符串走 shell，数组直接 argv）
 *   2. package.json 的 scripts：test / lint / typecheck / check
 *      （包管理器按锁文件判断 pnpm / yarn / bun / npm）
 *   3. 有 tsconfig.json 但没配 typecheck 脚本 → `<包管理器> tsc --noEmit`
 *   4. go.mod → `go test ./...`；Cargo.toml → `cargo test`
 *   5. pyproject.toml / pytest.ini / tests 目录 → `python -m pytest -q`
 *   6. *.sln → `dotnet test`
 *   7. 都没有 → 明确告诉用户"没检测到"，并列出可用的 scripts
 *
 * 执行：走官方的 `ctx.subprocess`（collect 模式），超时先 terminate 再报告。
 * 输出：先结论（通过/失败 + 命令 + 用时），再给失败片段（默认最后 40 行），并说明省略了多少行。
 * 诊断细节（退出码、耗时、是否有 spill 文件）收进 `verify_status`。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-verify'
export const inject = ['tools', 'subprocess']

const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_MAX_LINES = 40
const MAX_COLLECT_BYTES = 256 * 1024

const text = (value) => ({ type: 'text', text: value })

/** 从工作区推断该跑什么（导出是为了单测） */
export function detectCheck(root, kind = 'auto', customCommand) {
  const custom = Array.isArray(customCommand) ? customCommand.filter((item) => typeof item === 'string') : []
  if (custom.length > 0) return { kind: 'custom', argv: custom, label: custom.join(' ') }
  if (typeof customCommand === 'string' && customCommand.trim() !== '') {
    return { kind: 'custom', shell: customCommand.trim(), argv: [], label: customCommand.trim() }
  }

  const readPkg = () => {
    const file = path.join(root, 'package.json')
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      return undefined
    }
  }

  const pkg = readPkg()
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  const has = (name) => typeof scripts[name] === 'string'
  // 包管理器按锁文件判断。bun 有新旧两种锁文件：bun.lockb（二进制）与 bun.lock（Bun 1.2+ 文本）。
  const packageManager = existsSync(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))
        ? 'bun'
        : 'npm'
  const wanted = kind === 'auto' ? ['test', 'lint', 'typecheck', 'check'] : [kind]
  for (const name of wanted) {
    if (has(name)) return { kind: name, argv: [packageManager, 'run', name], label: `${packageManager} run ${name}` }
  }

  // 有 tsconfig.json 却没配 typecheck 脚本：用 tsc --noEmit 兜底（只查类型、不产文件）。
  // 只认 auto / typecheck 两种 kind —— 显式要 test 时不该跑去查类型。
  if ((kind === 'auto' || kind === 'typecheck') && existsSync(path.join(root, 'tsconfig.json'))) {
    const runner = {
      npm: { argv: ['npx', 'tsc', '--noEmit'], label: 'npx tsc --noEmit' },
      pnpm: { argv: ['pnpm', 'exec', 'tsc', '--noEmit'], label: 'pnpm exec tsc --noEmit' },
      yarn: { argv: ['yarn', 'tsc', '--noEmit'], label: 'yarn tsc --noEmit' },
      bun: { argv: ['bunx', 'tsc', '--noEmit'], label: 'bunx tsc --noEmit' },
    }[packageManager]
    return { kind: 'typecheck', argv: runner.argv, label: runner.label }
  }

  const fallbackAllowed = kind === 'auto' || kind === 'test'
  if (fallbackAllowed && existsSync(path.join(root, 'go.mod'))) {
    return { kind: 'test', argv: ['go', 'test', './...'], label: 'go test ./...' }
  }
  if (fallbackAllowed && existsSync(path.join(root, 'Cargo.toml'))) {
    return { kind: 'test', argv: ['cargo', 'test'], label: 'cargo test' }
  }
  if (
    fallbackAllowed &&
    (existsSync(path.join(root, 'pyproject.toml')) ||
      existsSync(path.join(root, 'pytest.ini')) ||
      existsSync(path.join(root, 'tests')))
  ) {
    return { kind: 'test', argv: ['python', '-m', 'pytest', '-q'], label: 'python -m pytest -q' }
  }
  if (fallbackAllowed) {
    let entries = []
    try {
      entries = readdirSync(root)
    } catch (error) {
      entries = []
    }
    if (entries.some((name) => name.endsWith('.sln'))) {
      return { kind: 'test', argv: ['dotnet', 'test'], label: 'dotnet test' }
    }
  }
  return undefined
}

/** 从输出里挑"最像失败原因"的行：错误/断言优先，其次取尾部 */
function pickFailLines(lines, limit) {
  const interesting = lines.filter((line) =>
    /(error|fail|failed|failure|exception|assert|expected|received|✗|×|✖|Error:|panic)/i.test(line),
  )
  const chosen = interesting.length > 0 ? interesting : lines
  const tail = chosen.slice(-limit)
  return { lines: tail, omitted: Math.max(0, lines.length - tail.length) }
}

export function apply(ctx, config) {
  const timeoutMs =
    Number.isInteger(config?.timeoutMs) && config.timeoutMs > 0 ? Math.min(config.timeoutMs, 3600000) : DEFAULT_TIMEOUT_MS
  const maxLines =
    Number.isInteger(config?.maxOutputLines) && config.maxOutputLines > 0
      ? Math.min(config.maxOutputLines, 200)
      : DEFAULT_MAX_LINES
  const customCommand = config?.customCommand

  const tools = ctx.tools
  const subprocess = ctx.subprocess
  const workingDirectory = ctx.get('workingDirectory')
  let lastRun = null

  /**
   * 解析要检查的根目录，返回 { root } 或 { root: undefined, error }。
   *
   * 顺序：显式 path（相对会话目录解析）→ 会话已提交目录（同步 get，无 fs I/O）→ ensure 校验/恢复。
   * **绝不**拿 Host 进程的 process.cwd() 冒充会话目录：桌面版的 Host cwd 是 profile 目录，
   * 静默用它会让 verify 在错误的目录里跑检查、让 verify_status 显示假的工作区。
   */
  async function resolveRoot(exec, wantedPath) {
    const raw = typeof wantedPath === 'string' && wantedPath.trim() !== '' ? wantedPath.trim() : undefined
    let sessionCwd
    let sessionError

    if (workingDirectory) {
      if (exec?.session) {
        try {
          const committed = workingDirectory.get(exec.session)
          if (typeof committed === 'string' && committed.trim() !== '') sessionCwd = committed
        } catch (error) {
          sessionError = error instanceof Error ? error.message : String(error)
        }
      }
      if (!sessionCwd && exec?.agent) {
        try {
          sessionCwd = await workingDirectory.ensure(exec.agent, exec.signal)
        } catch (error) {
          sessionError = error instanceof Error ? error.message : String(error)
        }
      }
    } else {
      sessionError = 'workingDirectory 服务不可用'
    }

    if (raw !== undefined) {
      // 相对 path 必须有一个可信的基准目录；拿不到会话目录时不要用 Host 的
      // process.cwd()（桌面版那是 profile 目录）冒充，否则会在错的目录里跑检查。
      if (!sessionCwd && !path.isAbsolute(raw)) {
        return {
          root: undefined,
          error: `未取到会话工作目录（${sessionError ?? '未提供会话身份'}），无法解析相对 path: ${raw}`,
        }
      }
      return { root: path.resolve(sessionCwd ?? raw, raw) }
    }
    if (sessionCwd) return { root: sessionCwd }
    return {
      root: undefined,
      error: `未取到会话工作目录（${sessionError ?? '未提供会话身份'}）`,
    }
  }

  async function resolveArgv(detected) {
    if (typeof detected.shell === 'string') {
      const environment = await subprocess.terminalEnvironment().catch(() => undefined)
      const isWindows = (environment?.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')) === 'windows'
      const shell = environment?.defaultShell ?? (isWindows ? 'pwsh' : '/bin/sh')
      const shellPath = await subprocess.resolveExecutable(shell)
      const argv = isWindows
        ? [shellPath, '-NoLogo', '-NoProfile', '-Command', detected.shell]
        : [shellPath, '-lc', detected.shell]
      return { argv, label: detected.label }
    }
    const program = await subprocess.resolveExecutable(detected.argv[0])
    return { argv: [program, ...detected.argv.slice(1)], label: detected.label }
  }

  async function run(exec, args) {
    const resolved = await resolveRoot(exec, args?.path)
    const kind = typeof args?.kind === 'string' ? args.kind : 'auto'
    if (!resolved.root) {
      return {
        status: 'error',
        root: '',
        kind,
        command: '',
        timedOut: false,
        durationMs: 0,
        outputLines: 0,
        omittedLines: 0,
        lines: [],
        hint: `${resolved.error}。请传 path 显式指定要检查的目录，例如 path: 'D:\\你的项目'。`,
      }
    }
    const root = resolved.root
    const detected = detectCheck(root, kind, customCommand)
    if (!detected) {
      return {
        status: 'no-check',
        root,
        kind,
        command: '',
        timedOut: false,
        durationMs: 0,
        outputLines: 0,
        omittedLines: 0,
        lines: [],
        hint: '没有检测到可运行的检查命令。可以在 bundle patch 里配 customCommand，或先给项目加 test/lint 脚本。',
      }
    }

    const startedAt = Date.now()
    let argv
    try {
      argv = await resolveArgv(detected)
    } catch (error) {
      return {
        status: 'error',
        root,
        kind: detected.kind,
        command: detected.label,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        outputLines: 0,
        omittedLines: 0,
        lines: [],
        hint: `找不到可执行命令：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let handle
    try {
      handle = subprocess.spawn({
        argv: argv.argv,
        cwd: root,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_COLLECT_BYTES },
          stderr: { maxBytes: MAX_COLLECT_BYTES },
        },
        graceMs: 2000,
        signal: exec?.signal,
      })
    } catch (error) {
      return {
        status: 'error',
        root,
        kind: detected.kind,
        command: argv.label,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        outputLines: 0,
        omittedLines: 0,
        lines: [],
        hint: `启动失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        handle.terminate()
      } catch (error) {
        /* 已退出 */
      }
    }, timeoutMs)

    let outcome = { exitCode: null, signal: null }
    try {
      outcome = await handle.done
    } catch (error) {
      /* 启动/提供方失败，按 error 处理 */
    } finally {
      clearTimeout(timer)
    }

    const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
    const combined = `${stderr}\n${stdout}`.replace(/\r\n/g, '\n')
    const allLines = combined.split('\n').filter((line) => line.trim() !== '')
    const picked = pickFailLines(allLines, maxLines)
    const durationMs = Date.now() - startedAt
    const passed = outcome.exitCode === 0 && !timedOut

    lastRun = {
      root,
      command: argv.label,
      status: passed ? 'pass' : 'fail',
      ...(typeof outcome.exitCode === 'number' ? { exitCode: outcome.exitCode } : {}),
      durationMs,
      timedOut,
      at: new Date().toISOString(),
    }

    return {
      status: passed ? 'pass' : 'fail',
      root,
      kind: detected.kind,
      command: argv.label,
      exitCode: outcome.exitCode,
      timedOut,
      durationMs,
      outputLines: allLines.length,
      omittedLines: picked.omitted,
      lines: picked.lines,
      hint: passed ? '' : '修好上面这些失败后再跑一次 verify；完整输出可在项目目录手动重跑该命令。',
    }
  }

  const resultSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pass', 'fail', 'no-check', 'error'] },
      root: { type: 'string' },
      kind: { type: 'string' },
      command: { type: 'string' },
      exitCode: { type: 'integer' },
      timedOut: { type: 'boolean' },
      durationMs: { type: 'integer' },
      outputLines: { type: 'integer' },
      omittedLines: { type: 'integer' },
      lines: { type: 'array', items: { type: 'string' } },
      hint: { type: 'string' },
    },
    required: ['status', 'root', 'kind', 'command', 'timedOut', 'durationMs', 'lines', 'hint'],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'verify',
      description:
        'Run the workspace’s own check command (test / lint / typecheck, auto-detected from package.json scripts or common project files) and report pass/fail with the failing lines. Use it after edits instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace root (defaults to the session working directory).' },
          kind: {
            type: 'string',
            enum: ['auto', 'test', 'lint', 'typecheck', 'check', 'custom'],
            description: 'Which check to run; auto picks the first available of test → lint → typecheck.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: resultSchema, render: renderResult },
      async execute(args, exec) {
        return run(exec, args)
      },
    }),
  )

  function renderResult(_args, value) {
    const seconds = ((value?.durationMs ?? 0) / 1000).toFixed(1)
    if (value?.status === 'no-check') return [text(`没检测到可运行的检查命令（${value?.root ?? '?'}）。\n${value?.hint ?? ''}`)]
    if (value?.status === 'error') return [text(`检查没能跑起来：${value?.command ?? '?'}\n${value?.hint ?? ''}`)]
    if (value?.status === 'pass') {
      return [text(`✓ 检查通过：${value?.command ?? '?'}（${seconds}s，输出 ${value?.outputLines ?? 0} 行）`)]
    }
    const lines = Array.isArray(value?.lines) ? value.lines : []
    const timeoutNote = value?.timedOut ? `\n（超时被终止，只看了已产生的输出）` : ''
    const omitted = value?.omittedLines ? `\n… 另有 ${value.omittedLines} 行未显示（完整输出可在项目目录重跑该命令）` : ''
    const body = lines.length > 0 ? lines.map((line) => `  ${line}`).join('\n') : '  （没有捕获到输出）'
    return [text(`✗ 检查失败：${value?.command ?? '?'}（exit ${value?.exitCode ?? '?'}，${seconds}s）${timeoutNote}\n${body}${omitted}\n${value?.hint ?? ''}`)]
  }

  ctx.effect(() =>
    tools.register({
      name: 'verify_status',
      description: 'Show what check command would run for a workspace, the configured limits, and the last run result.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace root (defaults to the session working directory).' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            root: { type: 'string' },
            detected: { type: 'string' },
            kind: { type: 'string' },
            packageManager: { type: 'string' },
            scripts: { type: 'array', items: { type: 'string' } },
            timeoutMs: { type: 'integer' },
            maxOutputLines: { type: 'integer' },
            lastRun: { type: 'string' },
            notice: { type: 'string' },
          },
          required: ['root', 'detected', 'kind', 'scripts', 'timeoutMs', 'maxOutputLines'],
          additionalProperties: false,
        },
        render(_args, value) {
          const scripts = Array.isArray(value?.scripts) ? value.scripts : []
          const last = value?.lastRun ? `\n上次运行：${value.lastRun}` : '\n上次运行：（还没有）'
          const notice = value?.notice ? `\n⚠ ${value.notice}` : ''
          return [
            text(
              `工作区：${value?.root ?? '?'}\n将执行：${value?.detected || '（没检测到，需要 customCommand）'}\n包管理器：${value?.packageManager ?? '—'}\n可用 scripts：${scripts.length > 0 ? scripts.join(', ') : '（无）'}${last}\n上限：${value?.timeoutMs ?? '?'} ms / 最多显示 ${value?.maxOutputLines ?? '?'} 行${notice}`,
            ),
          ]
        },
      },
      async execute(args, exec) {
        const resolved = await resolveRoot(exec, args?.path)
        if (!resolved.root) {
          // 拿不到会话目录时不要编造工作区：明确报告并让调用方传 path。
          return {
            root: '（未解析）',
            detected: '',
            kind: '',
            packageManager: '—',
            scripts: [],
            timeoutMs,
            maxOutputLines: maxLines,
            lastRun: '',
            notice: `${resolved.error}。请传 path 显式指定工作区。`,
          }
        }
        const root = resolved.root
        let pkg
        try {
          pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
        } catch (error) {
          pkg = undefined
        }
        const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? Object.keys(pkg.scripts) : []
        const packageManager = existsSync(path.join(root, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(path.join(root, 'yarn.lock'))
            ? 'yarn'
            : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))
              ? 'bun'
              : existsSync(path.join(root, 'package.json'))
                ? 'npm'
                : '—'
        const detected = detectCheck(root, 'auto', customCommand)
        return {
          root,
          detected: detected?.label ?? '',
          kind: detected?.kind ?? '',
          packageManager,
          scripts,
          timeoutMs,
          maxOutputLines: maxLines,
          lastRun: lastRun ? `${lastRun.status} · ${lastRun.command} · ${(lastRun.durationMs / 1000).toFixed(1)}s · ${lastRun.at}` : '',
          notice: '',
        }
      },
    }),
  )
}
