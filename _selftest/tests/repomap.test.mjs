import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, createScanCache, extractSymbols, extractSymbolsDetailed } from '../../dsh-repomap/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---------- 符号抽取（不依赖缓存） ----------

const js = ['export function alpha() {}', 'const beta = (x) => x', 'export class Gamma {}', 'export interface Delta {}'].join('\n')
const jsNames = extractSymbols('.ts', js).map((symbol) => symbol.name).join(',')
assert.equal(jsNames, 'alpha,beta,Gamma,Delta')
ok('JS/TS 符号抽取顺序正确')

assert.equal(extractSymbols('.ts', js)[0].line, 1)
ok('行号从 1 开始')

const py = ['class Alpha:', '    def beta(self):', '        pass', '', 'def gamma():'].join('\n')
assert.equal(extractSymbols('.py', py).map((symbol) => symbol.name).join(','), 'Alpha,beta,gamma')
ok('Python 符号抽取')

assert.equal(extractSymbols('.go', 'package main\nfunc helper() {}').map((symbol) => symbol.name).join(','), 'helper')
ok('Go 符号抽取')

assert.equal(extractSymbols('.txt', 'function nope() {}').length, 0)
ok('不支持的扩展名不产出符号')

// 打包器 interop 噪音必须被过滤
const bundled = 'function __export() {}\nfunction __toESM() {}\nexport function real() {}'
assert.equal(extractSymbols('.js', bundled).map((symbol) => symbol.name).join(','), 'real')
ok('打包器辅助函数被过滤')

// ---------- 扫描缓存：命中 / 失效 / LRU ----------

// 本机约定插件数据不落 C 盘：优先用 D:\AI\dsh-data\tmp 做临时夹具，其他环境退回系统临时目录
const preferredTmp = 'D:\\AI\\dsh-data\\tmp'
const tmpBase = existsSync(path.dirname(preferredTmp)) ? preferredTmp : os.tmpdir()
mkdirSync(tmpBase, { recursive: true })
const fixture = mkdtempSync(path.join(tmpBase, 'repomap-test-'))

