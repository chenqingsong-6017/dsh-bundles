import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  applySection,
  buildIndex,
  extractLinks,
  hasOneLiner,
  headingAnchors,
  isWriteAllowed,
  lintIndex,
  listVault,
  makeSnippet,
  matchHeadingAnchor,
  normalizeTarget,
  normalizeVaultPath,
  parseFrontmatter,
  parseMemoryPointers,
  safeResolve,
  scoreNote,
  sectionRange,
  sha256,
  slugifyHeading,
  splitFrontmatter,
} from "../../dsh-obsidian/index.js"

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

const host = (vaultDir, storeDir, extra) => {
  const defs = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
  }
  apply(ctx, { vaultDir, storeDir, buildOnStart: false, ...(extra ?? {}) })
  return { defs }
}

// ---- 夹具：一个像真库的小 vault ----
const root = mkdtempSync(path.join(os.tmpdir(), "dsh-obsidian-"))
const vault = path.join(root, "vault")
const store = path.join(root, "store")
const put = (rel, body) => {
  const abs = path.join(vault, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body, 'utf8')
}
put("a/Me.md", [
  '---', 'type: person', 'id: self', 'aliases:', '  - 陛下', 'tags:', '  - person', '  - self', '---',
  '# 我', '', '本机 CHEN-QS6017，D 盘放数据。[[b/Values|价值观]] 与 [[不存在]]。', ''
].join('\n'))
put('b/Values.md', ['---', 'type: values', 'tags: [values, principles]', '---', '# 价值观', '', '删除三查；不粉饰。', ''].join('\n'))
put('c/2026-11-01.md', ['---', 'type: journal', 'tags: [journal, daily]', '---', '# 2026-11-01', '', 'Obsidian 落地，画像卡起草完成。', ''].join('\n'))
put('bad.md', ['---', 'type: note', 'this line is junk', '---', '正文', ''].join('\n'))
put('d/People.base', 'filters:\n  and:\n    - file.hasTag("person")\nviews:\n  - type: table\n    name: 人物总览\n')
writeFileSync(path.join(vault, 'e-cover.png'), 'png-bytes', 'utf8')
put('.obsidian/app.json', '{}')
put('.git/config', '')

// ---- 纯函数 ----
{
  const normal = splitFrontmatter('---\ntype: x\n---\n# 标题\n正文')
  assert.equal(normal.frontmatter, 'type: x')
  assert.equal(normal.body, '# 标题\n正文')
  assert.equal(splitFrontmatter('---\ntype: x\n正文').frontmatter, null, '未闭合不当 frontmatter')
  assert.equal(splitFrontmatter('没有 frontmatter').frontmatter, null)
  const fm = parseFrontmatter(['---', 'type: person', 'tags:', '  - person', '  - self', "aliases: [\"陛下\", '陈总']", 'tier: 1', 'junk line', '---', '正文'].join('\n'))
  assert.equal(fm.data.type, 'person')
  assert.deepEqual(fm.data.tags, ['person', 'self'], '缩进列表')
  assert.deepEqual(fm.data.aliases, ['陛下', '陈总'], '行内列表去引号')
  assert.equal(fm.data.tier, '1')
  assert.equal(fm.errors.length, 1, '坏行要记进 errors')
  assert.equal(fm.body, '正文')
  const odd = parseFrontmatter(['---', 'tags:', '  - a', 'tags: b', '---', 'x'].join('\n'))
  assert.equal(odd.errors.length, 0, '重复键不报错（后者覆盖）')
  ok('frontmatter：拆块 / 缩进列表 / 行内列表 / 坏行 / 未闭合')
}

{
  const links = extractLinks('看 [[b/Values|价值观]] 和 ![[e-cover.png]] 以及 [[Me#身份]]')
  assert.equal(links.length, 3)
  assert.deepEqual(links[0], { embed: false, target: 'b/Values' })
  assert.equal(links[1].embed, true)
  assert.equal(links[2].target, 'Me')
  assert.equal(normalizeTarget('a\\b\\c.md'), 'a/b/c', '反斜杠归一 + 去 .md')
  ok('链接：wiki / 嵌入 / 别名 / 标题锚点 / 路径归一')
}

