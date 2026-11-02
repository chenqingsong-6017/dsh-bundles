/**
 * dsh-auto-approve —— 分类器代审（v1：确定性规则引擎）
 *
 * 学谁：Claude Code 的 auto 档——机器守住边界、人不必逐条点。
 * DSH 之前只有「三档预设 + 人工审批」，没有中间那层代审；
 * 本插件在 tools/pre-execute（每次工具派发前必经的 waterfall）补一条策略判断：
 *   deny  → 直接拒绝（不等下游，早停）
 *   ask   → 要求人工确认（但下游若已 deny，deny 优先）
 *   allow → 先问下游；只有下游本来要人工确认时才降级为放行（只收紧、不放松下游）
 *   无命中 → next() 交回原链路，原有行为完全不变
 *
 * 官方对照：DSH 自带 @deepseek-ai/dsh-experimental-auto-review（Auto 预设的
 * LLM 审阅门，experimental）。本插件 v1 刻意不复刻它，只做规则引擎：可预测、
 * 零延迟、零成本、可复现；LLM 分类器只留接口（config.llm.enabled 默认 false）。
 *
 * 已知边界（刻意不做）：
 *   - 不做命令语义解析，只有正则；不跟踪多步攻击链
 *   - run_code 内部发起的 PTC 子调用不经过这里（只审外层工具派发）
 *   - 不实现网络调用、不读密钥；v2 分类器由宿主注入，本插件不打包模型客户端
 *   - 监听顺序受插件加载顺序影响：若别的插件在本插件之前就返回 ask/deny，
 *     本插件拿不到这次调用（这是 DSH waterfall 的固有性质）
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-auto-approve'
export const inject = ['tools']

const DEFAULT_MAX_RECORDS = 20
const HARD_MAX_RECORDS = 200
const MAX_CONFIG_BYTES = 64 * 1024
const DECISIONS = ['allow', 'ask', 'deny']
const SEVERITY = { deny: 0, ask: 1, allow: 2 }
const SOURCE_LABEL = { project: '项目规则', user: '用户规则', builtin: '内置红线', classifier: 'v2 分类器' }
const DECISION_LABEL = { allow: '放行', ask: '需人工确认', deny: '拒绝', none: '不干预' }
/**
 * 内置红线只查「命令/代码文本」和「路径参数」，不查整段参数 JSON。
 * 理由：write/edit 的 content、bash 的 description 里出现 rm -rf / 或 .ssh/ 只是文字，
 * 按整段 JSON 匹配会把「写文档」也拦掉（踩过的坑）。
 */
const COMMAND_FIELDS = ['command', 'code', 'script', 'text']
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'target', 'target_path', 'new_path', 'old_path']
/**
 * 用户规则没写 `fields` 时的默认匹配范围：只看「命令/路径」字段，不对整段参数 JSON 匹配。
 * 理由（2026-11-01 扫描 #4）：写文档/写测试时正文 `content` 里提到规则关键词，
 * 按整段 JSON 匹配会把「写文档」也判成违规；规则作者要扫正文时显式写 `fields: ["content"]`，
 * 要恢复旧行为（整段 JSON）写 `fields: ["*"]`。
 */
const DEFAULT_RULE_FIELDS = [...PATH_FIELDS, ...COMMAND_FIELDS]

const text = (value) => ({ type: 'text', text: value })

/** $DSH_HOME：优先环境变量（跟 DSH 本身一致），否则 <用户主目录>/.dsh。 */
export function dshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 两层规则文件的路径，项目级在前（优先）。 */
export function ruleFiles(options = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  const home = typeof options.dshHome === 'string' && options.dshHome.trim() !== '' ? options.dshHome.trim() : dshHome()
  const files = []
  if (cwd !== '') files.push({ file: path.join(cwd, '.dsh', 'auto-approve.json'), scope: 'project' })
  files.push({ file: path.join(home, 'auto-approve.json'), scope: 'user' })
  return files
}

/**
 * 内置红线：没有任何配置也生效，只做 deny，不做 allow 放行。
 * 与 dsh-hooks 六层护栏的分工：hooks 拦硬红线（37 条规则 + 护栏自保护），
 * 本插件默认只保留最不可逆的 5 条，避免和 hooks 抢同一个判断。
 * fields 限定只匹配哪些参数：前三条例线看命令/代码文本，后两条看路径与命令，
 * 都不看文件内容与 description——写文档提到 rm -rf / 不该被拦。
 */
