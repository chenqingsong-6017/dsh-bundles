# `_lib/store.mjs` —— 插件共享存储内核 v1.0

**一句话**：23 个插件里原本有 5 份各写各的「原子写文件」，质量 4 种；本内核把它们该有的性质一次做全，
并且**每条性质都有一个能让它变红的测试**（`_selftest/tests/store-kernel.test.mjs`，9 组用例）。

## 用法

```js
import { openStore } from '../_lib/store.mjs'        // 插件入口在根目录时
import { openStore } from '../../_lib/store.mjs'     // 插件代码在 lib/ 子目录时

const store = openStore('/path/to/state.json')
store.read()                      // 读；文件与备份都不可用 → null（从不抛）
store.write({ any: 'json' })      // 覆盖写（带锁；失败抛 StoreError）
store.update((cur) => ({ n: (cur?.n ?? 0) + 1 }))  // 读-改-写（带锁，不丢更新）
```

给用户文件用底层入口（不产生 `.bak`）：

```js
import { atomicWriteText } from '../../_lib/store.mjs'
atomicWriteText(outPath, markdown, { backup: false })
```

## 它比原来那 5 份强在哪（逐条可验，不是形容词）

| # | 性质 | 内核 | 原来那 5 份 |
|---|---|---|---|
| 1 | 临时文件名唯一（pid + 6 字节随机） | 有 | checkpoint / usage 用固定 `${file}.tmp`，两进程共用同一个临时文件 |
| 2 | 写前 `fsync` | 有 | 只有 dsh-memory（`store.js`）做了 |
| 3 | 改名失败 → **放弃并抛错**（fail-closed） | 有 | 5 份的 catch 全是 `writeFileSync(目标)` 直写，**恰好把原子性丢掉** |
| 4 | 主文件损坏 → 从 `.bak` 复原 | 有 | usage 的 `load()` 解析失败回空 state：一次坏文件 = 全量历史静默清零 |
| 5 | 跨进程锁（读-改-写串行化） | 有（陈旧锁 30s 回收、等锁 5s 超时） | 全部无锁，last-writer-wins |
| 6 | 失败带机器可读 code（`STORE_*`） | 有 | 有 `return false`、有 `throw error`，插件只能猜 |

判据锚（反向验一遍）：如果「内核不比原来强」为真，那 `store-kernel.test.mjs` 的 (2)/(3)/(4) 应该过不了——
(2) 要求 4 进程 × 25 次读-改-写一次不丢，(3) 要求同一份坏文件上新实现保住数据、旧实现清零，
(4) 要求改名失败时抛错且旧值不动。这三条都是**先证伪**写的，不是事后补的。

## 边界（刻意不做的事）

- **不做 schema 校验 / 版本迁移**：那是插件的业务。内核只保证「要么旧值，要么新值」。
- **不做异步 API**：调用方都是同步写小 JSON；异步化只会引入新的交错窗口。
- **不做多版本历史**：需要历史的插件（dsh-checkpoint）自己在业务层做。
- **备份有上限**（默认 4 MiB，`backupMaxBytes` 可调）：大存档每次复制一份会让 I/O 翻倍，
  自愈收益低于中断代价，所以超过上限就跳过备份。
- **不给用户文件留 `.bak`**：用户目录里凭空多文件是污染，用 `{ backup: false }`。

## 迁移进度（2026-11-05）

已切到内核：

- `dsh-usage`（`persist` / `load`）
- `dsh-checkpoint`（`persistNow` / `loadPersisted`）
- `dsh-research`（`saveStore` + 报告文件写）

待切（各自有真实差异，不是偷懒）：

- `dsh-butler-tidy`（`lib/inventory.js` 的 `atomicWriteText`）：它写的是**用户目录里的台账/清单**，
  切过去必须显式 `backup: false`，且要连同「整理操作是否允许留临时文件」一起复核。
- `dsh-memory`（`lib/store.js`）：一份内存状态要同时落 `memory.json` + 别名旁路 + 历史流水，
  是多文件事务，不能按单文件原子写一刀切；要切得连 `store-snapshot.js` 一起设计。

## 测试

```powershell
cd D:\AI\dsh-bundles\_selftest\tests
node store-kernel.test.mjs     # 9 组用例，含 4 个子进程并发
```

验证门（`npm run check`）会自动跑它（孤儿测试，不映射任何插件名，但会被全量执行）。
