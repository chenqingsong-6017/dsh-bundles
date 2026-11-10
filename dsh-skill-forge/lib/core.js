/**
 * dsh-skill-forge 核心 v0.1.0
 *
 * 学习循环的第二段（第一段是 dsh-harvest 的「会话 -> 事实候选」）：
 *   事实信号（纠错/规则） -> 聚类 -> skill 候选 -> 证据链 -> 复核入库。
 *
 * 借鉴（不是照抄）：
 * - EvoSkill（arXiv 2603.02766）：失败分析驱动的 skill 发现；
 * - HSE（arXiv 2610.35616）：分层证据聚合（任务 -> 项目 -> 跨项目）；
 * - Voyager（arXiv 2305.16291）：held-out 验证才保留。
 *
 * 按 DSH 约束降级（诚实取舍）：
 * 1. 零 LLM：插件只做确定性流水线；语义蒸馏由 agent 复核时完成（agent 本身就是模型）。
 * 2. 证据链：每条坑必须带 session/seq/time/quote；无证据不收。
 * 3. 只写候选，不自动入库；admit 必须 confirm。
 * 4. 入库写 <dshHome>/skills/<name>/SKILL.md（frontmatter 的 metadata.status=draft）。
 * 5. 幂等：候选按 id 去重；重复跑不产垃圾。
 * 6. 只读 harvest 产出，不重读原始会话（职责边界：采集归 harvest）。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_HARVEST = 'D:\\AI\\dsh-data\\harvest'
export const DEFAULT_STORE = 'D:\\AI\\dsh-data\\skill-forge'
export const CANDIDATE_FILE = 'candidates.jsonl'

/** 组内相似度达到这个值才算同一主题（bigram 余弦，0~1）。 */
const CLUSTER_THRESHOLD = 0.62
/** 同一主题至少积攒这么多条信号才算 high 置信（HSE 的「重复证据才算」）。 */
const HIGH_CONFIDENCE_GROUP = 2
/** 单条文本截断长度，避免候选正文被超长纠错撑爆。 */
const QUOTE_MAX = 160

/**
 * 主题表：把纠错/规则文本归到可复用 skill 主题，并给出候选的骨架。
 * 骨架只是「候选」，agent 复核时负责精炼成真正的 skill 正文。
 */
const THEMES = [
  {
    key: 'verification',
    label: '验证与实测',
    re: /(验证|实测|观测值|证据|真机|跑一遍|测试|检验|实践是检验)/,
    whenToUse: '声称完成/修复/生效前，需要真机验证时',
    steps: [
      '先写清「若这句话是错的，哪个观测值会不一样」',
      '改前取基线观测值，改后取同一观测值对比',
      '拿不出可复现的对比证据，不许说「完成/修好/生效」'
    ]
  },
  {
    key: 'accuracy',
    label: '准确性（不编不糊弄）',
    re: /(瞎|乱|编|幻觉|撒谎|说瞎话|糊弄|敷衍|粉饰|说错|搞错|不实)/,
    whenToUse: '陈述事实、引用数据、下结论时',
    steps: [
      '查不到就直说查不到，不编',
      '编的数字标「未验证」',
      '结论回到一行可点击证据（官方文档/源码/论文）'
    ]
  },
  {
    key: 'minimal-change',
    label: '不做最小改动',
    re: /(最小改动|偷懒|差不多|半吊子|只做表面|糊弄过去)/,
    whenToUse: '决定改动范围、决定是否做完时',
    steps: [
      '先问「这件事该不该做对做全」，不是「改动多少」',
      '该完整对齐就完整对齐，不拿「最小改动」当借口'
    ]
  },
  {
    key: 'process',
    label: '流程与顺序',
    re: /(流程|步骤|顺序|先.*再|然后|做事方法)/,
    whenToUse: '开始一项多步任务前',
    steps: [
      '按成本升序查：注入层 -> 记忆 -> 知识库 -> grep/read',
      '先拉判据再动手，不靠记性'
    ]
  },
  {
    key: 'cleanup',
    label: '清理与负资产',
    re: /(删除|清理|垃圾|负资产|过时|备份|留垃圾)/,
    whenToUse: '清理文件/会话/临时产物前',
    steps: [
      '先按三查：过时？以后有用？有价值？',
      '拿不准就留，并写一句「为什么留」'
    ]
  },
  {
    key: 'naming',
    label: '命名规范',
    re: /(命名|改名|英文|快捷方式|\.lnk|文件夹名)/,
    whenToUse: '新建或重命名文件/目录时',
    steps: [
      '意译或官方英文名，禁拼音',
      '快捷方式(.lnk)保持原名，不写驼峰'
    ]
  },
  {
    key: 'safety',
    label: '安全与护栏',
    re: /(危险|护栏|凭据|系统目录|不可逆|rm|删除三查)/,
    whenToUse: '执行删除/改配置/碰系统目录前',
    steps: [
      '红线不碰：系统目录、DSH 凭据、护栏配置',
      '删带 junction 的目录只用 rmdir，不用递归删'
    ]
  },
  {
    key: 'info-quality',
    label: '信息质量与时效',
    re: /(权威|时效|来源|一手|二手|GitHub|官方文档|版本)/,
    whenToUse: '找资料、做调研、判断版本兼容性时',
    steps: [
      '只信一手：官方 changelog、真实源码、论文',
      '版本看 git log -1，不看过时快照'
    ]
  }
]