export const BUILTIN_REDLINES = [
  {
    id: 'rm-root',
    name: '删除根目录',
    decision: 'deny',
    tools: /^(bash|pwsh|run_code|terminal|terminal_send|exec)$/i,
    match: /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\s+(?:--no-preserve-root\s+)?["']?\/(?=["'\s*]|$)/i,
    fields: COMMAND_FIELDS,
    reason: '命令行里有 rm -rf /，会清空整块磁盘，没有后悔药。',
  },
  {
    id: 'windows-format',
    name: '格式化磁盘',
    decision: 'deny',
    tools: /^(bash|pwsh|run_code|terminal|terminal_send|exec)$/i,
    match: /\bformat\s+[a-z]:(?=["'\s\\/]|$)|\bformat-volume\b/i,
    fields: COMMAND_FIELDS,
    reason: '命令行里有 format / Format-Volume，会格式化磁盘。',
  },
  {
    id: 'vssadmin-shadows',
    name: '删除卷影副本',
    decision: 'deny',
    tools: /^(bash|pwsh|run_code|terminal|terminal_send|exec)$/i,
    match: /\bvssadmin\s+delete\s+shadows\b/i,
    fields: COMMAND_FIELDS,
    reason: '命令行里有 vssadmin delete shadows，会删掉系统还原点与卷影备份。',
  },
  {
    id: 'ssh-write-path',
    name: '写 .ssh 目录',
    decision: 'deny',
    tools: /^(write|edit|multi_edit|apply_patch|patch)$/i,
    match: /[\\/]\.ssh[\\/]/i,
    fields: PATH_FIELDS,
    reason: '这次调用要写 .ssh 目录，可能改动私钥或免密登录配置。',
  },
  {
    // 命令/代码里只认「写动作 → .ssh 路径」这个组合，不认孤立出现的 .ssh。
    // 否则 `ls ~/.ssh/`、`Get-ChildItem ~/.ssh` 这类纯只读命令会被误拒（2026-11-01 实测）。
    id: 'ssh-write-shell',
    name: '命令写 .ssh 目录',
    decision: 'deny',
    tools: /^(bash|pwsh|run_code|terminal|terminal_send|exec)$/i,
    match: /(?:>>?|set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|\bcp\b|\bmv\b|\bscp\b|\brsync\b|writefilesync|appendfilesync|createwritestream|writefile|copyfile|renamesync)[^|;]{0,120}[\\/]\.ssh[\\/]/i,
    fields: COMMAND_FIELDS,
    reason: '命令里有写操作指向 .ssh 目录，可能改动私钥或免密登录配置。',
  },
  {
    id: 'credentials-write-path',
    name: '写凭据文件',
    decision: 'deny',
    tools: /^(write|edit|multi_edit|apply_patch|patch)$/i,
    // 只认整段文件名 .credentials / .credentials.yaml 这类后缀；
    // `.credentials-guide.md` 是文档不是凭据，不能被拦（2026-11-01 实测）。
    match: /[\\/]\.credentials(\.[a-z0-9]+)?$/i,
    fields: PATH_FIELDS,
    reason: '这次调用要写 .credentials 凭据文件。',
  },
  {
    id: 'credentials-write-shell',
    name: '命令写凭据文件',
    decision: 'deny',
    tools: /^(bash|pwsh|run_code|terminal|terminal_send|exec)$/i,
    match: /(?:>>?|set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|\bcp\b|\bmv\b|\bscp\b|writefilesync|appendfilesync|createwritestream|writefile|copyfile)[^|;]{0,120}\.credentials(\.[a-z0-9]+)?/i,
    fields: COMMAND_FIELDS,
    reason: '命令里有写操作指向 .credentials 凭据文件。',
  },
]

/** 内置红线转成和配置规则一样的形状（tool/match 都是编译好的正则）。 */
export function compiledRedlines() {
  return BUILTIN_REDLINES.map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: 'builtin',
    decision: entry.decision,
    tool: entry.tools instanceof RegExp ? entry.tools : null,
    match: entry.match instanceof RegExp ? entry.match : null,
    fields: Array.isArray(entry.fields) ? entry.fields : null,
    reason: entry.reason,
  }))
}

/**
 * 解析一份规则文件。永不抛错：
 *   顶层可以是数组，也可以是 { rules: [...] }（方便以后加配置）。
 * 单条坏了只丢这条并记错误，不连累整份文件。
 */
