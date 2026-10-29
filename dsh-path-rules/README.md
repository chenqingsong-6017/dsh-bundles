# dsh-path-rules —— 路径规则（path-scoped rules）

> 学谁：Claude Code 的 `.claude/rules`。把纪律从「一个每轮全量灌入的 AGENTS.md」拆成「按文件路径分片、触发了才注入」。

## 它解决什么

`AGENTS.md` 是全局的：写十条规定，每轮都在花 token，而其中九条和当前改的文件无关。规则越多，真正相关的那条越被稀释。

路径规则反过来：**声明「这条规则管哪类文件」，只有当 agent 真的碰到那类文件时，它才进上下文。**

## 一条规则长什么样

放在 `<工作目录>/.dsh/rules/*.md`（项目级）或 `$DSH_HOME/rules/*.md`（用户级，默认 `~/.dsh/rules`）：

```
---
paths:
  - "src/**/*.tsx"
  - "*.json"
---
改前端组件时：先看设计稿，再动代码；样式只用设计 token，不写魔法值。
```

- `paths` 支持 `**`（跨目录）、`*`（单层）、`?`（单字符）、`{a,b}`（分支）；
- 路径按**相对当前工作目录**匹配，Windows 反斜杠会自动归一化；
- 没有 frontmatter、没有 `paths`、正文为空 —— 这类文件静默跳过，不会报错，也不会污染提示。

## 什么时候触发

`read` / `write` / `edit` / `glob` / `grep` 等工具的参数里有 `file_path` / `filePath` / `path`，且相对路径命中某条规则的 glob 时，这条规则进入**当前会话**的系统提示。

- 触发一次后在本会话内保持活跃（不自动退出），行为可预期；
- 规则按会话隔离，A 会话触发的规则不会串到 B 会话；
- 每轮注入预算默认 3000 字符（`maxChars`），超出按触发顺序截断并显式提示「另有 N 条未展开」。

## 诊断

```
path_rules_status
```

告诉你有几个规则目录、各扫到几条、本次运行触发过哪些规则、注入预算是多少。

## 已知边界（刻意不做）

- **不跟踪 shell 命令里提到的文件**：只看结构化工具参数，`pwsh` 里 `type foo.ts` 不会触发；
- 规则目录**只扫一层**，不递归；
- 只会把规则注入提示，不会替你去执行规则；
- 规则文件改了会在下次触发时重新读（按 mtime 缓存），但已经注入的内容不会中途撤回。

## 设计取舍

- **为什么用 systemPrompt.context 而不是插一条 user 消息**：官方插件 `dsh-agent-instructions` 用 inbox 消息注入，但那套机制会与它自己的 reconcile 冲突；`systemPrompt.context` 是官方公开的注入点（`dsh-memory` 也用同一机制），更稳。
- **为什么按会话隔离**：规则是「这个任务碰到这类文件」的事实，跨会话串台会让上下文失真。
- **为什么触发后不退出**：一旦规则在上下文里，中途抽走会让模型行为突变；保持到会话结束更可预期。

## 验证记录

### 行为测试（2026-10-29）

`node _selftest/tests/path-rules.test.mjs` —— **10 项全过**：

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构合规（package.json / patch / locale / icon / 入口 export） | ✅ |
| 2 | block 风格 `paths` 解析 | ✅ |
| 3 | inline 数组风格 `paths` 解析 | ✅ |
| 4 | 非法规则文件静默跳过 | ✅ |
| 5 | glob：`**` / `*` / `?` / `{a,b}` | ✅ |
| 6 | Windows 分隔符与绝对路径归一化 | ✅ |
| 7 | 触及匹配文件才注入 | ✅ |
| 8 | 一次触发后在本会话内保持 | ✅ |
| 9 | 规则按会话隔离 | ✅ |
| 10 | status 工具已注册 | ✅ |

测试用真实临时目录 + 真实插件代码，喂 `tools/post-execute` 事件，断言系统提示渲染结果。

### 安装

- `C:\Users\<user>\.dsh\profiles\desktop\package.json` 已加 `"@local/dsh-path-rules": "link:D:/AI/dsh-bundles/dsh-path-rules"`；
- `dsh.profile.bundles` 已加入 `@local/dsh-path-rules`；
- `pnpm install` 已建立 Junction（`+ @local/dsh-path-rules 0.1.0`）。

### 真实验证（2026-10-29，重启 DSH 后）

| # | 验证 | 结果 |
|---|---|---|
| 1 | `path_rules_status` 可调用，能列出规则目录 | ✅（同时暴露一个 bug，见下） |
| 2 | 写 `.dsh/rules/probe.md`（`paths: ["**/*.md"]`），下一步系统提示出现 `<path-rules>` 块，探针原文一字不差 | ✅ |
| 3 | 读 `.js` 文件不触发 `*.json` 规则；读 `package.json` 才触发 | ✅ 不误触发、精确匹配 |

**真实调用暴露、单测没抓到的 bug（修了两次才对）**：`path_rules_status` 原来用 `process.cwd()`（DSH 进程的工作目录 = profile 目录），诊断里显示成 `C:\Users\...\profiles\desktop\.dsh\rules`——错的。

- 第一次修：改成「最近一次会话工作目录」的全局变量 —— **没修好**，因为那个变量只在有活跃规则时才会被填，全新会话里仍是空的；
- 第二次修：改用工具执行的第二参数 `exec.agent.session` 直接取会话工作目录（`tool.execute(args, exec)`，dsh-tools 3406 行确认），不再依赖全局状态。

教训：第一次修复是「在现有结构上凑」，第二次才是去查扩展点。**判据是能不能拿到 context，不是能不能编译过。**

> 这条 bug 本身就是「能跑≠做好」的例子：10 项单测全绿，真实跑一次就露。

## 卸载

从 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `@local/dsh-path-rules`，再 `pnpm install`，重启。
