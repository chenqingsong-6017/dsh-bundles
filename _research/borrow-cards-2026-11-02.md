# 借鉴卡补录 · 2026-11-02（任务 1-7 + B 类）

> 为什么补：首版汇报里任务 2 / 任务 4 的「对照对象」只给了结论，没贴读过的证据，也没写清「哪部分没借」。
> 本文只补证据与取舍，不重复交付内容；每条都给可点 URL 或 `文件:行`。

## 1. github-slugger（任务 1 · 锚点规范化）

```
来源：https://github.com/Flet/github-slugger （index.js 的 slug()、regex.js 的巨型字符集正则；本轮 clone 实读）
许可证：ISC（LICENSE 原文：Permission to use, copy, modify ... provided that the above copyright notice ... appear）
学的是机制还是代码：机制——小写 → 去标点/符号/控制符（保留 _ 与 -）→ 空格逐个转 -，连续空格不塌缩
我们不照搬的原因：插件是零依赖单文件，不引依赖、不复制 regex.js（12KB 生成表）；自实现后用它跑出的
期望值写死进测试（_selftest/tests/obsidian.test.mjs:352-356），运行时不依赖 clone
```

落地：`dsh-obsidian/index.js:392`（`slugifyHeading`）、`:434`（`matchHeadingAnchor`）；数字节号/前导片段两条
是本库指针约定的兼容规则（不是 GitHub 语义），已在 README「解析的已知边界」写明。

## 2. platers/obsidian-linter（任务 2 · 同义写法）

```
来源：https://github.com/platers/obsidian-linter （src/utils/mdast.ts:59 MDAstTypes、:661 makeEmphasisOrBoldConsistent）
许可证：MIT
学的是机制还是代码：机制——用语法树按「结构」判 strong/emphasis，`**x**` 与 `__x__` 一视同仁
我们不照搬的原因：为一个 8 字标记引 mdast/unified 不划算；改用一条结构正则覆盖 ** / __ / > / 半角冒号
```

落地：`dsh-obsidian/index.js:489`（`hasOneLiner`）；真实库 28 篇 0 错 0 警（改前 5 条误报）。

## 3. cyanheads/obsidian-mcp-server（任务 2 指定的「写侧」对照）

```
来源：https://github.com/cyanheads/obsidian-mcp-server （本轮 clone 实读，git grep 取证）
许可证：Apache-2.0（LICENSE 实读）
学的是机制还是代码：只读机制，不借代码
我们不照搬的原因：它的强项是「写侧」约束，与「读侧 lint 一句话」不是同一层问题
```

实读到的写侧机制（证据）：
- 写路径白名单：`OBSIDIAN_WRITE_PATHS` / `OBSIDIAN_DENY_PATHS` / `OBSIDIAN_READ_ONLY`
  （`src/mcp-server/tools/definitions/obsidian-append-to-note.tool.ts:76`）
- 大小写变体同文件即 Conflict，不覆盖：`src/mcp-server/tools/definitions/_shared/suggest-paths.ts:91/228`
- 局部改而非整篇覆盖：`obsidian-patch-note.tool.ts` + `src/services/obsidian/patch-instruction.ts`
- 对照结论：这三条我们已在 v0.2.0 的 P2 受控写里落地（白名单 / create 不覆盖 / hash+mtime 冲突即放弃 /
  section 只换一段），见 `dsh-obsidian/CHANGELOG.md:50`。本轮 `missing_one_liner` 是 lint（读侧），
  **不牵强借用写侧机制**——硬接进来只会是凑数。

## 4. basicmachines-co/basic-memory（任务 1 / B 类对照）

```
来源：https://github.com/basicmachines-co/basic-memory （本轮 clone 实读）
许可证：AGPL-3.0（LICENSE 实读）——只学机制，零代码复制
学的是机制还是代码：机制——文件是权威源、索引/DB 是派生视图；指针健康检查作为可观测项
我们不照搬的原因：AGPL 不复制；且本机权威源已是 memory.json，vault 是成品层，关系与它相反
```

**纠偏**：任务书说「学 sync_status 机制」，实读发现该包内已无 `sync_status`，对应能力叫
`project_index_status` / `required`（派生索引的新鲜度检查）。本轮只借「派生视图要报新鲜度/断链」的思路。

## 5. Claude Code hooks + 官方 dsh-hooks-claude-code 桥接包（任务 4/5）

```
来源：https://cdn.jsdelivr.net/npm/@deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5/README.md （官方包 README，实读）
      https://github.com/anthropics/claude-code （LICENSE.md 实读：All rights reserved / Commercial Terms）
许可证：官方 dsh 包 MIT；anthropics/claude-code 仓库为商业条款（只读文档，不复制任何代码）
学的是机制还是代码：机制——PreToolUse / PostToolUse 在工具调用前后拦截并可返回 block 理由
我们不照搬的原因：本机 hooks.json 已是 native 格式；再套桥接包会多一层进程，与任务 5「省进程」相反
```

落地证据：`dsh-hooks/index.js:47-67` 的事件别名表（`PreToolUse→tool.pre`、`PostToolUse→tool.post`、
`Stop→turn.stop` 等），任务 4 的「pre-execute waterfall 顺序」与任务 5 的「同一点合并」都建立在这套
事件语义上。桥接包 README 原话：「run a Claude Code hooks.json / settings hook config on the DeepSeek
Harness interception seams」——与我们的 native 实现同缝，故不引入。

## 6. mem0 / Letta（B 类 · 只对照）

```
来源：mem0（clone 只剩 .git，工作树缺失 → 只算线索）；Letta（本轮未 clone → 未验证）
许可证：未验证（不敢写成已知）
学的是机制还是代码：不借，只作注入预算对照
我们不照搬的原因：本机记忆预算 11923/12000 已满，任何「扩预算」的方案都不成立
```

## 补录结论（一句话）

| 参考对象 | 用了/没用 | 理由 |
|---|---|---|
| github-slugger | 用机制 | 锚点规范化，自实现+期望值测试 |
| obsidian-linter | 用机制 | 结构判定替代字面量 |
| obsidian-mcp-server | 不用（写侧已落地） | lint 是读侧问题，硬接=凑数 |
| basic-memory | 用机制 | 派生索引健康检查；纠正 sync_status 说法 |
| Claude Code hooks / 桥接包 | 用机制，不装包 | 事件语义同缝；装包会多进程 |
| mem0 / Letta | 只对照 | 预算已满，不扩 |