export function parseRulesConfig(raw, source = 'user') {
  const errors = []
  let data
  try {
    data = JSON.parse(String(raw ?? ''))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { rules: [], errors: ['不是合法 JSON：' + message] }
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.rules) ? data.rules : null
  if (list === null) return { rules: [], errors: ['顶层应是数组，或含 rules 数组的对象'] }

  const rules = []
  list.forEach((item, index) => {
    const at = '第 ' + (index + 1) + ' 条'
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(at + '：不是对象')
      return
    }
    const decision = DECISIONS.includes(item.decision) ? item.decision : ''
    if (decision === '') {
      errors.push(at + '：decision 必须是 allow / ask / deny')
      return
    }
    let tool = null
    if (typeof item.tool === 'string' && item.tool.trim() !== '') {
      try {
        tool = new RegExp(item.tool.trim(), 'i')
      } catch {
        errors.push(at + '：tool 不是合法正则：' + item.tool)
        return
      }
    }
    let match = null
    if (typeof item.match === 'string' && item.match.trim() !== '') {
      try {
        match = new RegExp(item.match.trim(), 'i')
      } catch {
        errors.push(at + '：match 不是合法正则：' + item.match)
        return
      }
    }
    // fields：不写就只看命令/路径字段（DEFAULT_RULE_FIELDS），不扫正文；
    // 显式 ["*"] = 恢复旧行为（整段参数 JSON）；显式空/非法 → 丢掉这条并记错。
    let fields = DEFAULT_RULE_FIELDS
    if (item.fields !== undefined) {
      const wildcard = item.fields === '*' || (Array.isArray(item.fields) && item.fields.length === 1 && item.fields[0] === '*')
      if (wildcard) {
        fields = null
      } else if (Array.isArray(item.fields) && item.fields.some((entry) => typeof entry === 'string' && entry.trim() !== '')) {
        fields = item.fields.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
      } else {
        errors.push(at + '：fields 必须是非空字符串数组（如 ["command"]），要匹配整段参数写 ["*"]')
        return
      }
    }
    const ruleName = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : '#' + (index + 1)
    rules.push({
      name: ruleName,
      source,
      decision,
      tool,
      match,
      fields,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    })
  })
  return { rules, errors }
}

/** 工具参数转成一段可匹配的文本；不可 JSON 化时退回空串（规则不命中，不抛错）。 */
export function argText(args) {
  try {
    const rendered = JSON.stringify(args)
    return typeof rendered === 'string' ? rendered : ''
  } catch {
    return ''
  }
}

/** 取 params 里指定字段的字符串值，用于「只查路径/命令，不查文件内容」。 */
export function fieldTexts(args, fields) {
  const texts = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return texts
  for (const key of fields) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') texts.push(value)
  }
  return texts
}

/**
 * 一条规则是否命中这次调用。
 *   tool  过滤工具名；match 过滤参数文本；两条都空 = 全命中
 *   fields 不为空时只从这些参数里取文本匹配（没有这些参数 → 不命中，避免误伤）
 */
export function ruleMatches(rule, toolName, argsJson, args) {
  if (rule === null || rule === undefined) return false
  if (rule.tool instanceof RegExp && !rule.tool.test(String(toolName ?? ''))) return false
  if (rule.match instanceof RegExp) {
    const fields = Array.isArray(rule.fields) && rule.fields.length > 0 ? rule.fields : null
    if (fields === null) {
      if (!rule.match.test(String(argsJson ?? ''))) return false
    } else {
      const texts = fieldTexts(args, fields)
      if (texts.length === 0) return false
      if (!texts.some((piece) => rule.match.test(piece))) return false
    }
  }
  return true
}

/**
 * 纯函数判定：收集全部命中，按 deny > ask > allow 取最严的一条。
 * 同级并列时按传入顺序（项目级 → 用户级 → 内置红线）取第一条。
 */
export function pickVerdict(matches) {
  const list = Array.isArray(matches) ? matches : []
  if (list.length === 0) return { decision: 'none', rule: null, matches: [] }
  let winner = list[0]
  for (const rule of list) {
    if (SEVERITY[rule.decision] < SEVERITY[winner.decision]) winner = rule
  }
  return { decision: winner.decision, rule: winner, matches: list }
}

/** 纯函数判定入口。builtins: false 可关闭内置红线（默认开）。 */
export function decideCall(input = {}) {
  const toolName = String(input.toolName ?? '')
  const argsJson = argText(input.args)
  const matches = []
  const layers = [
    ...(Array.isArray(input.projectRules) ? input.projectRules : []),
    ...(Array.isArray(input.userRules) ? input.userRules : []),
    ...(input.builtins === false ? [] : compiledRedlines()),
  ]
  for (const rule of layers) {
    if (ruleMatches(rule, toolName, argsJson, input.args)) matches.push(rule)
  }
  return pickVerdict(matches)
}

