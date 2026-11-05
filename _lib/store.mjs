/**
 * dsh-store —— 跨插件共享的 JSON 存储内核（v1.0 · 2026-11-05）
 *
 * 为什么要它：23 个插件里有 5 个各写了一份「原子写」，4 种质量。
 * 本文件把它们该有的性质一次做全，且每条性质都有能被证伪的测试
 * （见 `_selftest/tests/store-kernel.test.mjs`）。
 *
 * 比原来那 5 份强在哪（逐条可验，不是形容词）：
 *   1. 临时文件名唯一（pid + 6 字节随机）：多进程共享同一 storeDir 也不会互踩。
 *      原来 dsh-checkpoint / dsh-usage 用固定 `${file}.tmp`，两个进程会写同一个临时文件。
 *   2. 写前 fsync：数据先落盘再改名，断电/崩溃后不会拿到「改名成功但内容空」。
 *      原来 5 份里只有 dsh-memory 做了 fsync。
 *   3. rename 失败**放弃写入并抛错**（fail-closed），不再退回直写目标文件。
 *      原来 5 份的 catch 分支都是 `writeFileSync(storeFile, ...)` —— 恰好把原子性做没了。
 *   4. 主文件损坏时自动从 `.bak` 恢复（自愈），而不是 catch 后「从空开始」。
 *      原来 dsh-usage 的 load() 解析失败就回到空 state：一次坏文件 = 全量历史静默清零。
 *   5. 跨进程锁：读-改-写用 `update()` 串行化，不再丢更新（last-writer-wins 无告警）。
 *   6. 所有失败都带机器可读 code（STORE_*），插件可以据此决定重试还是降级。
 *
 * 刻意不做的：
 *   - 不做 schema 校验 / 版本迁移：那是各插件自己的业务，内核只保证「要么旧值，要么新值」。
 *   - 不做异步 API：调用方都是同步写小 JSON，异步化只会引入新的交错窗口。
 *   - 不在 .bak 之外做多版本历史：需要历史的插件（dsh-checkpoint）自己有业务层。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const DEFAULT_LOCK_TIMEOUT_MS = 5000
const DEFAULT_LOCK_STALE_MS = 30000
const DEFAULT_BACKUP_MAX_BYTES = 4 * 1024 * 1024
const LOCK_RETRY_MS = 10

export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    if (cause) this.cause = cause
  }
}

/** 同步等待（Node 主线程允许 Atomics.wait；不引第三方包） */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function parseJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 原子写文本文件：唯一 tmp → fsync →（可选）备份上一版 → rename。
 * rename 失败时清理 tmp 并抛 STORE_WRITE_FAILED，**绝不**退回直写目标文件。
 *
 * @param {string} file 目标文件
 * @param {string} text 内容
 * @param {{backup?: boolean, backupMaxBytes?: number}} [options] backup=false 用于**用户文件**
 *        （如台账整理的输出），避免在用户目录里凭空多出 .bak；backupMaxBytes 是备份上限，
 *        超过就跳过（大存档每次复制一份会翻倍 I/O，自愈收益不值这个价）。
 */
export function atomicWriteText(file, text, options = {}) {
  if (typeof text !== 'string') {
    throw new StoreError('STORE_BAD_VALUE', 'atomicWriteText 只接受字符串')
  }
  const backup = options.backup !== false
  const backupMaxBytes = Number.isFinite(options.backupMaxBytes) ? options.backupMaxBytes : DEFAULT_BACKUP_MAX_BYTES
  const target = path.resolve(file)
  mkdirSync(path.dirname(target), { recursive: true })

  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // 上一版留档：写坏了还能自愈。备份失败不阻塞主写入（备份是增强，不是前置条件）。
  // 大文件跳过备份：每次写都复制一份会让 I/O 翻倍，而大存档的复原价值低于中断代价。
  if (backup && text.length <= backupMaxBytes) {
    try {
      const size = existsSync(target) ? statSync(target).size : 0
      if (size > 0 && size <= backupMaxBytes) copyFileSync(target, `${target}.bak`)
    } catch {
      /* 备份失败：继续写，读侧仍有原始文件兜底 */
    }
  }

  try {
    renameSync(tmp, target)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清理失败不影响错误语义 */
    }
    throw new StoreError(
      'STORE_WRITE_FAILED',
      `改名失败，已放弃写入（旧值保持不变）：${error.message}`,
      error,
    )
  }
}

