# dsh-projcache-delta --- 会话投影缓存的增量 checkpoint（治本实现）

> 状态：真机实验层（2026-11-12）。上游提案：_research/session-projection-cache-incremental-checkpoint.md。
> 影响面：所有 profile / 所有长会话（本包是**官方三件存储包的 fork**，不改 app.asar）。
> 定位：**临时载体**——以上游 issue/PR 合并为目标；合并后删除本包与安装脚本，不保留两套实现。

## 1. 一句话

官方存储栈每次写投影缓存都重写整份记录（O(会话状态) 字节 + 原子替换 + fsync）；
本包把它换成 **基线 + 增量追加、到期折叠**：一次 turn/end 只写变化的行（长会话实测 -90%），
读路径完全不变（存储层折叠回同一个整值），旧版 v7 记录照读、首次写升级。

## 2. 改了哪三个包（都在 lib/，逐文件标注 deviation）

| 文件 | 上游 | 偏差 |
|---|---|---|
| lib/delta.js | 新增 | 编解码：mergeDelta / applyDelta / parseDocument / planJournalWrite（纯函数，可单测） |
| lib/storage-json.js | @deepseek-ai/dsh-storage-json@0.2.2-rc.1 | 新增 descriptor.delta 开关：per-record 文档变成 JSONL journal（基线行 + 增量行），读时折叠；追加/折叠策略按行数与字节；旧整文档照读 |
| lib/storage-domain.js | @deepseek-ai/dsh-storage-domain@0.2.2-rc.1 | KvTable.put/update 把「上一版权威值」作为第 4 个参数传给 backend（增量 diff 的基准，必须权威，不能猜）；defineDomain/descriptorOf 透传 delta 旋钮 |
| lib/session-projection-cache.js | @deepseek-ai/dsh-session-projection-cache@0.2.2-rc.1 | 域版本 7 -> 8（compatibleVersions 保留 3..7），delta: true；逻辑记录与所有读面不变 |

## 3. 存储格式（schema v8）

storages/session_projcache/sessions/<id>.json 从「一份 pretty JSON」变成「JSONL journal」：

    {"version":8,"record":{...}}                              <- 基线（整值，单行）
    {"version":8,"delta":{"set":[["rows.title",{...}]],       <- 每回合一行，只写变化
                          "del":[["rows.gone"]]}}

- 追加条件：有权威前值、能无损表达、未到折叠上限（deltaMaxLines 20 行 / deltaCompactBytes 32KB 或基线大小）。
- 折叠：到上限的下一次写直接写成新基线（原子替换），增量链截断。
- 值没变：不写盘（字节零增长）。
- 撕裂尾行：只丢最后一条增量；坏中间行 / 版本戳不认识：整条记录按缺失处理（缓存语义，最坏冷读重建）。
- 旧 v7 整文档：照读，首次真实写入升级成 journal 基线。

## 4. 安装（零重启）与撤装

    node install.mjs            # dry-run
    node install.mjs --apply    # 建 profile @local junction + 往 profile cordis.patch.yml 拼块
    node verify.mjs             # 看缓存文件形态：journal = 新代码已生效
    node install.mjs --revert   # 撤装（安全网，非常态路径；删块 + 删 junction）

HMR 会监听 profile patch 并重组（约 3 秒），**不需要重启**。不改 app.asar、不跑 pnpm，也不在 profile 留 .bak 备份
（patch 用临时文件 + rename 原子落盘）。注意：本包同时带 cordis.patch.yml（canonical 行），若将来改走 plugin_manager
作为 bundle 安装，**只能用一种方式**，否则同样 id 会应用两次。

## 5. 测试

    node _selftest/tests/projcache-delta.test.mjs   # 24 组：编解码往返/撕裂行/版本/v7 升级/折叠/上一版传参/域 v8

## 6. 边界与终局

- 撤装后旧代码读 journal 文件会失败 -> 视为缺失记录 -> 冷读重建（派生数据，不丢用户数据）。
- 终局：上游合并后本包与安装脚本一起删除，只留官方包。
- 已知边界：1) fork 钉在 0.2.2-rc.1，DSH 升级后需重新对齐上游；2) 追加不是多进程安全（同一进程单写者，与上游一致）；
  3) 折叠前文件短暂大于基线（上限 20 行 / 32KB 增量），读路径折叠成本仍在启动期。
- 判据锚：同一长会话，每回合写字节 / 写次数 / 渲染进程 CPU·内存三项应显著下降；不降 = 方案不对，回滚重判。