/** 无主题命中时的兜底骨架。 */
const FALLBACK_THEME = {
  key: 'lesson',
  label: '经验教训',
  whenToUse: '遇到同类处境时',
  steps: ['回顾证据里记录的纠正/规则', '按证据修正做法']
}

// ---------- 基础 IO ----------

/** 读 JSONL；坏行跳过并计数，不让一行脏数据毁掉整批。 */
export function readJsonl(file) {
  if (!existsSync(file)) return { records: [], badLines: 0 }
  const records = []
  let badLines = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { records.push(JSON.parse(line)) } catch { badLines += 1 }
  }
  return { records, badLines }
}

/** 追加 JSONL（父目录不存在就建）。 */
export function appendJsonl(file, records) {
  if (!Array.isArray(records) || records.length === 0) return 0
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return records.length
}

/** 读全部候选（新文件不存在时返回空）。 */
export function readCandidates(options) {
  return readJsonl(path.join(options.storeDir, CANDIDATE_FILE))
}

// ---------- 文本相似（与 harvest 同口径，便于行为一致） ----------

export function normalizeText(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim()
}

export function bigramSet(value) {
  const text = normalizeText(value)
  const set = new Set()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

export function similarity(left, right) {
  const a = left instanceof Set ? left : bigramSet(left)
  const b = right instanceof Set ? right : bigramSet(right)
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return hit / Math.max(a.size, b.size)
}

// ---------- 信号筛选与主题分类 ----------

/**
 * 从 harvest 候选里挑出「流程与坑」信号。
 * harvest 只管事实（规则/纠正/偏好）；这里只取 correction 与 rule —— 偏好不构成流程。
 */
export function pickSignals(candidates) {
  return candidates.filter((c) =>
    c && typeof c.text === 'string' && c.text.trim() !== '' && (c.type === 'correction' || c.type === 'rule')
  )
}

/** 按主题表给文本分类；无命中返回兜底。 */
export function classifyTheme(text) {
  const raw = String(text || '')
  let best = null
  let bestHits = 0
  for (const theme of THEMES) {
    const hits = (raw.match(new RegExp(theme.re.source, 'g')) || []).length
    if (hits > bestHits) { best = theme; bestHits = hits }
  }
  return best || FALLBACK_THEME
}

// ---------- 聚类 ----------

/**
 * 按 cwd 分组，组内按 bigram 相似度聚类（HSE 的「同项目内重复证据才聚合」）。
 * @returns [{ cwd, items: candidate[] }]
 */
export function clusterSignals(signals, threshold) {
  const limit = typeof threshold === 'number' ? threshold : CLUSTER_THRESHOLD
  const used = new Set()
  const clusters = []
  const byCwd = new Map()
  for (const signal of signals) {
    const key = typeof signal.cwd === 'string' ? signal.cwd : ''
    if (!byCwd.has(key)) byCwd.set(key, [])
    byCwd.get(key).push(signal)
  }
  for (const [cwd, list] of byCwd) {
    for (let i = 0; i < list.length; i += 1) {
      if (used.has(i)) continue
      const group = [list[i]]
      const anchor = bigramSet(list[i].text)
      for (let j = i + 1; j < list.length; j += 1) {
        if (used.has(j)) continue
        if (similarity(anchor, bigramSet(list[j].text)) >= limit) {
          group.push(list[j])
          used.add(j)
        }
      }
      clusters.push({ cwd, items: group })
    }
  }
  return clusters
}

// ---------- 候选生成 ----------

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

function quoteOf(item) {
  const text = String(item.text || '').replace(/\s+/g, ' ').trim()
  return text.length > QUOTE_MAX ? text.slice(0, QUOTE_MAX) + '…' : text
}

/**
 * 一个 cluster -> 一个 skill 候选。
 * 置信度：同主题 >= HIGH_CONFIDENCE_GROUP 条（跨会话更有力）才 high。
 */
export function draftSkill(cluster, options) {
  const items = cluster.items || []
  if (items.length === 0) return null
  const theme = classifyTheme(items.map((i) => i.text).join(' '))
  const evidence = []
  const seen = new Set()
  for (const item of items) {
    const ev = item.evidence || {}
    const key = String(ev.session || '') + '#' + String(ev.seq == null ? '' : ev.seq)
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push({
      session: typeof ev.session === 'string' ? ev.session : '',
      seq: Number.isInteger(ev.seq) ? ev.seq : null,
      time: Number.isFinite(ev.time) ? ev.time : null,
      quote: quoteOf(item),
      cwd: typeof item.cwd === 'string' ? item.cwd : cluster.cwd || ''
    })
  }
  // 无证据不收（与 harvest 同一条规矩）
  if (evidence.length === 0) return null
  const sessionCount = new Set(evidence.map((e) => e.session).filter(Boolean)).size
  const confidence = items.length >= HIGH_CONFIDENCE_GROUP && sessionCount >= HIGH_CONFIDENCE_GROUP ? 'high' : 'medium'
  const idSeed = theme.key + '|' + cluster.cwd + '|' + items.map((i) => i.text).join('|')
  const id = 'sf-' + shortHash(idSeed)
  const name = theme.key + '-' + shortHash(idSeed).slice(0, 6)
  const first = quoteOf(items[0])
  const description = theme.label + '：' + (first.length > 80 ? first.slice(0, 80) + '…' : first)
  const existing = readCandidates(options).records.find((c) => c && c.id === id)
  if (existing) return existing
  return {
    id,
    name,
    theme: theme.key,
    label: theme.label,
    description,
    whenToUse: theme.whenToUse,
    steps: theme.steps.slice(),
    pitfalls: items.map(quoteOf),
    evidence,
    confidence,
    cwd: cluster.cwd || '',
    status: 'pending',
    createdAt: Date.now()
  }
}

// ---------- 入库（SKILL.md） ----------

/** 生成 SKILL.md 正文（frontmatter 必填 name/description，可选 whenToUse/metadata）。 */
export function renderSkillMd(candidate) {
  const lines = []
  lines.push('---')
  lines.push('name: ' + candidate.name)
  lines.push('description: ' + JSON.stringify(candidate.description))
  lines.push('whenToUse: ' + JSON.stringify(candidate.whenToUse))
  lines.push('metadata:')
  lines.push('  status: draft')
  lines.push('  source: dsh-skill-forge')
  lines.push('  confidence: ' + candidate.confidence)
  lines.push('  generatedAt: ' + new Date(candidate.createdAt || Date.now()).toISOString())
  lines.push('---')
  lines.push('')
  lines.push('# ' + candidate.name)
  lines.push('')
  lines.push('## 1. 一句话')
  lines.push('')
  lines.push(candidate.description)
  lines.push('')
  lines.push('## 2. 触发')
  lines.push('')
  lines.push(candidate.whenToUse)
  lines.push('')
  lines.push('## 3. 步骤')
  lines.push('')
  for (let i = 0; i < candidate.steps.length; i += 1) lines.push((i + 1) + '. ' + candidate.steps[i])
  lines.push('')
  lines.push('## 4. 坑（证据）')
  lines.push('')
  for (const pitfall of candidate.pitfalls) lines.push('- ' + pitfall)
  lines.push('')
  lines.push('## 5. 证据')
  lines.push('')
  for (const ev of candidate.evidence) {
    const when = ev.time ? new Date(ev.time).toISOString() : '?';
    const where = ev.session + (ev.seq == null ? '' : '#' + ev.seq)
    lines.push('- `' + where + '` @ ' + when + ' —— 「' + ev.quote + '」')
  }
  lines.push('')
  lines.push('> 本文件由 dsh-skill-forge 生成，status=draft；请 agent/人复核后把 metadata.status 改为 stable。')
  return lines.join('\n') + '\n'
}

/**
 * 采纳候选 -> 写 <skillsRoot>/<name>/SKILL.md。
 * @returns { ok, path?, reason? }
 */
export function admitSkill(candidate, options) {
  if (!candidate || typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return { ok: false, reason: 'SFE_CANDIDATE_INVALID: 候选缺 name，不能入库。' }
  }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    return { ok: false, reason: 'SFE_NO_EVIDENCE: 无证据的候选不许入库（与 harvest 同规矩）。' }
  }
  const skillsRoot = options.skillsRoot
  if (typeof skillsRoot !== 'string' || skillsRoot.trim() === '') {
    return { ok: false, reason: 'SFE_NO_SKILLS_ROOT: 未配置 skillsRoot。' }
  }
  const dir = path.join(skillsRoot, candidate.name)
  const file = path.join(dir, 'SKILL.md')
  if (existsSync(file) && options.force !== true) {
    return { ok: false, path: file, reason: 'SFE_EXISTS: 同名 SKILL.md 已存在；要覆盖请传 force:true。' }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, renderSkillMd(candidate), 'utf8')
  return { ok: true, path: file }
}