// ---- 扫库 / 建索引 ----
{
  const listing = listVault(vault)
  assert.equal(listing.notes.length, 4)
  assert.equal(listing.bases.length, 1)
  assert.equal(listing.attachments, 1)
  assert.equal(listing.dirs.length, 4, '4 个子目录（a/b/c/d）；.obsidian 与 .git 跳过')
  const index = buildIndex(vault)
  assert.equal(index.counts.notes, 4)
  assert.equal(index.counts.bases, 1)
  assert.equal(index.links.total, 2)
  assert.equal(index.links.broken, 1)
  assert.equal(index.links.brokenSample[0].target, '不存在')
  assert.ok(index.parseErrors.length >= 1, "坏 frontmatter 要进 parseErrors")
  const me = index.notes.find((n) => n.path === 'a/Me.md')
  assert.equal(me.title, '我')
  assert.equal(me.type, 'person')
  assert.deepEqual(me.aliases, ['陛下'])
  assert.equal(me.links.find((l) => l.target === 'b/Values').resolved, 'b/Values.md')
  ok('扫库/建索引：计数、解析、断链、笔记字段')
}

// ---- 检索打分 ----
{
  const index = buildIndex(vault)
  const terms = ['陛下']
  const me = index.notes.find((n) => n.path === 'a/Me.md')
  const values = index.notes.find((n) => n.path === 'b/Values.md')
  assert.ok(scoreNote(me, terms) > 0, "别名能命中")
  assert.equal(scoreNote(values, terms), 0)
  assert.ok(scoreNote(values, ['价值观']) > scoreNote(me, ['价值观']), '标题命中高于正文')
  const snippet = makeSnippet(me, terms)
  assert.ok(snippet.length > 0)
  ok('检索：别名 / 标题加权 / 片段')
}

// ---- 路径守卫 ----
{
  assert.equal(safeResolve(vault, 'a/Me.md'), path.join(vault, 'a', 'Me.md'))
  assert.equal(safeResolve(vault, '../outside.md'), null, '不许越界')
  assert.equal(safeResolve(vault, 'a/../../outside.md'), null)
  assert.equal(safeResolve(vault, 'C:\\Windows\\win.ini'), null, '绝对路径越界')
  assert.equal(safeResolve(vault, ''), null)
  ok('路径守卫：越界 / 绝对路径 / 空串全部拒绝')
}

// ---- 4 个工具真调用 ----
{
  const h = host(vault, store)
  assert.deepEqual([...h.defs.keys()].sort(), ['obsidian_index', 'obsidian_lint', 'obsidian_note', 'obsidian_search', 'obsidian_status', 'obsidian_write'])
  const built = await h.defs.get("obsidian_index").execute({})
  assert.equal(built.ok, true)
  assert.equal(built.notes, 4)
  assert.equal(built.brokenLinks, 1)
  assert.ok(existsSync(path.join(store, "index.json")), "索引要落盘")
  assert.ok(JSON.parse(readFileSync(path.join(store, "index.json"), "utf8")).notes.length === 4)
  const status = await h.defs.get("obsidian_status").execute({})
  assert.equal(status.ok, true)
  assert.equal(status.notes, 4)
  assert.equal(status.indexStale, false)
  const byAlias = await h.defs.get("obsidian_search").execute({ query: "陛下" })
  assert.equal(byAlias.matched, 1)
  assert.equal(byAlias.results[0].path, "a/Me.md")
  const byBody = await h.defs.get("obsidian_search").execute({ query: "删除三查" })
  assert.equal(byBody.results[0].path, "b/Values.md")
  const byType = await h.defs.get("obsidian_search").execute({ query: "2026", type: "journal" })
  assert.equal(byType.results.length, 1)
  assert.equal(byType.results[0].path, "c/2026-11-01.md")
  const note = await h.defs.get("obsidian_note").execute({ path: "a/Me.md" })
  assert.equal(note.ok, true)
  assert.equal(note.frontmatter.type, "person")
  assert.ok(note.body.includes("CHEN-QS6017"))
  const noteRendered = h.defs.get("obsidian_note").output.render({}, note).map((part) => part.text).join("")
  assert.ok(noteRendered.includes("CHEN-QS6017"), "render 必须回正文（2026-11-02 修：原实现只回字数，正文丢失）")
  assert.ok(noteRendered.includes("person"), "render 要带 frontmatter")
  assert.ok(noteRendered.includes("出链"), "render 要带出链")
  const escape = await h.defs.get("obsidian_note").execute({ path: "../outside.md" })
  assert.equal(escape.ok, false)
  const missing = await h.defs.get("obsidian_note").execute({ path: "a/Nope.md" })
  assert.equal(missing.ok, false)
  ok("工具：index / status / search（别名·正文·类型过滤）/ note（含越界与不存在）")
}

