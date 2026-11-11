/**
 * 受控领域词表（v4.13）——把 155 个自由 tag 归到 12 个 domain。
 *
 * 为什么需要：v4.12 做了分类检索（tags/scope 过滤），机制层真机验证通过（total==matches），
 * 但端到端只把聚合问题覆盖从 33% 提到 50%——因为 tag 本身碎片化：113 条记忆上有 155 个 tag，
 * 同义并存（plugin-dev/plugin/dsh-plugin、HMR/hmr、验证门/verification-gate/verify-gate）。
 *
 * 设计取舍（不批量改数据）：
 * 1. 两层分类：domain 是受控粗分类（12 个），原 tag 保留作细检索。
 *    改数据风险高——题集 gold、既有检索行为都依赖现状；映射表是只读视图，随时可改。
 * 2. 映射双向可用：memory_search({tags:["plugin-dev"]}) 传 domain 名会自动展开成该域下所有原 tag；
 *    传原 tag 仍精确匹配（向后兼容）。
 * 3. 一条 tag 只归一个 domain（统计不重复计数）；拿不准的归 misc，不硬塞。
 */

/** domain → 该域包含的原始 tag。tag 名大小写不敏感。 */
export const TAG_DOMAINS = {
  rule: [
    "硬规则", "rule", "workspace-rule", "行为约束", "价值观", "标准", "决策", "制度",
    "复盘", "方法", "设计原则", "working-style", "requirements", "judgment", "worldview",
    "三观", "人生规划", "长期", "preference", "偏好", "命名", "乔布斯", "规则收窄",
  ],
  memory: [
    "dsh-memory", "memory", "记忆", "curator", "负资产", "过时", "health", "procedure",
    "pitfall", "v4.0.0", "2026-11-01", "retrieval", "bench",
  ],
  "plugin-dev": [
    "plugin-dev", "plugin", "dsh-plugin", "plugin-update", "plugin-restore", "official-first",
    "publish", "schema", "ux", "refactor", "install", "减量", "插件契约", "插件减量",
    "dsh-butler-tidy", "skill-forge", "bulk-write",
  ],
  dsh: [
    "dsh", "HMR", "hmr", "dsh-settings", "context-guard", "dsh-shell", "dsh-data", "dsh 机制",
    "eventlog", "harness", "harness-paper", "reasoning-slider", "session", "session-clean",
    "upstream", "上游", "deepseek", "deepseek-repos", "0.2.2-rc.1", "dsh-maintenance",
    "dsh-standard", "官方能力", "upgrade", "batch", "kernels", "system", "架构", "整体进化",
  ],
  ops: [
    "tidy", "cleanup", "backup", "回滚", "备份", "维护", "maintenance", "archive",
    "inventory", "batch-write", "git", "待办", "工具", "ops", "env", "落地",
  ],
  research: [
    "调研", "research", "methodology", "方法论", "学习", "learning", "查法", "GitHub",
    "qian-xuesen", "control-theory",
  ],
  obsidian: ["obsidian"],
  machine: [
    "machine", "机器", "hardware", "性能", "virtualbox", "strata", "douyin", "glassboard",
    "port", "electron",
  ],
  eval: [
    "eval", "评测", "基线", "metrics", "checking", "verification-gate", "verify-gate",
    "验证缺口", "虚报", "认知缺口", "误报", "审计", "audit", "global-audit", "backlog",
    "bug", "fix", "验收", "P0", "P1", "P0-2", "P1-4", "task-11", "task-16", "group-b", "verified",
  ],
  workbuddy: ["workbuddy"],
  security: ["护栏", "junction", "auto-approve"],
  identity: ["身份", "爱妃", "人设", "语体", "画像"],
  misc: ["workspace-map", "hermes", "repo-map", "review"],
};

/** tag（小写）→ domain 的反向索引，模块加载时建一次。 */
const TAG_TO_DOMAIN = new Map()
for (const [domain, tags] of Object.entries(TAG_DOMAINS)) {
  for (const tag of tags) TAG_TO_DOMAIN.set(tag.toLowerCase(), domain)
}

const DOMAIN_NAMES = new Set(Object.keys(TAG_DOMAINS))

/** 某个 tag 属于哪个 domain；未登记返回 null。 */
export function domainOfTag(tag) {
  return TAG_TO_DOMAIN.get(String(tag ?? "").toLowerCase()) ?? null
}

/** 是不是一个受控 domain 名。 */
export function isDomainName(name) {
  return DOMAIN_NAMES.has(String(name ?? "").toLowerCase())
}

/**
 * 把过滤条件展开成「原 tag 集合」：
 * - 传 domain 名 → 展开成该域下所有原 tag（分类检索的入口）
 * - 传具体 tag → 原样保留（精确检索，向后兼容）
 * 两者可混传。
 */
export function expandTagFilter(tags) {
  const out = new Set()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? "").trim()
    if (tag === "") continue
    const asDomain = tag.toLowerCase()
    if (DOMAIN_NAMES.has(asDomain)) {
      for (const member of TAG_DOMAINS[asDomain]) out.add(member)
      continue
    }
    out.add(tag)
  }
  return out
}

/** 一条记忆的 domain 集合（去重）。无 tag 的条目返回空集。 */
export function domainsOfEntry(tags) {
  const out = new Set()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const domain = domainOfTag(raw)
    if (domain !== null) out.add(domain)
  }
  return out
}

/** 受控 domain 名单（稳定顺序，给诊断输出用）。 */
export function listDomains() {
  return Object.keys(TAG_DOMAINS)
}