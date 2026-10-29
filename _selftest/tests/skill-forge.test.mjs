import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, validateDraft, renderSkillFile, parseFrontmatter, scanSkills } from '../../dsh-skill-forge/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const GOOD_BODY = `## 何时用

当需要做某某事时使用。

## 步骤

1. 第一步。
2. 第二步。

## 验证

执行后检查某某输出。`

// ---- 1. 校验：名字 ----
assert.equal(validateDraft({ name: 'Bad_Name', description: '做某事。', body: GOOD_BODY }).ok, false)
ok('大写/下划线的名字被拒')
assert.equal(validateDraft({ name: 'a'.repeat(65), description: '做某事。', body: GOOD_BODY }).ok, false)
ok('超长名字被拒')
assert.equal(validateDraft({ name: 'nvidia-driver-upgrade', description: '做某事。', body: GOOD_BODY }).ok, true)
ok('kebab-case 名字通过')

// ---- 2. 校验：描述 ----
assert.equal(validateDraft({ name: 'x', description: 'a'.repeat(61) + '。', body: GOOD_BODY }).ok, false)
ok('超过 60 字符的描述被拒（截断等于没写）')
assert.equal(validateDraft({ name: 'x', description: '没有句号的描述', body: GOOD_BODY }).ok, false)
ok('无句号结尾的描述被拒')
assert.equal(validateDraft({ name: 'x', description: '升级显卡驱动并保留回滚路径。', body: GOOD_BODY }).ok, true)
ok('合规描述通过')

// ---- 3. 校验：正文三节 ----
const noVerify = GOOD_BODY.split('## 验证')[0]
const v = validateDraft({ name: 'x', description: '做某事。', body: noVerify })
assert.equal(v.ok, false)
assert.ok(v.errors.some((e) => e.includes('验证')), '应提示缺少验证一节')
ok('缺「验证」一节被拒且理由明确')

// ---- 4. 渲染 / 解析往返 ----
const rendered = renderSkillFile({ name: 'demo-skill', description: '演示: 含冒号的描述。', body: GOOD_BODY, createdAt: '2026-10-29T00:00:00.000Z' })
const parsed = parseFrontmatter(rendered)
assert.equal(parsed.name, 'demo-skill')
assert.equal(parsed.description, '演示: 含冒号的描述。')
assert.ok(parsed.content.includes('## 步骤'))
assert.equal(parsed.content.includes('---'), false)
ok('frontmatter 往返正确（含冒号的描述也能读回）')

// ---- 5. 集成：假 ctx 跑 apply，锻造 → 注册 → 检索 → 归档 ----
const store = mkdtempSync(path.join(tmpdir(), 'skill-forge-test-'))
const tools = new Map()
const providers = []
const ctx = {
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  skills: {
    registerProvider(factory) {
      providers.push(factory())
      return () => {}
    },
  },
  effect(fn) {
    const ret = fn()
    if (ret && typeof ret.next === 'function') {
      let step = ret.next()
      while (!step.done) step = ret.next(step.value)
    }
    return () => {}
  },
}

apply(ctx, { storeDir: store })

assert.equal(tools.size, 3, '应注册 3 个工具')
assert.equal(providers.length, 1, '应注册 1 个技能 provider')
ok('apply 注册了 3 工具 + 1 技能 provider')

const provider = providers[0]
assert.deepEqual(await provider.list(), [])
ok('初始技能目录为空')

const forge = tools.get('skill_forge')
const created = await forge.execute({
  name: 'demo-skill',
  description: '演示: 含冒号的描述。',
  body: GOOD_BODY,
  category: 'tests',
})
assert.ok(existsSync(created.path))
assert.equal(created.category, 'tests')
ok('skill_forge 落盘成功')

const listed = await provider.list()
assert.equal(listed.length, 1)
assert.equal(listed[0].name, 'demo-skill')
assert.equal(listed[0].provider, 'dsh-skill-forge')
assert.equal(listed[0].rank, 700)
assert.equal(listed[0].invocation.modelInvocable, true)
assert.equal(listed[0].source, 'forged')
assert.ok(listed[0].resourceBase.path.includes('tests'))
ok('provider 列表含正确 rank/source/invocation（可被原生目录收录）')

const got = await provider.get(listed[0], {})
assert.ok(got.content.startsWith('## 何时用'))
assert.equal(Object.hasOwn(got, 'rank'), false, 'get 不应把 rank 传回去')
assert.equal(Object.hasOwn(got, 'locator'), false)
ok('provider.get 返回去 frontmatter 的正文且剥掉内部字段')

const search = tools.get('skill_forge_search')
const hits = await search.execute({ query: '演示' })
assert.equal(hits.matches.length, 1)
assert.equal(hits.matches[0].name, 'demo-skill')
ok('skill_forge_search 可按描述命中')

const noHit = await search.execute({ query: '不存在的关键词zzz' })
assert.equal(noHit.matches.length, 0)
ok('无关键词时不误报')

// 重名不带 overwrite 应拒绝
let threw = false
try {
  await forge.execute({ name: 'demo-skill', description: '演示: 含冒号的描述。', body: GOOD_BODY, category: 'tests' })
} catch (e) {
  threw = true
  assert.ok(e.message.includes('overwrite'))
}
assert.equal(threw, true)
ok('重名且未 overwrite 被拒，并提示解法')

// overwrite 应归档旧版
const overwritten = await forge.execute({
  name: 'demo-skill',
  description: '演示: 第二版描述。',
  body: GOOD_BODY,
  category: 'tests',
  overwrite: true,
})
assert.ok(overwritten.archived, '应返回归档路径')
assert.ok(existsSync(overwritten.archived))
ok('overwrite 时旧版归档而非删除')

// 归档后目录扫描应排除 _archive
const afterOverwrite = await provider.list()
assert.equal(afterOverwrite.length, 1)
assert.equal(afterOverwrite[0].description, '演示: 第二版描述。')
ok('覆盖后目录只有新版（_archive 不参与收集）')

// retire 归队
const retire = tools.get('skill_forge_retire')
const retired = await retire.execute({ name: 'demo-skill' })
assert.ok(existsSync(retired.archivedTo))
assert.equal((await provider.list()).length, 0)
ok('skill_forge_retire 使技能退出目录（文件仍在）')

// 扫描应忽略 _archive
assert.equal(scanSkills(store).length, 0)
ok('scanSkills 跳过 _archive')

rmSync(store, { recursive: true, force: true })
console.log(`\n✅ skill-forge 自测通过：${passed} 项`)