// ---- 过期与懒重建 ----
{
  const indexFile = path.join(store, "index.json")
  rmSync(indexFile, { force: true })
  const h = host(vault, store)
  const searched = await h.defs.get("obsidian_search").execute({ query: "删除三查" })
  assert.equal(searched.rebuilt, true, "索引缺失时要在内存里重建")
  assert.equal(searched.results.length, 1)
  assert.ok(existsSync(indexFile), "重建后要落盘")
  const h2 = host(vault, store)
  await h2.defs.get("obsidian_index").execute({})
  writeFileSync(path.join(vault, "b/Values.md"), readFileSync(path.join(vault, "b/Values.md"), "utf8") + "\n补一句。", "utf8")
  const stale = await h2.defs.get("obsidian_status").execute({})
  assert.equal(stale.indexStale, true, "库变了要报过期")
  ok("索引：缺失时懒重建 + 库变动报过期")
}

// ---- fail-safe：vault 不存在 ----
{
  const h = host(path.join(root, "no-such-vault"), path.join(root, "store2"))
  const status = await h.defs.get("obsidian_status").execute({})
  assert.equal(status.ok, false)
  assert.equal(status.vaultExists, false)
  assert.ok(status.lastError.length > 0)
  const searched = await h.defs.get("obsidian_search").execute({ query: "x" })
  assert.equal(searched.ok, false)
  const built = await h.defs.get("obsidian_index").execute({})
  assert.equal(built.ok, false, "vault 不在时重建要返回 ok:false，而不是抛")
  ok("fail-safe：vault 不存在时三个工具都返回 ok:false、不抛")
}

// ---- P2 受控写：纯函数 ----
{
  assert.equal(normalizeVaultPath('  .\\00-Inbox\\ai-drafts\\a '), '00-Inbox/ai-drafts/a.md')
  assert.equal(normalizeVaultPath('"00-Inbox/ai-drafts/x.md"'), '00-Inbox/ai-drafts/x.md')
  assert.equal(isWriteAllowed('00-Inbox/ai-drafts/x.md').allowed, true)
  assert.equal(isWriteAllowed('10-Life/x.md').allowed, false)
  assert.equal(isWriteAllowed('90-Shared/91-Templates/x.md').allowed, false, '模板目录受保护')
  assert.equal(isWriteAllowed('.obsidian/app.json').allowed, false)
  // 2026-11-02：Windows 路径大小写不敏感，白名单与保护区判定也必须不敏感
  assert.equal(isWriteAllowed('00-inbox/ai-drafts/x.md').allowed, true, '小写白名单前缀应放行')
  assert.equal(isWriteAllowed('00-Inbox/AI-Drafts/x.md').allowed, true, '目录段大小写混写应放行')
  assert.equal(isWriteAllowed('00-INBOX/AI-DRAFTS/x.md').allowed, true, '全大写白名单前缀应放行')
  const lowerDeny = isWriteAllowed('90-shared/91-templates/x.md')
  assert.equal(lowerDeny.allowed, false, '小写模板路径仍要拒')
  assert.match(lowerDeny.reason, /受保护/, '必须先命中保护区，而不是只靠白名单兜底')
  const upperDot = isWriteAllowed('.OBSIDIAN/app.json')
  assert.equal(upperDot.allowed, false, '.obsidian 大写也拒')
  assert.match(upperDot.reason, /受保护/)
  const body = ['# 标题', '', '## 观测', '', '- 旧', '', '## 关系', '', '- 旧关系', ''].join('\n')
  const range = sectionRange(body, '观测')
  assert.equal(range.startLine, 2)
  assert.equal(range.endLine, 6)
  assert.equal(sectionRange(body, '## 不存在'), null)
  // 2026-11-02：标题匹配容忍尾随冒号/空格（「观测：」等同「观测」）
  assert.equal(sectionRange(body, '观测：').startLine, 2, '中文冒号尾随应容忍')
  assert.equal(sectionRange(body, '观测:').startLine, 2, '英文冒号尾随应容忍')
  assert.equal(sectionRange(body, '## 观测： ').startLine, 2, '## 前缀 + 冒号 + 空格都应容忍')
  assert.equal(sectionRange(body, '  观测  ').startLine, 2, '首尾空格应容忍')
  assert.equal(sectionRange(body, '：'), null, '只有冒号不能命中任何标题')
  const next = applySection(body, '观测', '- 新\n- 又一条')
  assert.ok(next.includes('- 新'))
  assert.ok(!next.split('\n').includes('- 旧'), '旧段落被替换')
  assert.ok(next.includes('## 关系'), '同级后面的段落保留')
  assert.equal(applySection(body, '没有这个标题', 'x'), null)
  assert.equal(sha256('abc'), sha256('abc'))
  assert.notEqual(sha256('abc'), sha256('abd'))
  assert.deepEqual(parseMemoryPointers('见 vault://10-Life/13-Life-Plan.md 和 vault://20-Learning/x.md。'), ['10-Life/13-Life-Plan.md', '20-Learning/x.md'])
  assert.deepEqual(parseMemoryPointers('没有指针'), [])
  ok('受控写纯函数：路径归一 / 白名单 / section 定位与替换 / 哈希 / 指针解析')
}

