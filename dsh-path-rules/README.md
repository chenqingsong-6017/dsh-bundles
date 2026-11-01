# dsh-path-rules v2 —— 分层路径规则（layered path rules）

> 一句话：把"什么时候该想起哪条纪律"变成可声明的三件事——**用户级**（跨项目）、**项目级**（这个仓库）、**路径命中**（只在你碰到某类文件时）。离当前文件越近、越具体，优先级越高。

学谁：Claude Code 的 `.claude/rules`（按路径分片）＋ `CLAUDE.md`（每轮注入的少量核心纪律）。DSH 默认只有 `AGENTS.md` 一种注入方式：全局、每轮、全量；规则一多就互相稀释，且十条里九条和当前改的文件无关。

## 一、它解决什么

| 问题 | 现在的 DSH | 装上本插件后 |
|---|---|---|
| 跨项目通用的纪律（"提交前跑类型检查"） | 每个项目的 AGENTS.md 里各抄一遍 | 用户级规则写一次，处处生效 |
| 这个仓库特有的纪律（"只许用 node 内置模块"） | 塞进 AGENTS.md，跟随所有任务 | 项目级规则，只在这个工作目录生效 |
| 只和某类文件相关的纪律（"改前端组件先看设计稿"） | 每轮都在花 token，而且被稀释 | 路径规则：碰到 `src/**/*.tsx` 才注入 |
| 同一条规则在用户级和项目级都写了 | 两份都进上下文，互相打架 | 同 id 只留优先级最高的一条 |

## 二、三层模型（对照 Claude Code）

Claude Code 的做法是「CLAUDE.md 每轮全量 + .claude/rules 按 paths 分片 + 用户级/项目级分层」。本插件把这四件事压成三层 + 一套优先级：

| 层 | 目录 | 生效方式 | 本插件里的名字 |
|---|---|---|---|
| 用户级 | `$DSH_HOME/rules/*.md`（默认 `~/.dsh/rules`） | frontmatter 写 `always: true` 时每轮注入；写 `paths` 时命中才注入 | 用户级 |
| 项目级 | `<cwd>/.dsh/rules/*.md` | 同上 | 项目级 |
| 路径命中 | 上面两批文件里**靠 paths 命中当前触及文件**的那些规则 | 只有 agent 读/写/改/搜到匹配文件后才注入，一次触发在会话内保持 | 路径命中 |

优先级（数字越大越优先，同 id 冲突时数字大的覆盖数字小的）：

| 来源层 | 生效方式 | 优先级 |
|---|---|---|
| 用户级 | `always: true`（每轮） | 0 |
| 项目级 | `always: true`（每轮） | 1 |
| 用户级 | `paths` 命中 | 2 |
| 项目级 | `paths` 命中 | 3 |

也就是 **用户级 < 项目级 < 路径命中**：更近（项目级）覆盖更远（用户级），更具体（真的命中了当前文件）覆盖更泛（每轮都灌）。刻意的取舍：一条"用户级路径规则"会赢过"项目级每轮规则"，因为前者精确对应你正在动的文件。不想要这个行为，就别给同一条纪律同时写两种形态。

## 三、规则文件和 frontmatter

### 3.1 每轮生效的核心层（`always: true`）

```
---
id: 通用纪律
always: true
---
提交前跑类型检查；不确定就说不确定，不要编。
```

### 3.2 路径层（`paths` 命中才生效，v1 写法，不用改）

```
---
id: 前端
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
---
改组件先看设计稿，样式只用设计 token。
```

### 3.3 老规则文件（v1 写法）

只有 frontmatter + `paths` + 正文，没有 `id`、没有 `always`——**一个字都不用改**，照旧在命中时注入，只是注入文本多了一行层级标注。v1 的 10 项测试断言在 v2 里全部保留并继续通过。

### 3.4 frontmatter 规则

- `paths`：block 列表（`- "glob"`）或 inline 数组（`["a/*.ts", "b/*.md"]`）都行；支持 `**`（跨目录）、`*`（单层）、`?`（单字符）、`{a,b}`（分支）。
- `always`：`true / yes / on / 1` 算开（大小写不敏感）；`false / no / off / 0` 算关。写了 `always: true` 就不需要 `paths`。
- `id`：可选。不写就用规则文件路径当 id。**同 id 只保留优先级最高的一条。**
- 未知键忽略，不报错；既没有 `paths` 又没有 `always: true` 的文件静默跳过（不污染上下文）；正文为空也跳过。
- 单文件上限 32 KB，超了忽略。
- 规则目录只扫一层 `*.md`，不递归。

