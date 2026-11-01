import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  applySection,
  buildIndex,
  extractLinks,
  isWriteAllowed,
  listVault,
  makeSnippet,
  normalizeTarget,
  normalizeVaultPath,
  parseFrontmatter,
  parseMemoryPointers,
  safeResolve,
  scoreNote,
  sectionRange,
  sha256,
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
  assert.deepEqual([...h.defs.keys()].sort(), ['obsidian_index', 'obsidian_note', 'obsidian_search', 'obsidian_status', 'obsidian_write'])
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
  const body = ['# 标题', '', '## 观测', '', '- 旧', '', '## 关系', '', '- 旧关系', ''].join('\n')
  const range = sectionRange(body, '观测')
  assert.equal(range.startLine, 2)
  assert.equal(range.endLine, 6)
  assert.equal(sectionRange(body, '## 不存在'), null)
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
  ] }), 'utf8')
  const h = host(vault, store, { memoryPath: memFile })
  const write = h.defs.get("obsidian_write")

  const created = await write.execute({ path: "00-Inbox/ai-drafts/ok", content: '---\nreview: pending\n---\n# 草稿\n' })
  assert.equal(created.ok, true)
  assert.equal(created.created, true)
  assert.equal(created.path, '00-Inbox/ai-drafts/ok.md')
  assert.ok(existsSync(path.join(vault, '00-Inbox/ai-drafts/ok.md')))

  const again = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: 'x' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'file_exists', 'create 绝不覆盖')

  const appended = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: '追加行', mode: 'append' })
  assert.equal(appended.ok, true)
  assert.ok(readFileSync(path.join(vault, '00-Inbox/ai-drafts/ok.md'), 'utf8').includes('追加行'))

  const missingSection = await write.execute({ path: "00-Inbox/ai-drafts/ok.md", content: '- 新观测', mode: 'section', section: '观测' })
  assert.equal(missingSection.ok, false)
  assert.equal(missingSection.code, 'section_not_found')

  await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: '# 卡\n\n## 观测\n\n- 旧观测\n\n## 关系\n\n- 旧关系\n' })
  const replaced = await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: '- 新观测', mode: 'section', section: '观测' })
  assert.equal(replaced.ok, true)
  const secBody = readFileSync(path.join(vault, '00-Inbox/ai-drafts/sec.md'), 'utf8')
  assert.ok(secBody.includes('- 新观测'), '新内容写入')
  assert.ok(!secBody.split('\n').includes('- 旧观测'), '旧段落被替换')
  assert.ok(secBody.includes('## 关系'), '同级段保留')

  const denied = await write.execute({ path: "10-Life/Me.md", content: 'x' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'denied')

  const template = await write.execute({ path: "90-Shared/91-Templates/person.md", content: 'x' })
  assert.equal(template.ok, false)
  assert.equal(template.code, 'denied')

  const escape = await write.execute({ path: "../outside.md", content: 'x' })
  assert.equal(escape.ok, false)
  assert.equal(escape.code, 'escape')

  const conflict = await write.execute({ path: "00-Inbox/ai-drafts/sec.md", content: 'x', mode: 'append', expectedHash: 'deadbeef' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'conflict')

  const st = await h.defs.get("obsidian_status").execute({})
  assert.equal(st.ok, true)
  assert.equal(st.memoryPointers.checked, true)
  assert.equal(st.memoryPointers.total, 2)
  assert.equal(st.memoryPointers.broken.length, 1, '断指针要报出来')
  assert.equal(st.memoryPointers.broken[0].pointer, '99-Gone/x.md')

  ok("工具：write 新建/拒覆盖/追加/section 替换/白名单/模板/越界/冲突 + status 指针漂移")
}

rmSync(root, { recursive: true, force: true })
console.log("obsidian: " + passed + " 项通过")