// ---- P2 受控写：工具真调用 ----
{
  const memFile = path.join(root, "memory.json")
  writeFileSync(memFile, JSON.stringify({ entries: [
    { id: 'm1', text: '细节见 vault://00-Inbox/ai-drafts/ok.md' },
    { id: 'm2', text: '断的 vault://99-Gone/x.md' },
    { id: 'm3', text: '带锚点 vault://00-Inbox/ai-drafts/ok.md#一句话' },
  ] }), 'utf8')
  const h = host(vault, store, { memoryPath: memFile })
  const write = h.defs.get("obsidian_write")

  // 2026-11-02：文档带 `## 一句话` 标题，好让下面 m3 的 `#一句话` 锚点真的存在（锚点校验上线后才有意义）
  const created = await write.execute({ path: "00-Inbox/ai-drafts/ok", content: '---\nreview: pending\n---\n# 草稿\n\n## 一句话\n\n> 一句话：草稿。\n' })
  assert.equal(created.ok, true)
  assert.equal(created.created, true)
  assert.equal(created.path, '00-Inbox/ai-drafts/ok.md')
  assert.ok(existsSync(path.join(vault, '00-Inbox/ai-drafts/ok.md')))

  const again = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: 'x' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'FILE_EXISTS', 'create 绝不覆盖')

  const appended = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: '追加行', mode: 'append' })
  assert.equal(appended.ok, true)
  assert.ok(readFileSync(path.join(vault, '00-Inbox/ai-drafts/ok.md'), 'utf8').includes('追加行'))

  const missingSection = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: '- 新观测', mode: 'section', section: '观测' })
  assert.equal(missingSection.ok, false)
  assert.equal(missingSection.code, 'SECTION_NOT_FOUND')

  await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: '# 卡\n\n## 观测\n\n- 旧观测\n\n## 关系\n\n- 旧关系\n' })
  const replaced = await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: '- 新观测', mode: 'section', section: '观测' })
  assert.equal(replaced.ok, true)
  const secBody = readFileSync(path.join(vault, '00-Inbox/ai-drafts/sec.md'), 'utf8')
  assert.ok(secBody.includes('- 新观测'), '新内容写入')
  assert.ok(!secBody.split('\n').includes('- 旧观测'), '旧段落被替换')
  assert.ok(secBody.includes('## 关系'), '同级段保留')

  const denied = await write.execute({ path: "10-Life/Me.md", content: 'x' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'DENIED')

  const template = await write.execute({ path: "90-Shared/91-Templates/person.md", content: 'x' })
  assert.equal(template.ok, false)
  assert.equal(template.code, 'DENIED')

  // 2026-11-02：白名单/保护区大小写不敏感（工具级）
  const lowerInbox = await write.execute({ path: "00-inbox/AI-Drafts/case.md", content: '# 大小写草稿\n' })
  assert.equal(lowerInbox.ok, true, '00-inbox/AI-Drafts 应被写入白名单接受')
  assert.ok(existsSync(path.join(vault, lowerInbox.path)), '文件要真的落盘')
  const upperDeny = await write.execute({ path: "90-SHARED/91-TEMPLATES/case.md", content: 'x' })
  assert.equal(upperDeny.ok, false, '大写模板目录仍要拒')
  assert.equal(upperDeny.code, 'DENIED')

  // 2026-11-02：section 标题容忍尾随冒号（工具级）
  const colonSection = await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: '- 冒号观测', mode: 'section', section: '观测：' })
  assert.equal(colonSection.ok, true, '「观测：」应命中「## 观测」')
  assert.ok(readFileSync(path.join(vault, '00-Inbox/ai-drafts/sec.md'), 'utf8').includes('- 冒号观测'))

  const escape = await write.execute({ path: "../outside.md", content: 'x' })
  assert.equal(escape.ok, false)
  assert.equal(escape.code, 'ESCAPE')

  const conflict = await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: 'x', mode: 'append', expectedHash: 'deadbeef' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'CONFLICT')

  const st = await h.defs.get("obsidian_status").execute({})
  assert.equal(st.ok, true)
  assert.equal(st.memoryPointers.checked, true)
  assert.equal(st.memoryPointers.total, 3, '带锚点的指针算一条，且不因 # 被判断链')
  assert.equal(st.memoryPointers.broken.length, 1, '断指针要报出来')
  assert.equal(st.memoryPointers.broken[0].pointer, '99-Gone/x.md')

  // render 必须把指针断链直接显示出来：不然工具算对了人也看不见（2026-11-01 实测缺口）
  const rendered = h.defs.get("obsidian_status").output.render({}, st).map((part) => part.text).join('')
  assert.ok(rendered.includes('记忆指针 3 条（断 1）'), 'render 要直接显示指针总数与断链数')
  assert.ok(rendered.includes('99-Gone/x.md'), '断链要点名到具体指针')

  ok("工具：write 新建/拒覆盖/追加/section 替换/白名单/模板/越界/冲突 + status 指针漂移 + render 断链可见")
}

