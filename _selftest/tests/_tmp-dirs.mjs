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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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

process.on('exit', () => {
  for (const dir of owned.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      /* 留给下一次 sweepStaleDirs */
    }
  }
})