/**
 * 抢锁：O_EXCL 创建锁文件；超过 staleMs 的锁视为持有者已死，可回收。
 * 返回释放函数（幂等）。
 */
function acquireLock(lockPath, { timeoutMs, staleMs }) {
  // 锁文件与数据文件同目录；数据目录可能还不存在（首次写），先建出来。
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, `${process.pid} ${Date.now()}`, null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          unlinkSync(lockPath)
        } catch {
          /* 锁已被回收：释放是幂等的 */
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new StoreError('STORE_LOCK_FAILED', `无法创建锁文件：${error.message}`, error)
      }
      let held
      try {
        held = statSync(lockPath)
      } catch {
        continue // 锁刚被释放，立刻重试
      }
      if (Date.now() - held.mtimeMs > staleMs) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* 别人先回收了 */
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new StoreError('STORE_LOCK_TIMEOUT', `等待锁超时（${timeoutMs}ms）：${lockPath}`)
      }
      sleep(LOCK_RETRY_MS)
    }
  }
}

/**
 * 打开一个 JSON 存储。
 * @param {string} filePath 数据文件路径（目录不存在会自动创建）
 * @param {{lockTimeoutMs?: number, lockStaleMs?: number}} [options]
 */
export function openStore(filePath, options = {}) {
  const file = path.resolve(filePath)
  const lockPath = `${file}.lock`
  const backupPath = `${file}.bak`
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS
  const backupMaxBytes = Number.isFinite(options.backupMaxBytes) ? options.backupMaxBytes : DEFAULT_BACKUP_MAX_BYTES
  const writeOptions = { backup: options.backup !== false, backupMaxBytes }

  function readWithSource() {
    try {
      return { value: parseJsonFile(file), source: 'file' }
    } catch {
      /* 主文件缺失/损坏：尝试备份 */
    }
    try {
      const value = parseJsonFile(backupPath)
      try {
        copyFileSync(backupPath, file) // 自愈：把好备份顶回去
      } catch {
        /* 恢复失败也不影响本次读取 */
      }
      return { value, source: 'backup' }
    } catch {
      return null
    }
  }

  function serialize(value) {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') {
      throw new StoreError('STORE_BAD_VALUE', '写入值无法序列化为 JSON（undefined/function？）')
    }
    return text
  }

  return {
    path: file,
    backupPath,
    lockPath,
    /** 读；文件与备份都不可用时返回 null（从不抛） */
    read() {
      const found = readWithSource()
      return found === null ? null : found.value
    },
    /** 读并告诉调用方数据来自 'file' 还是 'backup'（诊断用） */
    readWithSource,
    /** 覆盖写（带锁；失败抛 StoreError） */
    write(value) {
      const text = serialize(value)
      const release = acquireLock(lockPath, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs })
      try {
        atomicWriteText(file, text, writeOptions)
      } finally {
        release()
      }
    },
    /**
     * 读-改-写（带锁）。mutator 收到当前值（缺失为 null），返回新值。
     * 并发调用者会串行执行，不丢更新。
     */
    update(mutator) {
      if (typeof mutator !== 'function') {
        throw new StoreError('STORE_BAD_VALUE', 'update 需要一个 mutator 函数')
      }
      const release = acquireLock(lockPath, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs })
      try {
        const current = this.read()
        const next = mutator(current)
        atomicWriteText(file, serialize(next), writeOptions)
        return next
      } finally {
        release()
      }
    },
  }
}