## 四、预算（两个池子分开）

| 池子 | 配置名 | 默认 | 装什么 |
|---|---|---|---|
| 核心层（`always: true`） | `maxAlwaysChars` | 2000 字符 | 每轮都要记住的少量纪律 |
| 路径层（`paths`） | `maxChars` | 3000 字符 | 命中后临时补进来的领域规则 |

装填顺序是**优先级从低到高**（把最高优先级的放最后，离模型最近）。预算不够时：

1. 单条正文太长 → 截断正文，并在末尾写"正文已截断，原文 N 字符，超出本轮 M 字符预算"；
2. 连截断的位置都没有（剩余 < 80 字符）→ 整条跳过，注入文本末尾写"另有 N 条规则超出本轮 M 字符预算，未展开"。

两个池子互不吃预算：核心层塞满不会挤掉路径层，反之亦然。
## 五、注入长什么样（真实输出）

测试项目：用户级 `common.md`（`always: true`，id `通用纪律`）、用户级 `frontend.md`（`paths: ["src/**/*.tsx"]`，id `前端`）、项目级 `core.md`（`always: true`）、项目级 `frontend.md`（同 id `前端` 的路径规则）。

**第一次装配（还没有触碰任何文件）**——只有核心层：

```
<path-rules>
以下是本轮生效的规则，优先级从低到高：用户级 < 项目级 < 路径命中；同一个 id 只保留优先级最高的一条。

【核心层 · 每轮生效】
▌ 用户级 · ...\home\rules\common.md（核心层，每轮生效；id: 通用纪律）
提交前跑类型检查；不确定就说不确定，不要编。

▌ 项目级 · .dsh/rules/core.md（核心层，每轮生效；id: 本项目纪律）
这个仓库只跑 node 内置模块，禁新依赖。
</path-rules>
```

**读了 `src/App.tsx` 之后**——路径层补进来，且同 id 的**项目级**路径规则赢了**用户级**那条：

```
<path-rules>
以下是本轮生效的规则，优先级从低到高：用户级 < 项目级 < 路径命中；同一个 id 只保留优先级最高的一条。

【核心层 · 每轮生效】
▌ 用户级 · ...\home\rules\common.md（核心层，每轮生效；id: 通用纪律）
提交前跑类型检查；不确定就说不确定，不要编。

▌ 项目级 · .dsh/rules/core.md（核心层，每轮生效；id: 本项目纪律）
这个仓库只跑 node 内置模块，禁新依赖。

【路径层 · 触及匹配文件后生效】
▌ 项目级 · .dsh/rules/frontend.md（路径命中，匹配 src/**/*.tsx；id: 前端）
本项目前端：组件放 src/components，一律函数组件。
</path-rules>
```

用户级 `frontend.md` 的内容没有出现：它被同 id 的项目级规则按优先级覆盖了。

## 六、诊断：`path_rules_status`

只读、不注入，专门回答"到底哪几条在生效、为什么"。
统一契约（v1.0.1，2026-11-01）：返回值必带 `ready` 与 `unavailableReason`（空串=可用），两者都在 `required` 里；`ready` 为真判断——只要有**一个**规则目录 `readdirSync` 成功即为 `true`，全都读不动则 `ready:false` 且渲染只输出「不可用：<原因>」。本轮验证：项目级+用户级目录都可读 → `ready:true`；两个目录都不存在 → `ready:false` + 「不可用：规则目录都不可读（…）」。

```
路径规则：共扫到 4 条，当前生效 3 条
- 用户级：扫到 2 条，生效 1 条
- 项目级：扫到 2 条，生效 2 条
- 核心层：扫到 2 条，生效 2 条
预算：核心层 2000 字符（已用 198，截断 0 条，未展开 0 条）
　　　路径层 3000 字符（已用 92，截断 0 条，未展开 0 条）
✓ ...\project\.dsh\rules —— 2 条
✓ ...\home\rules —— 2 条
生效中的规则（优先级从低到高）：
1. 用户级 · ...\home\rules\common.md（核心层，22 字符）
2. 项目级 · ...\project\.dsh\rules\core.md（核心层，22 字符）
3. 项目级 · ...\project\.dsh\rules\frontend.md（路径命中，匹配 src/**/*.tsx，32 字符）
本次运行命中过 2 条路径规则（含同 id 被覆盖的）
```