// ---------- 状态 / 主流程 ----------

export function status(options) {
  const { records, badLines } = readCandidates(options)
  const pending = records.filter((c) => c && c.status === 'pending')
  const admitted = records.filter((c) => c && c.status === 'admitted')
  const harvestDir = options.harvestDir
  const harvestCandidates = readJsonl(path.join(harvestDir, 'candidates.jsonl'))
  const harvestEpisodes = readJsonl(path.join(harvestDir, 'episodes.jsonl'))
  return {
    ready: true,
    storeDir: options.storeDir,
    harvestDir,
    skillsRoot: options.skillsRoot,
    harvestCandidates: harvestCandidates.records.length,
    harvestEpisodes: harvestEpisodes.records.length,
    candidates: records.length,
    pending: pending.length,
    admitted: admitted.length,
    badLines,
    lastError: ''
  }
}

/**
 * 主流程：读 harvest 候选 -> 挑信号 -> 聚类 -> 蒸馏候选 -> 追加（幂等）。
 * @returns { scanned, signals, clusters, created, skipped }
 */
export function run(options) {
  const harvestCandidates = readJsonl(path.join(options.harvestDir, 'candidates.jsonl'))
  const all = harvestCandidates.records
  const signals = pickSignals(all)
  const clusters = clusterSignals(signals, options.threshold)
  const created = []
  for (const cluster of clusters) {
    const draft = draftSkill(cluster, options)
    if (draft) created.push(draft)
  }
  const fresh = created.filter((c) => c && c.status === 'pending' && Array.isArray(c.evidence))
  // 只追加「新」候选：draftSkill 命中已有 id 时直接返回已有对象，这里按 id 去重
  const existingIds = new Set(readCandidates(options).records.map((c) => c && c.id).filter(Boolean))
  const toAppend = fresh.filter((c) => !existingIds.has(c.id))
  appendJsonl(path.join(options.storeDir, CANDIDATE_FILE), toAppend)
  return {
    scanned: all.length,
    signals: signals.length,
    clusters: clusters.length,
    created: toAppend.length,
    skipped: created.length - toAppend.length
  }
}

// ---------- held-out 验证 ----------

/**
 * held-out 检查：候选是否满足「可入库」条件（证据完整 + 主题明确）。
 * Voyager 的教训：只有通过 held-out 的才留在库里；这里把「入库前检查」做成可机器判。
 */
export function verifyCandidate(candidate) {
  const problems = []
  if (!candidate || typeof candidate !== 'object') return { ok: false, problems: ['SFE_CANDIDATE_INVALID'] }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) problems.push('SFE_NO_EVIDENCE')
  for (const ev of candidate.evidence || []) {
    if (!ev || typeof ev.quote !== 'string' || ev.quote.trim() === '') problems.push('SFE_EVIDENCE_NO_QUOTE')
    if (!ev || typeof ev.session !== 'string' || ev.session.trim() === '') problems.push('SFE_EVIDENCE_NO_SESSION')
  }
  if (typeof candidate.whenToUse !== 'string' || candidate.whenToUse.trim() === '') problems.push('SFE_NO_WHEN_TO_USE')
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) problems.push('SFE_NO_STEPS')
  return { ok: problems.length === 0, problems }
}

export { THEMES, FALLBACK_THEME, CLUSTER_THRESHOLD, HIGH_CONFIDENCE_GROUP }
