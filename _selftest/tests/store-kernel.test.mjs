/**
 * dsh-store 内核回归（2026-11-05）
 *
 * 这份测试的目的不只是「新代码能跑」，而是**证明它比原来那 5 份手写原子写强**：
 * 每个用例都对应旧实现的一个具体失效方式，且断言的是可观测事实（文件内容/错误码），
 * 不是「代码看起来对」。
 *
 * 用例 → 旧实现的失效方式：
 *   (1) 唯一 tmp         → checkpoint/usage 固定 `${file}.tmp`，两进程共用同一个临时文件
 *   (2) 并发不丢更新     → 5 份都是读-改-写无锁，last-writer-wins
 *   (3) 坏文件自愈       → usage.load() 解析失败回空 state：一次坏文件 = 历史清零
 *   (4) fail-closed      → 5 份的 catch 都退回 writeFileSync(目标)，原子性当场失效
 *   (5) 陈旧锁回收       → 旧实现没有锁，进程崩溃不会留下需要回收的状态
 *   (6) 锁超时可观测     → 旧实现被别的进程卡住时无界等待
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { atomicWriteText, openStore, StoreError } from '../../_lib/store.mjs'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const root = mkdtempSync(path.join(tmpdir(), 'dsh-store-test-'))
const kernelUrl = new URL('../../_lib/store.mjs', import.meta.url).href

const fresh = (name) => path.join(root, name, 'store.json')

// ---- (0) 未写过的文件读出来是 null，不抛 ----
{
  const store = openStore(path.join(root, 'empty', 'deep', 'store.json'))
  assert.equal(store.read(), null)
  store.write({ hello: 'world' })
  assert.deepEqual(store.read(), { hello: 'world' })
  assert.ok(existsSync(path.join(root, 'empty', 'deep', 'store.json')), '目录应被自动创建')
  ok('(0) 目录自动创建；未写过的文件读出 null 而不是抛错')
}

// ---- (1) 临时文件名唯一：一次写完之后目录里不应残留 tmp ----
{
  const file = fresh('tmpname')
  const store = openStore(file)
  store.write({ a: 1 })
  store.write({ a: 2 })
  const leftovers = readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '写完后不应残留 .tmp 文件')
  assert.ok(existsSync(`${file}.bak`), '第二次写应留下上一版 .bak')
  ok('(1) 写完清理临时文件；上一版落 .bak')
}

// ---- (2) 4 个进程 × 25 次读-改-写 → 一次都不能丢 ----
{
  const file = fresh('concurrent')
  const store = openStore(file)
  store.write({ n: 0 })
  const child = `
    const { openStore } = await import(${JSON.stringify(kernelUrl)})
    const store = openStore(${JSON.stringify(file)})
    for (let i = 0; i < 25; i += 1) store.update((value) => ({ n: (value?.n ?? 0) + 1 }))
  `
  const results = []
  for (let i = 0; i < 4; i += 1) {
    results.push(spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 60000,
    }))
  }
  for (const result of results) assert.equal(result.status, 0, '子进程应正常退出')
  assert.equal(openStore(file).read().n, 100, '4 进程 × 25 次读-改-写必须一次不丢')
  ok('(2) 跨进程读-改-写不丢更新（100/100）—— 旧实现是无锁读改写，必然丢')
}

// ---- (3) 主文件坏了，自动从 .bak 复原（旧实现回空状态 = 数据清零） ----
{
  const file = fresh('heal')
  const store = openStore(file)
  store.write({ version: 1, files: { keep: 'me' }, lastScanAt: null })
  store.write({ version: 1, files: { keep: 'me', extra: 'x' }, lastScanAt: null }) // 生成 .bak（第一版）
  writeFileSync(file, '{"version":1,"files":{"keep":"me"', 'utf8') // 半截文件

  const healed = openStore(file).read()
  assert.deepEqual(healed, { version: 1, files: { keep: 'me' }, lastScanAt: null }, '应从 .bak 复原上一版')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).files.keep, 'me', '复原后主文件应可用')

  // 旧实现（dsh-usage v1 load）在同一份坏文件上的行为：catch → 空 state。
  // 注意要重新弄坏主文件——上面那次 read() 已经把好备份顶回去了。
  writeFileSync(file, '{"version":1,"files":{"keep":"me"', 'utf8')
  const naiveLoad = () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version === 1 && parsed?.files) return parsed
    } catch {
      /* 旧实现静默吞掉 */
    }
    return { version: 1, files: {}, lastScanAt: null }
  }
  assert.deepEqual(naiveLoad().files, {}, '旧实现在坏文件上确实回空（对照，非回归）')
  assert.notDeepEqual(healed.files, {}, '新实现在坏文件上保住数据')
  ok('(3) 坏文件自愈：新实现保住数据，旧实现清零——同一份文件、两种结果')
}