返回字段（schema）分两类：

- **v1 原有字段，一个不少**：`ruleDirs`（`dir / exists / rules`）、`totalRules`、`triggeredRules`（`file / source / paths / chars`）、`maxChars`。
- **v2 新增**：`enabled`、`maxAlwaysChars`、`layers`（`layer / scanned / active`，固定三行：用户级 / 项目级 / 核心层）、`alwaysBudget` 与 `pathBudget`（`maxChars / usedChars / rules / omitted / truncated`）、`activeRules`（`file / source / activation / id / priority / chars / paths`）。

v2 的两处口径变化（只影响诊断，不影响规则文件）：

1. `source` 的值从 v1 的 `用户` / `项目` 统一成 `用户级` / `项目级`；
2. `triggeredRules` 只记"路径规则命中过"，`always` 规则不计入（它们不是被触发的，是每轮都在）。
## 七、配置

```yaml
- insert:
    - id: path-rules
      name: '@local/dsh-path-rules'
      config:
        enabled: true          # 总开关；false = 完全不注入、不注册工具
        maxChars: 3000         # 路径层预算（v1 的名字，保持不变）
        maxAlwaysChars: 2000   # 核心层预算（v2 新增）
```

## 八、已知边界（刻意不做的事）

- **不跟踪 shell 命令里提到的文件**：只看结构化工具参数（`file_path / filePath / path`），`pwsh` 里 `type foo.ts` 不会触发；
- **规则目录只扫一层**，不递归子目录；
- **不跟踪没有路径参数的工具**（如 `web_fetch`），也不做语义匹配；
- **路径规则一次触发后在本会话内保持活跃**，不会自动退出（行为可预期比"智能退出"重要）；
- **会话工作目录还没拿到时不注入任何规则**（v2 行为变化：v1 在拿不到 cwd 时用进程 cwd 兜底，可能扫错项目的规则目录）；
- **同 id 打平（同层、同生效方式）时先扫到者胜**，扫描顺序是项目级 → 用户级；
- 只注入提示，不替你去执行规则；规则文件按 mtime 缓存，改了下次渲染就重读，但已注入的当轮内容不会中途撤回。

## 九、真实验证记录（2026-10-30，本机 Windows）

### 9.1 语法门

```
node --check D:\AI\dsh-bundles\dsh-path-rules\index.js
# 无输出 = 通过
```

### 9.2 行为测试（25 项全过，退出码 0）

```
node D:\AI\dsh-bundles\_selftest\tests\path-rules.test.mjs
```

关键输出：

```
  ✓ 结构合规、apply 可挂载
  ✓ block 风格 paths 解析
  ✓ inline 数组风格 paths 解析
  ✓ 非法规则文件静默跳过，不抛错
  ✓ glob：** 跨目录、* 单层、? 单字符、{a,b} 分支
  ✓ Windows 分隔符与绝对路径都能归一化
  ✓ 触及匹配文件才注入规则
  ✓ 一次触发后在本会话内保持
  ✓ 规则按会话隔离，不串台
  ✓ status 基于会话工作目录，且只统计有效规则
  ✓ always 支持 true/yes/on/1，false/no/off/0 不算
  ✓ id 解析：显式 id 优先，缺省用文件路径
  ✓ frontmatter 忽略未知键、大小写不敏感
  ✓ 优先级：用户级 < 项目级 < 路径命中
  ✓ 同 id 去重：项目级覆盖用户级、路径命中覆盖更泛的层
  ✓ 注入文本标明来源层/生效方式，并把高优先级排在后面
  ✓ 核心层 400 / 路径层 500 各自截断，互不吃预算，并写明原因
  ✓ 默认预算：核心层 2000、路径层 3000，空规则不注入
  ✓ 端到端：always 装配即注入，路径规则触碰后才注入
  ✓ status 原有字段保留（ruleDirs / totalRules / triggeredRules / maxChars）
  ✓ status 新字段：分层扫描/生效、每条来源层与优先级、两份预算用量
  ✓ 端到端：项目级 always 覆盖用户级 always
  ✓ 端到端：路径命中覆盖用户级
  ✓ 老规则文件不改也照旧工作（只多一层层级标注）
  ✓ enabled 开关生效，maxChars / maxAlwaysChars 从 config 读

path-rules: 25 项通过
```

其中前 10 项是 v1 的原有关断，v2 全部保留（没有削弱，只加新项）。

