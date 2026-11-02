// 测试临时目录统一管理。
//
// 为什么有它：mkdtemp 建的临时目录，若测试中途断言失败、或 SQLite 连接仍锁着 memory.db，
// rmSync 会静默失败（Windows 上 EBUSY），垃圾越积越多——2026-11-02 实测 5 小时积了
// 153 个目录 / 23.7 MB，全是「跑完没扫地」留下的。
//
// 三道保险：
//   1) 目录名带 pid —— 下次运行能认出「上次的进程已退出」，把它的遗留清掉（真正的兜底）；
//   2) 进程退出时尝试删自己的（连接仍锁住时失败，交给第 1 条）；
//   3) 统一 tmp()/cleanup() 入口，各测试文件不再各写一套。
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = os.tmpdir()
// 目录名形如 dsh-memory-sqlite-migrate-12345-AbCdEf（末段是 mkdtemp 的 6 位随机串）
const STALE = /^dsh-memory-[\w-]+-(\d+)-[A-Za-z0-9]{6}$/
const owned = []

function pidAlive(pid) {
  if (pid === process.pid) return true
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但当前用户无权限发信号，仍算活着
    return error.code === 'EPERM'
  }
}

/** 清掉「上次运行遗留、所属进程已退出」的临时目录。返回清掉的个数。 */
export function sweepStaleDirs() {
  let names = []
  try {
    names = readdirSync(ROOT)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of names) {
    const match = STALE.exec(name)
    if (!match) continue
    if (pidAlive(Number(match[1]))) continue
    try {
      rmSync(path.join(ROOT, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      swept += 1
    } catch {
      /* 下一次运行再试 */
    }
  }
  return swept
}

/** 建一个带 pid 的临时目录，并登记，进程退出时兜底删除。 */
export function makeTmp(prefix) {
  const dir = mkdtempSync(path.join(ROOT, `${prefix}-${process.pid}-`))
  owned.push(dir)
  return dir
}

/** 显式删除（测试用例正常结束时调用）；失败也不抛，交给下一次 sweepStaleDirs。 */
export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 连接仍锁住时忽略 */
  }
  const index = owned.indexOf(dir)
  if (index >= 0) owned.splice(index, 1)
}

// ---------------------------------------------------------------------------
// 全测试兜底清扫（2026-11-02 推广）。
//
// 各测试文件大多用 mkdtempSync 在 %TEMP% 下建目录，多数自己会 rmSync；但
// 「断言中途失败 / 删错对象 / 压根没写清理」时就会漏（eventlog-q、metrics-empty
// 就是实测抓到的两处）。这里用「进程启动时刻」判定归属：本次进程启动之前建好的
// 同名目录一定是上一次遗留，清掉；本次启动之后建的一律不碰。
//
// 前缀表刻意列全、不用通配：%TEMP% 里还有 DSH 运行时的 dsh-subprocess-* 等真目录，
// 误删会坏事。新增测试若用新前缀，把它补进来。
const TEST_PREFIXES = [
  'dsh-memory-',
  'dsh-eventlog',
  'dsh-obsidian-',
  'dsh-research-',
  'dsh-usage-',
  'dsh-notify-',
  'dsh-hooks-test-',
  'dsh-gate-hollow-',
  'dsh-team-write-scope-',
  'metrics-',
  'path-rules-',
  'repomap-',
  'skill-usage-',
  'updater-test-',
  'auto-approve-',
  'guards-merge-',
  'hooks-merge-apply-',
  'assembly-order-',
  'icd-fixture-',
  'tidy-inv-test-',
  'workbuddy-product-spill-',
]

/** 清掉上次运行遗留的全部测试临时目录。返回清掉的个数。 */
export function sweepAllTestDirs() {
  const startedAt = Date.now() - process.uptime() * 1000
  const graceMs = 5000 // 本进程刚启动时的时间窗，避免把正在启动的并发写误判成遗留
  let names = []
  try {
    names = readdirSync(ROOT)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of names) {
    if (!TEST_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const full = path.join(ROOT, name)
    try {
      const stat = statSync(full)
      if (stat.birthtimeMs > startedAt - graceMs) continue // 本次运行刚建的，不碰
      rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      swept += 1
    } catch {
      /* 下一次再试 */
    }
  }
  return swept
}

process.on('exit', () => {
  for (const dir of owned.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      /* 留给下一次 sweepStaleDirs */
    }
  }
})
