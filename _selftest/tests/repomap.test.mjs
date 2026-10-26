import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, createScanCache, extractSymbols } from '../../dsh-repomap/index.js'

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
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`repomap: ${passed} 项通过`)