### 9.3 真实模块 + 真实规则目录的渲染验证

用一次性脚本（真实临时项目目录 + 真实 import 插件入口 + mock ctx 喂 `tools/post-execute`），打印两次装配结果和 `path_rules_status`——第五节和第六节贴的那两段输出，逐字来自这次运行。脚本跑完已删除（一次性产物不留）。

这次运行证实了三件事：① `always` 规则在**没有任何工具调用之前**就进了系统提示；② 路径规则在读到 `src/App.tsx` 之前不出现；③ 同 id 的 `前端` 规则只有项目级那条进了提示。

### 9.4 说明：本机尚未装机验证

本插件是并行开发的一条，**没有在这台 DSH 里安装**（安装与全量验证门由集成方统一做）。所以第 9.3 节的渲染输出是模块级的真实调用，不等于"装进 DSH 后在真实会话里看到了 path-rules 块"。装机后需要补一条：新开会话、写一条 `always: true` 规则、看系统提示里是否出现核心层；再读一个匹配 `paths` 的文件、看路径层是否补进来。

### 9.5 统一契约验证（2026-11-01，v1.0.1）

`path_rules_status` 加 `ready` / `unavailableReason` 后重跑：`node --check` 通过、`_selftest/tests/path-rules.test.mjs` **25 项全过**（含第 364–365 行「返回字段与 schema 完全一致 / required 覆盖全部字段」）；真实模块验证两条路径——项目级+用户级规则目录都可读 → `ready:true` 照常输出，两个目录都不存在 → `ready:false` 且首行「不可用：规则目录都不可读（…）」。

### 9.6 v1 的历史验证（2026-10-29，作为背景）

v1（0.1.0）当时装进本机 profile 做过真实验证，并借此抓到一个单测抓不到的 bug：`path_rules_status` 原来用 `process.cwd()`（= profile 目录）算规则目录，诊断显示成 `C:\Users\...\profiles\desktop\.dsh\rules`。修法是从工具执行的 `exec.agent.session` 直接取会话工作目录。v2 保留了这个修法，并把"拿不到 cwd 就不注入"写成明确行为（见第八节）。

## 十、装 / 卸（交给集成方）

安装（由集成方执行，本插件作者没动本机 profile）：

1. `C:\Users\<user>\.dsh\profiles\desktop\package.json` 的 `dependencies` 加 `"@local/dsh-path-rules": "link:D:/AI/dsh-bundles/dsh-path-rules"`；
2. `dsh.profile.bundles` 加 `@local/dsh-path-rules`；
3. `pnpm install` 建 Junction；
4. 用 `remove_bundle` + `install_bundle` 重载（热替换不换 JS 模块代际），重启 DSH。

卸载：从 `dependencies` 和 `dsh.profile.bundles` 删掉，`pnpm install`，重启。

## 十一、文件清单

```
dsh-path-rules/
  index.js            # 入口：apply + 纯函数（parseFrontmatter / parseRule / rulePriority / dedupeById / fitBudget / composeInjection）
  cordis.patch.yml    # 默认配置（enabled / maxChars / maxAlwaysChars）
  package.json        # type: module、node >= 22.19、dsh.bundle.patch、v1.0.0
  locale/zh.json
  locale/en.json
  icon.svg
  README.md
```

只依赖 node 内置模块（`node:fs` / `node:path` / `node:os`），无第三方依赖。

## 十二、纯函数索引（给测试用）

| 函数 | 干什么 |
|---|---|
| `parseFrontmatter(source)` | 解析 frontmatter：`paths / always / id`，未知键忽略 |
| `parseBoolFlag(value)` | `true/yes/on/1` 为真，其余为假 |
| `parseRule(text)` | 规则文件 → `{paths, body, always, id, regexps}`；不合法返回 null |
| `createRule({file, layer, sourceText})` | 规则文件 + 层 → 规则对象（id 缺省用文件路径） |
| `rulePriority(rule, activation)` | 优先级数字：路径命中 > 项目级 > 用户级 |
| `dedupeById(entries)` | 同 id 只留优先级最高的一条 |
| `fitBudget(items, budget)` | 按预算装填一层：整装 / 截断 / 跳过，各自计数 |
| `composeInjection(entries, options)` | 纯函数拼出注入文本 + 两份预算记账 + 生效清单 |
| `expandBraces / globToRegExp / ruleMatches / normalizePath` | glob 与路径归一化（v1 原有） |