/** 命中规则的人话标签：项目规则「禁止删库」。 */
export function ruleLabel(rule) {
  if (rule === null || rule === undefined) return ''
  const source = SOURCE_LABEL[rule.source] ?? '规则'
  return source + '「' + String(rule.name ?? '未命名') + '」'
}

/** 拒绝/确认理由：发生了什么 + 为什么 + 下一步（plugin-ux R3）。 */
export function decisionMessage(verdict) {
  const rule = verdict?.rule
  const label = ruleLabel(rule)
  const why = typeof rule?.reason === 'string' && rule.reason.trim() !== '' ? rule.reason.trim() : '这条规则没有写理由'
  if (verdict?.decision === 'deny') {
    return [
      'dsh-auto-approve 拒绝了这次调用（命中' + label + '）。',
      why,
      '要放行同类调用：把 .dsh/auto-approve.json 里这条规则改成 ask 或删掉；想先试规则：调 auto_approve_check；想看当前规则：调 auto_approve_status。',
    ].join('\n')
  }
  if (verdict?.decision === 'ask') {
    return [
      'dsh-auto-approve 需要你确认这次调用（命中' + label + '）。',
      why,
      '确认一次就会执行；不想每次都被问：把这条规则的 decision 改成 allow。',
    ].join('\n')
  }
  return 'dsh-auto-approve 没有命中任何规则，这次调用交回原有审批链路。'
}

/** 干跑输出的人话（auto_approve_check 的 render 用）。 */
export function describeCheck(verdict, toolName, ms) {
  const tool = String(toolName ?? '')
  if (verdict.decision === 'none') {
    return [
      '不干预：没有规则命中 ' + (tool === '' ? '这个工具' : tool) + ' —— 这次调用交回原有审批链路，该问还是会问。',
      '要给这类调用定策略：在 .dsh/auto-approve.json 加一条规则（tool 写工具名正则、match 写参数正则），改完不用重启。',
      '想看现在读的是哪些文件、有多少条规则：调 auto_approve_status。',
    ].join('\n')
  }
  const lines = [DECISION_LABEL[verdict.decision] + '：命中' + ruleLabel(verdict.rule)]
  const reason = verdict.rule?.reason?.trim?.() ?? ''
  if (reason !== '') lines.push('理由：' + reason)
  const list = Array.isArray(verdict.matches) ? verdict.matches : []
  if (list.length > 1) {
    const head = list.slice(0, 20).map((rule) => ruleLabel(rule)).join('、')
    lines.push('同时命中 ' + list.length + ' 条：' + head + (list.length > 20 ? '… 还有 ' + (list.length - 20) + ' 条' : ''))
  }
  if (verdict.decision === 'allow') {
    lines.push('说明：放行只在原有链路本来要人工确认时才生效；本就要拒绝的调用照样拒绝。')
  }
  lines.push('判定耗时 ' + (Number.isFinite(ms) ? ms : 0) + ' ms；改规则不用重启，下一次调用就读新文件。')
  return lines.join('\n')
}