const writeSource = (rel, content) => {
  const full = path.join(fixture, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

try {
  writeSource('src/alpha.js', 'export function alpha() {}\n')
  writeSource('src/beta.py', 'def beta():\n    pass\n')

  const scanner = createScanCache()
  const first = scanner.scan(fixture)
  assert.equal(first.state.files, 2)
  assert.deepEqual(scanner.stats(), { hits: 0, misses: 1, size: 1 })
  ok('首次扫描：未命中，扫描 2 个源文件')

  const second = scanner.scan(fixture)
  assert.equal(scanner.stats().hits, 1)
  assert.equal(second, first, '命中缓存应返回同一个结果对象，而不是又读了一遍文件')
  ok('工作目录与文件指纹都没变：第二次调用命中缓存')

  // 同长度内容 + 显式改 mtime：size 不变也必须失效
  const betaPath = path.join(fixture, 'src', 'beta.py')
  writeSource('src/beta.py', 'def zeta():\n    pass\n')
  const bumped = new Date(Date.now() + 5000)
  utimesSync(betaPath, bumped, bumped)
  const third = scanner.scan(fixture)
  assert.equal(scanner.stats().misses, 2)
  assert.notEqual(third, first)
  const zetaFile = third.files.find((file) => file.rel.endsWith('beta.py'))
  assert.ok(zetaFile.symbols.some((symbol) => symbol.name === 'zeta'))
  assert.ok(!zetaFile.symbols.some((symbol) => symbol.name === 'beta'))
  ok('文件指纹（mtime/size）一变就失效，改完立刻读到新符号')

  // 新增文件也是指纹变化
  writeSource('src/delta.js', 'export function delta() {}\n')
  const fourth = scanner.scan(fixture)
  assert.equal(scanner.stats().misses, 3)
  assert.equal(fourth.state.files, 3)
  assert.ok(fourth.files.some((file) => file.rel.endsWith('delta.js')))
  ok('新增源文件：缓存失效并纳入扫描')

  // 删除文件同样是指纹变化（用一个新缓存实例，避免"删回旧指纹后命中旧快照"干扰本次断言）
  const deletionScanner = createScanCache()
  const beforeDelete = deletionScanner.scan(fixture)
  assert.equal(beforeDelete.state.files, 3)
  rmSync(path.join(fixture, 'src', 'delta.js'))
  const afterDelete = deletionScanner.scan(fixture)
  assert.equal(deletionScanner.stats().misses, 2)
  assert.equal(afterDelete.state.files, 2)
  assert.ok(!afterDelete.files.some((file) => file.rel.endsWith('delta.js')))
  ok('删除源文件：指纹变化触发重扫，结果同步移除')

  // key 含工作目录：两份内容相同的目录互不串用
  writeSource('twin-a/same.js', 'export function shared() {}\n')
  writeSource('twin-b/same.js', 'export function shared() {}\n')
  const twinScanner = createScanCache()
  twinScanner.scan(path.join(fixture, 'twin-a'))
  twinScanner.scan(path.join(fixture, 'twin-b'))
  assert.deepEqual(twinScanner.stats(), { hits: 0, misses: 2, size: 2 })
  twinScanner.scan(path.join(fixture, 'twin-a'))
  assert.equal(twinScanner.stats().hits, 1)
  ok('缓存 key 含工作目录：内容相同的不同目录各算各的')

  // LRU：maxCacheEntries=2 时第三个目录会淘汰最久没用的那个
  const lruDirs = ['a', 'b', 'c'].map((name) => {
    const dir = path.join(fixture, 'lru', name)
    mkdirSync(dir, { recursive: true })
    return dir
  })
  const lru = createScanCache({ maxCacheEntries: 2 })
  for (const dir of lruDirs) lru.scan(dir)
  assert.equal(lru.stats().size, 2)
  const missesBefore = lru.stats().misses
  lru.scan(lruDirs[0])
  assert.equal(lru.stats().misses, missesBefore + 1)
  assert.equal(lru.stats().size, 2)
  ok('maxCacheEntries 生效：超出上限按 LRU 淘汰（默认 8）')

  // ---------- 工具层真实调用：缓存必须随文件变化刷新 ----------

  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
    effect(callback) {
      callback()
      return () => {}
    },
    get() {
      return undefined
    },
  }
  apply(ctx, {})

  const repoMap = registered.get('repo_map')
  assert.ok(repoMap && typeof repoMap.execute === 'function')
  const mapBefore = await repoMap.execute({ path: fixture }, {})
  assert.ok(mapBefore.entries.some((entry) => entry.path.endsWith('alpha.js')))
  assert.ok(!mapBefore.entries.some((entry) => entry.path.endsWith('epsilon.js')))
  writeSource('src/epsilon.js', 'export function epsilon() {}\n')
  const mapAfter = await repoMap.execute({ path: fixture }, {})
  assert.ok(mapAfter.entries.some((entry) => entry.path.endsWith('epsilon.js')))
  ok('repo_map 真实调用：文件变化后缓存自动失效（不返回陈旧结果）')

  const repoOutline = registered.get('repo_outline')
  assert.ok(repoOutline && typeof repoOutline.execute === 'function')
  const alphaPath = path.join(fixture, 'src', 'alpha.js')
  const outlineBefore = await repoOutline.execute({ path: alphaPath }, {})
  writeSource('src/alpha.js', 'export function alpha() {}\nexport function omega() {}\n')
  const outlineAfter = await repoOutline.execute({ path: alphaPath }, {})
  assert.deepEqual(outlineBefore.symbols.map((symbol) => symbol.name), ['alpha'])
  assert.deepEqual(outlineAfter.symbols.map((symbol) => symbol.name), ['alpha', 'omega'])
  ok('repo_outline 单文件缓存：文件改动后立刻失效')

  // ---------- 2026-11-02 新增（报告 #50）：跳过 / 截断必须明示，不许静默失真 ----------
  {
    writeSource('src/huge.js', 'export function hugeOne() {}\n// ' + 'x'.repeat(520 * 1024) + '\n')
    const manyFunctions = Array.from({ length: 70 }, (_, index) => `export function fn${index}() {}`).join('\n')
    writeSource('src/many.js', manyFunctions)

    const detailed = extractSymbolsDetailed('.js', manyFunctions)
    assert.equal(detailed.symbols.length, 60, '单文件符号上限 60（原有行为不变）')
    assert.equal(detailed.truncated, 10, '被截掉的符号数必须如实报出（原实现是静默 slice(0,60)）')
    assert.equal(extractSymbols('.js', manyFunctions).length, 60, 'extractSymbols 兼容旧签名，仍返回符号数组')

    const map = await repoMap.execute({ path: fixture }, {})
    assert.ok(map.skippedLarge >= 1, `>512KB 文件必须计入 skippedLarge，实际 ${map.skippedLarge}`)
    assert.ok(map.truncatedSymbols >= 10, `70 符号文件必须计入 truncatedSymbols，实际 ${map.truncatedSymbols}`)
    assert.ok(map.block.includes('已跳过'), `地图正文必须明示已跳过，实际：${map.block.slice(0, 300)}`)
    assert.ok(map.block.includes('512'), '跳过原因要写清阈值（>512KB）')
    assert.ok(map.block.includes('已截断'), '符号超上限必须明示已截断')
    const rendered = repoMap.output.render({}, map)[0].text
    assert.ok(
      rendered.includes('已跳过') && rendered.includes('已截断'),
      `render 顶部也必须明示跳过/截断，实际：${rendered.slice(0, 220)}`,
    )
    ok('repo_map：超大文件跳过与符号截断都带明示标记（不再静默失真）')
  }
  // ---------- B6（2026-11-03 审计 M7）：默认根不再落到插件进程 cwd ----------
  {
    const makeCtx = (service) => {
      const registered = new Map()
      const ctx = {
        tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
        effect: (fn) => fn(),
        get: (name) => (name === 'workingDirectory' ? service : undefined),
      }
      return { ctx, tool: (toolName) => registered.get(toolName) }
    }
    // 1) 会话工作目录可用 → 默认根就是它
    {
      const h = makeCtx({ ensure: async () => fixture })
      apply(h.ctx, {})
      const status = await h.tool('repo_status').execute({}, { agent: { session: 's1' } })
      assert.equal(status.root, fixture, '默认根应为会话工作目录')
      assert.equal(status.rootSource, 'workingDirectory')
      assert.ok(status.sources > 0, `默认应扫出源文件，实际 ${status.sources}`)
      const map = await h.tool('repo_map').execute({}, { agent: { session: 's1' } })
      assert.ok(map.entries.some((entry) => entry.path.endsWith('alpha.js')), 'repo_map 默认根也应是工作区')
    }
    // 2) workingDirectory 不可用 → 回退 config.workspaceDir
    {
      const h = makeCtx(undefined)
      apply(h.ctx, { workspaceDir: fixture })
      const status = await h.tool('repo_status').execute({}, {})
      assert.equal(status.root, fixture, '必须回退 workspaceDir')
      assert.equal(status.rootSource, 'workspaceDir')
      assert.ok(status.sources > 0)
    }
    // 3) 两者都没有 → 明确报错，不再回落 process.cwd()
    {
      const saved = { dsh: process.env.DSH_HOME, up: process.env.USERPROFILE }
      delete process.env.DSH_HOME
      delete process.env.USERPROFILE
      try {
        const h = makeCtx(undefined)
        apply(h.ctx, {})
        await assert.rejects(() => h.tool('repo_status').execute({}, {}), (error) => error?.code === 'REPO_NO_WORKSPACE')
        await assert.rejects(() => h.tool('repo_map').execute({}, {}), (error) => error?.code === 'REPO_NO_WORKSPACE')
      } finally {
        if (saved.dsh !== undefined) process.env.DSH_HOME = saved.dsh
        if (saved.up !== undefined) process.env.USERPROFILE = saved.up
      }
    }
    ok('B6：默认根用会话工作目录；不可用回退 workspaceDir；都没有时报 REPO_NO_WORKSPACE（不再回落 process.cwd）')
  }
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`repomap: ${passed} 项通过`)
