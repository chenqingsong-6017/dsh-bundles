/**
 * 候选记忆抽取：从对话文本与规则文件里判「这条值不值得记」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { DERIVABLE_FLOOR, DERIVABLE_MIN_CHARS, MAX_CANDIDATES_PER_TURN, MAX_TEXT_CHARS } from './constants.js'
import { textSimilarity } from './text.js'
import { text } from './util.js'

// 顺序 = 信号强度：具体知识型在前，泛化命令式在后。
// 否则「结论是必须走 API」会被泛化的「必须」抢先命中，reason 就失真了。
const CANDIDATE_RULES = [
  { pattern: /记住|记一下|记下/, reason: '显式要求记住' },
  // v2.9：知识型陈述——真正值得沉淀的东西。原来的四条命令式规则只认「记住/以后/别再」，
  // 这类「实测/结论」型知识全被漏掉，候选池长期 0 条。
  { pattern: /已实测|实测过|验证过|已验证|踩过坑|踩坑|复现了/, reason: '实测结论' },
  { pattern: /结论是|结论：|根因|原因是|发现它|确认了/, reason: '结论/归因' },
  { pattern: /以后|下次|今后/, reason: '未来行为约定' },
  { pattern: /别再|不要再|不要用|不要/, reason: '禁止项' },
  { pattern: /一律|永远|必须|务必|规矩|约定/, reason: '硬规则措辞' },
]

/** 从用户消息里按规则抽「值得沉淀」的候选事实；纯规则、零模型调用。 */
export function extractCandidates(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return []
  // v2.9：先按句切分再逐句判定。原实现把整段消息塞进候选池，那不是原子事实；
  // 且一条消息最多出 MAX_CANDIDATES_PER_TURN 条，防止刷屏。
  const clauses = raw.split(/[。；;！!\n]/).map((item) => item.trim()).filter((item) => item !== '')
  const source = clauses.length > 0 ? clauses : [raw]
  const out = []
  for (const clause of source) {
    if (out.length >= MAX_CANDIDATES_PER_TURN) break
    if (clause.length < 8 || clause.length > 160) continue
    if (/[?？]$/.test(clause)) continue
    // v3.1 污染门：注入块自身的标记/提示语一律不收。剥离失败时这是最后一道防线。
    if (
      clause.includes('📌') ||
      clause.includes('<memory>') ||
      clause.includes('</memory>') ||
      clause.includes('<path-rules>') ||
      clause.includes('</path-rules>') ||
      clause.includes('<available_skills>') ||
      clause.includes('<system-reminder>') ||
      clause.includes('不要逐条复述') ||
      clause.includes('用 memory_search 按 id')
    ) {
      continue
    }
    const hit = CANDIDATE_RULES.find((rule) => rule.pattern.test(clause))
    if (hit === undefined) continue
    const kind = /别再|不要再|不要用|一律|永远|必须|务必|规矩|约定/.test(clause) ? 'rule' : 'fact'
    out.push({ text: clause.slice(0, MAX_TEXT_CHARS), kind, reason: hit.reason })
  }
  return out
}

/**
 * v3.17 规则文件沉淀：从 AGENTS.md / .dsh/rules 抽「硬规则」进候选池。
 * 起因（2026-10-30 实测）：搜「cua 工具被过滤成几个」「插件必须配什么测试」时记忆库空手 ——
 * 这两条规则只存在于规则文件里，从没进过记忆库。写入覆盖是记忆系统第一位的问题，
 * 而当时的候选沉淀只抓用户消息，抓不到 agent 读到的规则。
 *
 * 只抽「硬规则行」（必须/一律/永远/禁止/不要/不得/务必/只能），跳过代码块、标题、表格、引用。
 * 进**候选池**不直接入库 —— 影子模式不变，仍要人点头。
 */
const RULE_MARKERS = /必须|一律|永远|禁止|不要|不得|务必|只能|别再|绝对/

export function extractRuleCandidates(text, taken = new Set()) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return []
  const out = []
  let inFence = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('|')) continue
    if (trimmed.startsWith('>')) continue
    const body = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.、)]\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (body.length < 8 || body.length > 160) continue
    if (!RULE_MARKERS.test(body)) continue
    if (/[?？]$/.test(body)) continue
    // 以冒号结尾的是「引出下文」的引导句，不是规则本身（实测：「看资料时按这个顺序，不要一上来只搜 DSH 插件：」）。
    if (/[：:]$/.test(body)) continue
    if (taken.has(body)) continue
    out.push({ text: body.slice(0, MAX_TEXT_CHARS), kind: 'rule', reason: '规则文件' })
  }
  return out
}

/** 规则文件清单：工作区根 AGENTS.md / CLAUDE.md、.dsh/rules/*.md、全局 ~/.dsh/AGENTS.md。 */
export function collectRuleFiles(cwd) {
  const files = []
  if (typeof cwd === 'string' && cwd !== '') {
    files.push(path.join(cwd, 'AGENTS.md'))
    files.push(path.join(cwd, 'CLAUDE.md'))
    const rulesDir = path.join(cwd, '.dsh', 'rules')
    try {
      for (const name of readdirSync(rulesDir)) {
        if (name.endsWith('.md')) files.push(path.join(rulesDir, name))
      }
    } catch (error) {
      // 没有 .dsh/rules 目录是常态
    }
  }
  files.push(path.join(os.homedir(), '.dsh', 'AGENTS.md'))
  return files.filter((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch (error) {
      return false
    }
  })
}

/** v4.2：规则行归一化（去 markdown 装饰，只留语义文本），供「可推导」判定用。 */
export function normalizeRuleLine(line) {
  return String(line ?? '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.、)]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * v4.2（Anthropic A4 / write-path filtering）：这条记忆能不能从规则源（工作区 AGENTS.md /
 * .dsh/rules/*.md / 全局 AGENTS.md）推出来？能推出 → 返回 { source, similarity, quote }，调用方据此不记。
 *
 * 判据故意保守：与某一行「近重复」（bigram Jaccard ≥ DERIVABLE_FLOOR）或原文被该行包含才算命中。
 * 把多条规则压缩成一句「判据」的相似度低于门槛 → 照常入库（那是判据，不是第二份正文）。
 * 只扫规则源，不扫全仓代码：全仓扫描的 IO 成本与误杀率都不可接受（诚实边界见交付报告）。
 */
export function derivableHit(raw, cwd) {
  // 真机教训（2026-11-02）：规则行里带反引号/加粗，候选文本不带（或反过来），
  // 不归一化就做 includes 会假阴性——单测夹具没有反引号时看不出来，所以两边都过同一个归一化。
  const text = normalizeRuleLine(raw)
  if (text.length < 12) return null
  for (const file of collectRuleFiles(cwd)) {
    let body = ''
    try {
      body = readFileSync(file, 'utf8')
    } catch (error) {
      continue
    }
    body = body.replace(/^---[\s\S]*?\n---/, '')
    for (const line of body.split(/\r?\n/)) {
      const chunk = normalizeRuleLine(line)
      if (chunk.length < DERIVABLE_MIN_CHARS) continue
      if (chunk.includes(text)) return { source: file, similarity: 1, quote: chunk.slice(0, 120) }
      const similarity = textSimilarity(chunk, text)
      if (similarity >= DERIVABLE_FLOOR) return { source: file, similarity, quote: chunk.slice(0, 120) }
    }
  }
  return null
}