function clampNumber(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** 配置归一化：v1 只有开关、内置红线、记录条数、文件覆盖、v2 分类器接口。 */
export function normalizeConfig(config) {
  const llm = config?.llm ?? {}
  return {
    enabled: config?.enabled !== false,
    builtins: config?.builtins !== false,
    maxRecords: clampNumber(config?.maxRecords, 1, HARD_MAX_RECORDS, DEFAULT_MAX_RECORDS),
    userFile: typeof config?.userFile === 'string' ? config.userFile.trim() : '',
    projectFile: typeof config?.projectFile === 'string' ? config.projectFile.trim() : '',
    llm: {
      enabled: llm?.enabled === true,
      timeoutMs: clampNumber(llm?.timeoutMs, 50, 10_000, 1200),
    },
    classifier: typeof config?.classifier === 'function' ? config.classifier : null,
  }
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  /** 文件路径 -> { mtimeMs, size, exists, rules, errors }（按 mtime+size 缓存） */
  const cache = new Map()
  const recent = []
  let lastError = ''
  const stats = { checks: 0, allow: 0, ask: 0, deny: 0, pass: 0, errors: 0, dryRuns: 0, llmCalls: 0 }

  const record = (tool, decision, rule, ms) => {
    recent.push({ at: new Date().toISOString(), tool: String(tool ?? ''), decision, rule: String(rule ?? ''), ms })
    while (recent.length > HARD_MAX_RECORDS) recent.shift()
  }

  const emptyLayer = (file, scope) => ({ file, scope, exists: false, rules: [], errors: [] })

  /** 读一层规则文件：按 mtime 缓存；读不到/坏 JSON 只丢弃这一层，绝不抛错。 */
  const loadLayer = (file, scope) => {
    if (typeof file !== 'string' || file === '') return emptyLayer('', scope)
    let stat
    try {
      stat = statSync(file)
    } catch {
      cache.delete(file)
      return emptyLayer(file, scope)
    }
    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached

    let entry
    if (!stat.isFile()) {
      entry = { ...emptyLayer(file, scope), exists: false }
    } else if (stat.size > MAX_CONFIG_BYTES) {
      entry = {
        file,
        scope,
        exists: true,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        rules: [],
        errors: ['文件超过 ' + MAX_CONFIG_BYTES + ' 字节，整份忽略'],
      }
    } else {
      try {
        const parsed = parseRulesConfig(readFileSync(file, 'utf8'), scope)
        entry = {
          file,
          scope,
          exists: true,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          rules: parsed.rules,
          errors: parsed.errors,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        entry = { file, scope, exists: true, mtimeMs: stat.mtimeMs, size: stat.size, rules: [], errors: ['读不到：' + message] }
      }
    }
    cache.set(file, entry)
    if (entry.errors.length > 0) {
      lastError = file + '：' + entry.errors[0]
      stats.errors += 1
    }
    return entry
  }

  const cwdOf = (session) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      const workingDirectory = service ?? ctx.workingDirectory
      if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value !== '') return value
      }
    } catch {
      /* 工作目录服务没就绪时退回会话 header */
    }
    const fromHeader = session?.header?.cwd
    if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
    return process.cwd()
  }

  const layersOf = (cwd) => {
    const defaults = ruleFiles({ cwd, dshHome: dshHome() })
    const projectFile = settings.projectFile !== '' ? settings.projectFile : (defaults.find((entry) => entry.scope === 'project')?.file ?? '')
    const userFile = settings.userFile !== '' ? settings.userFile : (defaults.find((entry) => entry.scope === 'user')?.file ?? '')
    return {
      project: loadLayer(projectFile, 'project'),
      user: loadLayer(userFile, 'user'),
    }
  }

  /** 纯策略计算，不碰 next()；抛错由调用方兜底。 */
  const evaluate = (toolName, args, cwd) => {
    const layers = layersOf(cwd)
    return decideCall({
      toolName,
      args,
      projectRules: layers.project.rules,
      userRules: layers.user.rules,
      builtins: settings.builtins,
    })
  }

  /** v2 预留：只调用宿主注入的分类器；超时/抛错/形状不对 → null（不干预）。 */
  const runClassifier = async (payload) => {
    if (!settings.llm.enabled || typeof settings.classifier !== 'function') return null
    stats.llmCalls += 1
    try {
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), settings.llm.timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      const answer = await Promise.race([Promise.resolve(settings.classifier(payload)), timeout])
      if (timer !== undefined) clearTimeout(timer)
      if (answer === null || answer === undefined || typeof answer !== 'object') {
        lastError = 'v2 分类器没有给出决策，已按不干预处理'
        return null
      }
      const decision = DECISIONS.includes(answer.decision) ? answer.decision : ''
      if (decision === '') {
        lastError = 'v2 分类器返回的 decision 认不出（可用 allow / ask / deny），已按不干预处理'
        return null
      }
      return {
        decision,
        rule: {
          name: typeof answer.name === 'string' && answer.name.trim() !== '' ? answer.name.trim() : 'v2 分类器',
          source: 'classifier',
          decision,
          reason: typeof answer.reason === 'string' ? answer.reason.trim() : '',
        },
        matches: [],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = 'v2 分类器异常：' + message
      stats.errors += 1
      return null
    }
  }

  const denyResult = (verdict) => ({
    kind: 'deny',
    reason: decisionMessage(verdict),
    info: {
      name: 'AutoApproveDeniedError',
      code: 'AUTO_APPROVE_DENIED',
      reason: verdict.rule?.reason ?? '',
    },
  })

  const askResult = (verdict) => ({
    kind: 'ask',
    reason: decisionMessage(verdict),
    displayReason: {
      en: 'dsh-auto-approve needs your confirmation: ' + (verdict.rule?.reason || ruleLabel(verdict.rule)),
      zh: 'dsh-auto-approve 需要你确认：' + (verdict.rule?.reason || ruleLabel(verdict.rule)),
    },
  })

  // 干跑/诊断工具自身不做策略判断：否则没法用它试危险规则（写规则时唯一的调试入口）
  const TOOL_EXEMPT = new Set(['auto_approve_check', 'auto_approve_status'])

  // ---- tools/pre-execute：唯一能拦动作的地方 ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const startedAt = Date.now()
    const toolName = String(exec?.name ?? '')
    let nextCalled = false
    const callNext = () => {
      nextCalled = true
      return next()
    }
    try {
      if (!settings.enabled) return callNext()
      if (TOOL_EXEMPT.has(toolName)) return callNext()

      const cwd = cwdOf(exec?.agent?.session ?? exec?.agent ?? exec?.session)
      let verdict = evaluate(toolName, exec?.arguments, cwd)
      if (verdict.decision === 'none') {
        const viaClassifier = await runClassifier({ tool: toolName, arguments: exec?.arguments ?? null, cwd })
        if (viaClassifier !== null) verdict = viaClassifier
      }

      const ms = Date.now() - startedAt
      if (verdict.decision === 'deny') {
        stats.checks += 1
        stats.deny += 1
        record(toolName, 'deny', ruleLabel(verdict.rule), ms)
        return denyResult(verdict)
      }

      if (verdict.decision === 'ask') {
        // 先问下游：下游已经 deny/cancel 就听下游的，避免「确认一次绕过硬护栏」
        const downstream = await callNext()
        if (downstream?.kind === 'deny' || downstream?.kind === 'cancel') {
          stats.checks += 1
          stats.deny += 1
          record(toolName, downstream.kind === 'cancel' ? 'pass' : 'deny', '下游拦截', ms)
          return downstream
        }
        stats.checks += 1
        stats.ask += 1
        record(toolName, 'ask', ruleLabel(verdict.rule), ms)
        return askResult(verdict)
      }

      if (verdict.decision === 'allow') {
        const downstream = await callNext()
        if (downstream?.kind === 'deny' || downstream?.kind === 'cancel') {
          stats.checks += 1
          stats.deny += 1
          record(toolName, downstream.kind === 'cancel' ? 'pass' : 'deny', '下游拦截', ms)
          return downstream
        }
        stats.checks += 1
        stats.allow += 1
        if (downstream?.kind === 'ask') {
          // 代审的全部价值就在这一步：下游会弹审批 → 这里直接放行
          record(toolName, 'allow', ruleLabel(verdict.rule), ms)
          return { kind: 'allow' }
        }
        record(toolName, 'allow', ruleLabel(verdict.rule) + '（本次未用到）', ms)
        return downstream ?? { kind: 'allow' }
      }

      // 无命中：保持既有行为
      const downstream = await callNext()
      stats.checks += 1
      stats.pass += 1
      record(toolName, 'pass', '', ms)
      return downstream
    } catch (error) {
      stats.errors += 1
      const message = error instanceof Error ? error.message : String(error)
      lastError = 'pre-execute 异常：' + message
      ctx.logger?.warn?.('auto-approve: pre-execute 失败 %o', error)
      // 下游自己的异常交回 DSH 处理；只有本插件自己的异常才 fail-safe 不干预
      if (nextCalled) throw error
      return callNext()
    }
  })

  // ---- 工具 1：干跑 ----
  const checkSchema = {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      decision: { type: 'string' },
      label: { type: 'string' },
      rule: { type: 'string' },
      source: { type: 'string' },
      reason: { type: 'string' },
      matched: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            source: { type: 'string' },
            decision: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['name', 'source', 'decision', 'reason'],
          additionalProperties: false,
        },
      },
      ms: { type: 'integer' },
    },
    required: ['tool', 'decision', 'label', 'rule', 'source', 'reason', 'matched', 'ms'],
    additionalProperties: false,
  }

  const renderCheck = (_args, value) => {
    const label = DECISION_LABEL[value?.decision] ?? String(value?.decision ?? '')
    if (value?.decision === 'none') {
      const tool = value?.tool ?? ''
      const lines = [
        '不干预：没有规则命中 ' + (tool === '' ? '这个工具' : tool) + ' —— 这次调用交回原有审批链路，该问还是会问。',
        '要给这类调用定策略：在 .dsh/auto-approve.json 加一条规则（tool 写工具名正则、match 写参数正则），改完不用重启。',
        '想看现在读的是哪些文件、有多少条规则：调 auto_approve_status。',
      ]
      return [text(lines.join('\n'))]
    }
    const lines = [label + '：命中' + (value?.source ?? '') + '「' + (value?.rule ?? '') + '」']
    if (typeof value?.reason === 'string' && value.reason !== '') lines.push('理由：' + value.reason)
    const matched = Array.isArray(value?.matched) ? value.matched : []
    if (matched.length > 1) {
      const head = matched.slice(0, 20).map((item) => item.source + '「' + item.name + '」').join('、')
      lines.push('同时命中 ' + matched.length + ' 条：' + head + (matched.length > 20 ? '… 还有 ' + (matched.length - 20) + ' 条' : ''))
    }
    if (value?.decision === 'allow') {
      lines.push('说明：放行只在原有链路本来要人工确认时才生效；本就要拒绝的调用照样拒绝。')
    }
    lines.push('判定耗时 ' + (value?.ms ?? 0) + ' ms；改规则不用重启，下一次调用就读新文件。')
    return [text(lines.join('\n'))]
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'auto_approve_check',
      description:
        'Dry-run the auto-approve policy for one tool call without executing it: shows whether the call would be allowed, sent to human confirmation, or denied, which rule matched, and why. Use it when tuning .dsh/auto-approve.json.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name to check, e.g. bash / pwsh / write / edit.' },
          arguments: {
            type: 'object',
            description: 'The arguments the tool would receive, e.g. { command: "npm test" }.',
            additionalProperties: true,
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      output: { schema: checkSchema, render: renderCheck },
      async execute(args, exec) {
        const startedAt = Date.now()
        const toolName = String(args?.tool ?? '')
        const cwd = cwdOf(exec?.agent?.session ?? exec?.agent ?? exec?.session)
        const verdict = evaluate(toolName, args?.arguments ?? null, cwd)
        const ms = Date.now() - startedAt
        stats.dryRuns += 1
        return {
          tool: toolName,
          decision: verdict.decision,
          label: DECISION_LABEL[verdict.decision] ?? verdict.decision,
          rule: verdict.rule === null ? '' : String(verdict.rule.name ?? ''),
          source: verdict.rule === null ? '' : (SOURCE_LABEL[verdict.rule.source] ?? '规则'),
          reason: verdict.rule?.reason ?? '',
          matched: verdict.matches.map((rule) => ({
            name: String(rule.name ?? ''),
            source: SOURCE_LABEL[rule.source] ?? '规则',
            decision: String(rule.decision ?? ''),
            reason: String(rule.reason ?? ''),
          })),
          ms,
        }
      },
    }),
  )

  // ---- 工具 2：诊断（唯一允许出现内部计数的地方）----
  const statusSchema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      ready: { type: 'boolean' },
      unavailableReason: { type: 'string' },
      builtinsEnabled: { type: 'boolean' },
      llmEnabled: { type: 'boolean' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            scope: { type: 'string' },
            exists: { type: 'boolean' },
            rules: { type: 'integer' },
            errors: { type: 'array', items: { type: 'string' } },
          },
          required: ['file', 'scope', 'exists', 'rules', 'errors'],
          additionalProperties: false,
        },
      },
      projectRules: { type: 'integer' },
      userRules: { type: 'integer' },
      builtinRules: { type: 'integer' },
      maxRecords: { type: 'integer' },
      stats: {
        type: 'object',
        properties: {
          checks: { type: 'integer' },
          allow: { type: 'integer' },
          ask: { type: 'integer' },
          deny: { type: 'integer' },
          pass: { type: 'integer' },
          errors: { type: 'integer' },
          dryRuns: { type: 'integer' },
          llmCalls: { type: 'integer' },
        },
        required: ['checks', 'allow', 'ask', 'deny', 'pass', 'errors', 'dryRuns', 'llmCalls'],
        additionalProperties: false,
      },
      recent: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time: { type: 'string' },
            tool: { type: 'string' },
            decision: { type: 'string' },
            rule: { type: 'string' },
            ms: { type: 'integer' },
          },
          required: ['time', 'tool', 'decision', 'rule', 'ms'],
          additionalProperties: false,
        },
      },
      errors: { type: 'array', items: { type: 'string' } },
      lastError: { type: 'string' },
    },
    required: [
      'enabled',
      'ready',
      'builtinsEnabled',
      'llmEnabled',
      'files',
      'projectRules',
      'userRules',
      'builtinRules',
      'maxRecords',
      'stats',
      'recent',
      'errors',
      'lastError',
    ],
    additionalProperties: false,
  }

  const renderStatus = (_args, value) => {
    const labels = { allow: '放行', ask: '要确认', deny: '拒绝', pass: '不干预' }
    const lines = [
      'dsh-auto-approve ' +
        (value?.enabled ? '已启用' : '已禁用') +
        '：本次运行判断 ' +
        (value?.stats?.checks ?? 0) +
        ' 次（放行 ' +
        (value?.stats?.allow ?? 0) +
        '、要确认 ' +
        (value?.stats?.ask ?? 0) +
        '、拒绝 ' +
        (value?.stats?.deny ?? 0) +
        '、不干预 ' +
        (value?.stats?.pass ?? 0) +
        '，异常 ' +
        (value?.stats?.errors ?? 0) +
        ' 次）。',
      '规则来源：',
    ]
    for (const entry of value?.files ?? []) {
      const mark = entry.exists ? '✓' : '✗'
      const scope = entry.scope === 'project' ? '项目级' : '用户级'
      const bad = entry.errors.length > 0 ? '，' + entry.errors.length + ' 处问题' : ''
      lines.push('  ' + mark + ' ' + entry.file + '（' + scope + '，' + entry.rules + ' 条规则' + bad + '）')
    }
    lines.push(
      '内置红线 ' +
        (value?.builtinRules ?? 0) +
        ' 条（' +
        (value?.builtinsEnabled ? '生效' : '已关闭') +
        '）；v2 分类器' +
        (value?.llmEnabled ? '已启用' : '未启用（v1 只做规则引擎）'),
    )
    const recent = Array.isArray(value?.recent) ? value.recent : []
    if (recent.length === 0) {
      lines.push('还没有判断记录：下一次工具调用就会产生一条。')
    } else {
      lines.push('最近判断（最多 ' + (value?.maxRecords ?? 0) + ' 条）：')
      for (const item of recent) {
        const label = labels[item.decision] ?? item.decision
        lines.push('  ' + item.time + '  ' + (item.tool || '-') + '  ' + label + '  ' + (item.rule || '-') + '  ' + item.ms + 'ms')
      }
    }
    const errors = Array.isArray(value?.errors) ? value.errors : []
    if (errors.length > 0) {
      lines.push('配置问题（坏文件按空规则处理，不影响工具调用）：')
      for (const error of errors.slice(0, 8)) lines.push('  ' + error)
      if (errors.length > 8) lines.push('  … 还有 ' + (errors.length - 8) + ' 条')
    }
    if (typeof value?.lastError === 'string' && value.lastError !== '') lines.push('最近一次异常：' + value.lastError)
    if (value?.ready === false) lines.unshift('不可用：' + (value?.unavailableReason || '未知原因'))
    return [text(lines.join('\n'))]
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'auto_approve_status',
      description:
        'Diagnostics for the auto-approve plugin: rule file paths and whether each loaded, rule counts per layer, decision statistics for this run, the most recent 20 decisions, and config errors. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: statusSchema, render: renderStatus },
      async execute(_args, exec) {
        const cwd = cwdOf(exec?.agent?.session ?? exec?.agent ?? exec?.session)
        const loaded = layersOf(cwd)
        const layers = [loaded.project, loaded.user]
        const errors = []
        for (const entry of layers) {
          for (const error of entry.errors) errors.push(entry.file + '：' + error)
        }
        // ready 判据：能真正参与审批吗 —— 插件启用，且（项目级/用户级规则文件可读 或 内置红线开着）
        const projectUsable = loaded.project.exists && loaded.project.errors.length === 0
        const userUsable = loaded.user.exists && loaded.user.errors.length === 0
        const builtinRules = settings.builtins ? BUILTIN_REDLINES.length : 0
        let ready = true
        let unavailableReason = ''
        if (!settings.enabled) {
          ready = false
          unavailableReason = '插件已停用（enabled: false），规则不参与审批'
        } else if (!projectUsable && !userUsable && builtinRules === 0) {
          ready = false
          unavailableReason =
            '规则文件都读不出来，且内置红线已关闭：项目级 ' +
            (loaded.project.file === '' ? '未配置' : loaded.project.file) +
            '；先用 auto_approve_status 的 errors 排查，或把 builtins 打开'
        }
        return {
          enabled: settings.enabled,
          ready,
          unavailableReason,
          builtinsEnabled: settings.builtins,
          llmEnabled: settings.llm.enabled,
          files: layers.map((entry) => ({
            file: entry.file,
            scope: entry.scope,
            exists: entry.exists,
            rules: entry.rules.length,
            errors: entry.errors.slice(),
          })),
          projectRules: layers[0].rules.length,
          userRules: layers[1].rules.length,
          builtinRules,
          maxRecords: settings.maxRecords,
          stats: { ...stats },
          recent: recent
            .slice(-settings.maxRecords)
            .reverse()
            .map((item) => ({
              time: String(item.at ?? '').slice(11, 19),
              tool: item.tool,
              decision: item.decision,
              rule: item.rule,
              ms: item.ms,
            })),
          errors,
          lastError,
        }
      },
    }),
  )
}
