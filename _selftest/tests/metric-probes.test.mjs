// metric-probes.test.mjs — 度量探针与 system-health 的同口径保证
// 判据：探针自己算得对；system-health 打印的数字必须与探针一致（两处实现 = 两套口径，这是病根）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
// 跨仓引用用绝对 file URL（D:/AI 与 D:/AI-date 不同分支，相对路径够不着）；env 可覆盖。
const PROBES_URL = process.env.DSH_PROBES || 'file:///D:/AI-date/dsh-date/dsh-创建/_ops/metric-probes.mjs'
const { probeMemory, probeRules, probeVaultIndex } = await import(PROBES_URL)

// 注意：metric-probes.mjs 在工作区 _ops 下；插件仓测试用相对路径引用本机工作区（同一台机器）。
const WS = 'D:/AI-date/dsh-date/dsh-创建'
let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix))

{
  const dir = tmp('probe-rules-')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'a.md'), '---\nid: a\nalways: true\n---\n' + 'x'.repeat(10))
  writeFileSync(path.join(dir, 'b.md'), '---\nid: b\nalways: false\n---\n' + 'y'.repeat(20))
  writeFileSync(path.join(dir, 'c.md'), 'no frontmatter here')
  const r = probeRules(dir)
  assert.equal(r.files.length, 3)
  assert.equal(r.alwaysChars, 10, '只有 always:true 的正文计入')
  assert.deepEqual(r.missingFrontmatter, ['c.md'])
  assert.equal(r.sizes.length, 2)
  ok('probeRules：always 预算/缺 frontmatter')
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = tmp('probe-mem-')
  const file = path.join(dir, 'memory.json')
  writeFileSync(file, JSON.stringify({ entries: [{ text: 'abc' }, { text: 'de', pinned: true }, { text: '' }] }))
  const m = probeMemory(file)
  assert.equal(m.entries, 3)
  assert.equal(m.used, 5)
  assert.equal(m.pinned, 1)
  assert.throws(() => probeMemory(path.join(dir, 'missing.json')), /不存在/, '缺文件必须抛错而不是静默 0')
  ok('probeMemory：字符数/条目/pinned + fail-loud')
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = tmp('probe-vault-')
  const file = path.join(dir, 'index.json')
  writeFileSync(file, JSON.stringify({ counts: { notes: 3 }, links: { total: 4, broken: 1 }, parseErrors: [{ file: 'x' }] }))
  const v = probeVaultIndex(file)
  assert.deepEqual(v, { notes: 3, links: 4, broken: 1, parseErrors: 1 })
  ok('probeVaultIndex：卡片/链接/断链/解析错')
  rmSync(dir, { recursive: true, force: true })
}

{
  // 同口径保证：system-health 的输出数字 == 探针现算
  const r = spawnSync(process.execPath, [path.join(WS, '_ops', 'system-health.mjs')], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const mAlways = out.match(/always 正文预算\s+(\d+)/)
  const mMem = out.match(/记忆存储字符\s+(\d+)/)
  assert.ok(mAlways, 'system-health 应打印 always 预算')
  assert.ok(mMem, 'system-health 应打印记忆存储')
  assert.equal(Number(mAlways[1]), probeRules().alwaysChars, '规则预算两处必须一致')
  assert.equal(Number(mMem[1]), probeMemory().used, '记忆字符两处必须一致')
  ok('system-health 与探针同口径（无第二份实现）')
}

{
  // v4.2：dsh-obsidian 的 readMemoryEntries 是「与探针同语义的复制实现」（跨仓 import 不现实），
  // 这份夹具把两边输出钉在一起——否则「两套口径」迟早漂（2026-11-02 独立复核要求补的）。
  const { readMemoryEntries: readProbeEntries } = await import(PROBES_URL)
  const { readMemoryEntries: readObsidianEntries } = await import('../../dsh-obsidian/index.js')
  const dir = tmp('probe-cross-')
  const memFile = path.join(dir, 'memory.json')
  writeFileSync(memFile, JSON.stringify({ entries: [{ id: 'j1', text: 'json 旧快照' }] }))
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(path.join(dir, 'memory.db'))
  db.exec('CREATE TABLE entries (seq INTEGER NOT NULL, payload TEXT NOT NULL)')
  const ins = db.prepare('INSERT INTO entries (seq, payload) VALUES (?, ?)')
  ins.run(1, JSON.stringify({ id: 'd1', text: 'db 条目一' }))
  ins.run(2, JSON.stringify({ id: 'd2', text: 'db 条目二' }))
  ins.run(3, '{bad json')
  db.close()
  const probeSide = readProbeEntries(memFile)
  const obsSide = readObsidianEntries(memFile)
  assert.equal(obsSide.source, 'sqlite', '同目录有 DB 时必须读 DB')
  assert.equal(probeSide.length, 2, '探针侧坏 payload 跳过')
  assert.equal(obsSide.entries.length, 2, 'obsidian 侧坏 payload 跳过')
  assert.deepEqual(obsSide.entries.map((entry) => entry.id), probeSide.map((entry) => entry.id), '两边按 seq 读出的条目必须一致')
  rmSync(dir, { recursive: true, force: true })
  ok('dsh-obsidian readMemoryEntries 与 metric-probes 同口径（同一夹具/同一 DB 输出一致）')
}

console.log('metric-probes: ' + passed + ' 组通过')