// ---- 任务1 锚点校验：带 #锚点 的指针必须同时校验「文件存在」和「锚点存在」（2026-11-02） ----
{
  const root3 = mkdtempSync(path.join(os.tmpdir(), 'dsh-obsidian-anchor-'))
  const v3 = path.join(root3, 'vault')
  const store3 = path.join(root3, 'store')
  const put3 = (rel, body) => {
    const abs = path.join(v3, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  put3('30-Build/plugin-dev-runbook.md', [
    '---', 'type: runbook', 'domain: build', 'status: active', '---',
    '# 插件开发 runbook', '',
    '## 更新插件的执行链', '',
    '> 一句话：执行链。', '',
    '## 2. 环境版本（怎么现查）', '',
    '## 3.2 记忆清理红线', '',
    '## skill-forge 的接线位置', '',
    '## 先查官方有没有，再自研', '',
  ].join('\n'))
  put3('10-Life/values.md', ['---', 'type: values', 'domain: life', 'status: active', '---', '# 价值观', '', '## 硬规则', '', '## 取舍标准', ''].join('\n'))

  // slug 规则 = github-slugger 2.0.0（ISC）的实测输出，这里只固化期望值，运行时不依赖它
  assert.equal(slugifyHeading('硬规则'), '硬规则')
  assert.equal(slugifyHeading('3.2 记忆清理红线'), '32-记忆清理红线', '数字节号的点被去掉、空格转连字符')
  assert.equal(slugifyHeading('skill-forge 的接线位置'), 'skill-forge-的接线位置')
  assert.equal(slugifyHeading('安装 / 卸载台账流程'), '安装--卸载台账流程', '与 github-slugger 一致：不塌缩连续连字符')
  assert.equal(slugifyHeading('C++ & Rust'), 'c--rust')
  assert.equal(slugifyHeading('What is love?'), 'what-is-love')
  assert.equal(slugifyHeading('Release v1.0.0'), 'release-v100')
  assert.equal(slugifyHeading('   '), '', '空标题 slug 为空')

  const heads = headingAnchors(readFileSync(path.join(v3, '30-Build/plugin-dev-runbook.md'), 'utf8'))
  assert.deepEqual(heads.map((h) => h.text), ['插件开发 runbook', '更新插件的执行链', '2. 环境版本（怎么现查）', '3.2 记忆清理红线', 'skill-forge 的接线位置', '先查官方有没有，再自研'], '只认正文标题，frontmatter 不算')
  assert.equal(heads[3].number, '3.2')
  assert.equal(heads[2].number, '2', '数字节号取标题前导节号，去掉尾随点')
  assert.equal(heads[1].number, '')

  // 三条匹配规则：① slug 全等 ② 数字节号 = 标题前导节号 ③ 短锚 = slug 的整词前缀
  assert.deepEqual(matchHeadingAnchor('更新插件的执行链', heads), { ok: true, by: 'slug' }, 'slug 全等')
  const valuesHeads = headingAnchors(readFileSync(path.join(v3, '10-Life/values.md'), 'utf8'))
  assert.deepEqual(matchHeadingAnchor('硬规则', valuesHeads), { ok: true, by: 'slug' }, '中文标题 slug = 原文')
  assert.deepEqual(matchHeadingAnchor('3.2', heads), { ok: true, by: 'section-number' })
  assert.deepEqual(matchHeadingAnchor('2', heads), { ok: true, by: 'section-number' })
  assert.deepEqual(matchHeadingAnchor('skill-forge', heads), { ok: true, by: 'slug-prefix' })
  assert.deepEqual(matchHeadingAnchor('skill', heads), { ok: true, by: 'slug-prefix' }, '整词前缀：skill 是 skill-forge 的第一整词')
  assert.deepEqual(matchHeadingAnchor('skill-fo', heads), { ok: false, by: '' }, '半个词不算（区别于裸 startsWith）')
  assert.deepEqual(matchHeadingAnchor('skill-forge-的接线', heads), { ok: false, by: '' }, '半个词结尾不算')
  assert.deepEqual(matchHeadingAnchor('9.9', heads), { ok: false, by: '' }, '库里没有 9.9 这节')
  assert.deepEqual(matchHeadingAnchor('记忆清理', heads), { ok: false, by: '' }, '中文短锚不做「任意位置包含」')
  // 中文标题带逗号（真实库里就有一条：先查官方有没有，再自研）：整标题能对上，前导片段也能对上
  assert.deepEqual(matchHeadingAnchor('先查官方有没有，再自研', heads), { ok: true, by: 'slug' }, '整标题（含逗号）按 slug 全等')
  assert.deepEqual(matchHeadingAnchor('先查官方有没有', heads), { ok: true, by: 'slug-prefix' }, '指针解析在「，」处断开，剩下的前导片段仍要能对上')
  assert.deepEqual(matchHeadingAnchor('官方有没有', heads), { ok: false, by: '' }, '不是前导片段（半截）')
  assert.deepEqual(matchHeadingAnchor('先查官', heads), { ok: false, by: '' }, '半个词（未在标点处断开）不算')
  assert.deepEqual(matchHeadingAnchor('', heads), { ok: false, by: '' })

  const mem3 = path.join(root3, 'memory.json')
  writeFileSync(mem3, JSON.stringify({ entries: [
    { id: 'm1', text: '指针 vault://30-Build/plugin-dev-runbook.md#2' },
    { id: 'm2', text: '指针 vault://10-Life/values.md#硬规则' },
    { id: 'm3', text: '指针 vault://30-Build/plugin-dev-runbook.md#skill-forge' },
    { id: 'm4', text: '指针 vault://10-Life/nope.md#硬规则' },
    { id: 'm5', text: '指针 vault://10-Life/values.md#没有这个锚点' },
    { id: 'm6', text: '指针 vault://10-Life/values.md#3.2' },
    { id: 'm7', text: '指针 vault://30-Build/plugin-dev-runbook.md#先查官方有没有，再自研' },
  ] }), 'utf8')
  const h3 = host(v3, store3, { memoryPath: mem3 })
  assert.equal((await h3.defs.get('obsidian_index').execute({})).ok, true, '先建索引，status 才有缓存可读')
  const st3 = await h3.defs.get('obsidian_status').execute({})
  const ptr3 = st3.memoryPointers
  assert.equal(ptr3.checked, true)
  assert.equal(ptr3.total, 7, 'm7 带「，」的指针解析后在逗号处断开，仍是同一个文件+锚点')
  assert.equal(ptr3.broken.length, 3, 'm4 文件缺失 / m5 锚点缺失 / m6 数字节号在本文件不存在')
  const byPtr = new Map(ptr3.broken.map((item) => [item.pointer, item]))
  assert.equal(byPtr.get('10-Life/nope.md#硬规则').kind, 'file-missing', '文件缺失照旧报（不回归）')
  assert.equal(byPtr.get('10-Life/values.md#没有这个锚点').kind, 'anchor-missing', '文件在、锚点不在 必须报')
  assert.equal(byPtr.get('10-Life/values.md#3.2').kind, 'anchor-missing', '节号在别的文件存在，本文件不存在也要报')
  assert.deepEqual(byPtr.get('10-Life/values.md#没有这个锚点').memoryIds, ['m5'], '向后兼容字段保留')
  assert.equal(ptr3.anchorChecked, 6, 'm1/m2/m3/m5/m6/m7 共 6 条带锚点')
  assert.ok(!ptr3.broken.some((item) => item.pointer.includes('先查官方有没有')), '带逗号的真实写法要能解析，不能误报')
  const rendered3 = h3.defs.get('obsidian_status').output.render({}, st3).map((part) => part.text).join('')
  assert.ok(rendered3.includes('没有这个锚点'), 'render 要点名锚点缺失的指针')
  assert.ok(rendered3.includes('锚点缺失'), 'render 要标出问题是锚点，不是文件')
  rmSync(root3, { recursive: true, force: true })
  ok('锚点校验：slug 全等 / 数字节号 / 整词前缀 / 文件缺失与锚点缺失分 kind 报出')
}

// ---- 任务2 lint 误报：`> 一句话：` 与 `> **一句话**：` 都要算过（2026-11-02） ----
{
  const root4 = mkdtempSync(path.join(os.tmpdir(), 'dsh-obsidian-oneliner-'))
  const v4 = path.join(root4, 'vault')
  const put4 = (rel, body) => {
    const abs = path.join(v4, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  const fm4 = ['---', 'type: note', 'domain: build', 'status: active', '---'].join('\n')
  put4('a/plain.md', fm4 + '\n# 朴素\n\n> 一句话：朴素写法要过。\n')
  put4('a/bold.md', fm4 + '\n# 加粗\n\n> **一句话**：加粗写法要过。\n')
  put4('a/underscore.md', fm4 + '\n# 下划线\n\n> __一句话__：下划线加粗也要过。\n')
  put4('a/halfwidth.md', fm4 + '\n# 半角冒号\n\n> **一句话**: 半角冒号也要过。\n')
  put4('a/none.md', fm4 + '\n# 没结论头\n\n正文直接开始，没有结论头。\n')
  put4('a/heading-only.md', fm4 + '\n# 只有标题\n\n## 5. 一句话结论\n\n正文不写结论头。\n')
  put4('a/prose.md', fm4 + '\n# 正文提到\n\n这里提到一句话，但不是结论头。\n')
  put4('a/code.md', fm4 + '\n# 代码块里的不算\n\n```text\n一句话：这是代码块里的示例\n```\n\n正文没有结论头。\n')
  const rep4 = lintIndex(buildIndex(v4), {})
  const warned4 = rep4.issues.filter((issue) => issue.code === 'missing_one_liner').map((issue) => issue.path).sort()
  assert.deepEqual(warned4, ['a/code.md', 'a/heading-only.md', 'a/none.md', 'a/prose.md'], '四种同义写法都要过；真缺结论头（含代码块里出现）仍要报')
  assert.equal(rep4.errorCount, 0)
  assert.equal(hasOneLiner('> 一句话：x'), true)
  assert.equal(hasOneLiner('> **一句话**：x'), true)
  assert.equal(hasOneLiner('> __一句话__：x'), true)
  assert.equal(hasOneLiner('> **一句话**: x'), true)
  assert.equal(hasOneLiner('## 5. 一句话结论'), false)
  assert.equal(hasOneLiner('这里提到一句话，但不是结论头'), false)
  assert.equal(hasOneLiner(''), false)
  rmSync(root4, { recursive: true, force: true })
  ok('一句话结论头：`> 一句话：` / `> **…**：` / `> __…__：` / 半角冒号都算过，真缺仍报')
}
// ---- 页面契约检查（lint） ----
{
  const root2 = mkdtempSync(path.join(os.tmpdir(), "dsh-obsidian-lint-"))
  const v2 = path.join(root2, "vault")
  const put2 = (rel, body) => {
    const abs = path.join(v2, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  put2('a/good.md', '---\ntype: note\ndomain: life\nstatus: active\nid: good\n---\n# 好卡\n\n> **一句话**：合格。\n')
  put2('a/missing.md', '---\ntype: note\n---\n# 缺字段\n\n> **一句话**：缺 domain 与 status。\n')
  put2('a/_index.md', '---\ntype: note\ndomain: life\nstatus: active\n---\n# 命名冲突\n\n> **一句话**：内容页占了导航名。\n')
  put2('a/dup1.md', '---\ntype: note\ndomain: life\nstatus: active\nid: same\n---\n# 一\n\n> **一句话**：一。\n')
  put2('a/dup2.md', '---\ntype: note\ndomain: life\nstatus: active\nid: same\n---\n# 二\n\n> **一句话**：二。\n')
  put2('a/draft.md', '---\ntype: note\ndomain: life\nstatus: draft\nid: draft\n---\n# 草稿\n\n> **一句话**：草稿。\n')
  put2('a/day.md', '---\ntype: journal\ndomain: life\nstatus: active\n---\n# 日志\n\n今天干了什么。\n')
  put2('Home.md', '---\ntype: index\ndomain: shared\nstatus: active\n---\n# 总览\n')
  put2('90-Shared/91-Templates/t.md', '---\n---\n# 模板\n')

  const report = lintIndex(buildIndex(v2), { pointerTargets: new Set(['a/draft.md']) })
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('missing_field'), '缺 domain/status 要报')
  assert.ok(codes.includes('index_named_content'), '_index.md 装内容页要报')
  assert.ok(codes.includes('duplicate_id'), '重复 id 要报')
  assert.ok(codes.includes('pointer_to_inactive'), '指针指到草稿要报')
  assert.ok(!report.issues.some((issue) => issue.path === 'a/good.md'), '合格页不该被报')
  assert.ok(!report.issues.some((issue) => issue.path.includes('91-Templates')), '模板默认跳过')
  assert.ok(!report.issues.some((issue) => issue.path === 'a/day.md'), 'journal 免检一句话')
  assert.ok(!report.issues.some((issue) => issue.path === 'Home.md'), '根级导航页豁免命名检查')
  assert.ok(report.errorCount >= 3 && report.warnCount >= 1)
  rmSync(root2, { recursive: true, force: true })
  ok('lint 纯函数：缺字段 / 命名冲突 / 重复 id / 指针指草稿 / 模板跳过')
}

// ---- lint 工具真调用 ----
{
  const h = host(vault, store)
  const linted = await h.defs.get("obsidian_lint").execute({})
  assert.equal(linted.ok, true)
  assert.ok(linted.total >= 4)
  assert.ok(linted.errorCount >= 1, '夹具缺 domain/status，应当报出来')
  assert.ok(linted.issues.some((issue) => issue.code === 'missing_field'))
  assert.ok(linted.tookMs >= 0)
  ok('lint 工具：真实扫库返回结构化清单')
}

rmSync(root, { recursive: true, force: true })
console.log("obsidian: " + passed + " 项通过")