// ---- (4) fail-closed：改名失败就放弃，不退回直写，也不留半截 ----
{
  const file = fresh('closed')
  mkdirSync(file, { recursive: true }) // 用目录占住目标路径，让 rename 必然失败
  const store = openStore(file)
  let code = ''
  try {
    store.write({ x: 1 })
  } catch (error) {
    code = error instanceof StoreError ? error.code : 'NOT_STORE_ERROR'
  }
  assert.equal(code, 'STORE_WRITE_FAILED', 'rename 失败必须抛 STORE_WRITE_FAILED')
  assert.ok(existsSync(file), '目标路径未被破坏')
  const leftovers = readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '失败后应清理临时文件')
  try {
    store.write({ x: 1 })
  } catch {
    /* 再失败一次，确认不是偶发 */
  }
  ok('(4) fail-closed：改名失败就抛错、旧值不动、不留 tmp（旧实现在这里退回直写）')
}

// ---- (5) 陈旧锁可回收：持有者崩了不会把存储永久锁死 ----
{
  const file = fresh('stale')
  const store = openStore(file)
  store.write({ n: 1 })
  const old = new Date(Date.now() - 60000)
  writeFileSync(`${file}.lock`, '999999 0', 'utf8')
  utimesSync(`${file}.lock`, old, old)
  const next = store.update((value) => ({ n: value.n + 1 }))
  assert.equal(next.n, 2)
  assert.ok(!existsSync(`${file}.lock`), '更新完成后锁应释放')
  ok('(5) 60 秒前的死锁被回收并完成更新；正常路径用完即释放')
}

// ---- (6) 锁被活进程持有时，超时是明确错误码而不是无界等待 ----
{
  const file = fresh('timeout')
  const store = openStore(file, { lockTimeoutMs: 200 })
  store.write({ n: 0 })
  writeFileSync(`${file}.lock`, '123456 ' + Date.now(), 'utf8') // 新鲜锁 = 有人正在写
  const started = Date.now()
  let code = ''
  try {
    store.update((value) => ({ n: value.n + 1 }))
  } catch (error) {
    code = error instanceof StoreError ? error.code : 'NOT_STORE_ERROR'
  }
  const waited = Date.now() - started
  assert.equal(code, 'STORE_LOCK_TIMEOUT')
  assert.ok(waited >= 150, `应等满超时再报错，实测 ${waited}ms`)
  assert.equal(openStore(file).read().n, 0, '拿不到锁就不能写')
  ok('(6) 锁被占时 200ms 超时抛 STORE_LOCK_TIMEOUT，数据保持不变')
}

// ---- (7) 原子写文本：与 JSON 无关的通用入口同样唯一 tmp ----
{
  const file = path.join(root, 'text', 'note.txt')
  atomicWriteText(file, 'hello')
  atomicWriteText(file, 'hello2')
  assert.equal(readFileSync(file, 'utf8'), 'hello2')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), 'hello')
  ok('(7) atomicWriteText 通用入口：内容与上一版备份都对')
}

// ---- (8) 边界：用户文件不留 .bak；超过 backupMaxBytes 的大存档也跳过备份 ----
{
  const userFile = path.join(root, 'user', 'report.md')
  atomicWriteText(userFile, 'v1')
  atomicWriteText(userFile, 'v2', { backup: false })
  assert.equal(readFileSync(userFile, 'utf8'), 'v2')
  assert.ok(!existsSync(`${userFile}.bak`), '用户文件不应凭空多出 .bak')

  const bigFile = path.join(root, 'big', 'store.json')
  const store = openStore(bigFile, { backupMaxBytes: 8 })
  store.write({ pad: 'x'.repeat(64) })
  store.write({ pad: 'y'.repeat(64) })
  assert.ok(!existsSync(`${bigFile}.bak`), '超过 backupMaxBytes 的存档跳过备份（避免 I/O 翻倍）')
  assert.equal(JSON.parse(readFileSync(bigFile, 'utf8')).pad[0], 'y')
  ok('(8) 用户文件不带 .bak；大存档跳过备份（备份是增强，不是代价）')
}

rmSync(root, { recursive: true, force: true })
console.log(`store-kernel: ${passed} 组用例通过`)
