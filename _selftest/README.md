# _selftest —— 插件开发期自检

不属于任何 bundle，不会被 `plugin_manager` 安装；只是本地开发脚本 + 测试夹具。

## selfcheck.ps1（一条命令跑全栈自检）

```powershell
pwsh -NoProfile -File D:\AI\dsh-bundles\_selftest\selfcheck.ps1
pwsh -NoProfile -File ...\selfcheck.ps1 -SkipTests    # 跳过单测，只跑结构/manifest/schema
```

检查五层，退出码非 0 表示有失败：

1. **结构与清单**（每个 bundle）：`package.json` 可解析、声明 `dsh.bundle.patch`、patch 有 insert 或覆盖行、`index.js` 语法（纯配置 bundle 自动跳过）、严格清单里还要求 `locale/en+zh`、`icon.svg`（<256 KiB 且是 SVG）、`README.md`；
2. **工具输出 schema**：调 `schema-check.mjs`（见下），25 个工具全覆盖；
3. **单元测试**：跑 `tests/*.test.mjs`（checkpoint 的 diff/hunk、repomap 的符号抽取、skill-usage 的陈旧判定、memory 的渲染、verify 的项目识别、usage 的日志解析、audit 的危险分级与脱敏、notify 的触发规则与通知脚本）；
4. **profile 安装一致性**：bundle 在 `dsh.profile.bundles` 里、依赖是 `link:<bundle 目录>`、`node_modules` 里的链接确实指向同一个目录。
5. **pre-execute 装配顺序**：`checkpoint → hooks → auto-approve` 的相对顺序必须保持（`_selftest/assembly-order.mjs`）；反序会让 harness 的 waterfall 早停，安全语义退化。顺序的理由与证伪方式见仓库根 [README.md](../README.md)「pre-execute 拦截链顺序」。

当前结果：**345 项检查全部通过**（2026-11-02 21:55 实测；基线为 328，本轮新增装配顺序/锚点/护栏合并/write-scope 等用例。项数会随用例增长，以 `selfcheck.ps1` 末行实际输出为准）。

## schema-check.mjs

```powershell
node D:\AI\dsh-bundles\_selftest\schema-check.mjs            # 扫全部 bundle
node D:\AI\dsh-bundles\_selftest\schema-check.mjs <bundle目录>  # 只查指定目录（夹具测试用）
```

它做什么：

1. 用**假 ctx** 加载每个 bundle 的 `apply()`，拿到真实工具定义（render 闭包可用）；
2. 逐个检查 `output.schema` 结构：
   - `type` 合法（object/array/string/number/integer/boolean/null）
   - `required` 里的字段必须在 `properties` 里
   - `type: array` 必须有 `items`
   - `enum` 非空且取值与 `type` 一致
   - `additionalProperties` 必须是布尔
   - 不认识的 schema 关键字直接报（防止拼错字段名）
3. `output.render` 冒烟：按 schema **自动生成样例值**喂进去，必须返回 `{type:'text',text}[]`；
4. 没有 `output` / 没有 `render` / `execute` 不是函数 —— 直接失败。

退出码：全过 0，有问题 1（可以接进任何脚本）。

### 为什么值得有

DSH 的工具输出 schema 是**严格校验**的（`additionalProperties:false`）。返回值多一个字段、少一个 required、类型是 float 而声明 integer，整次工具调用都会失败：

```
tool "x" returned invalid output: "value.y" must be an integer
```

这一轮为此白跑了好几轮 remove/install/admin。这个脚本把能静态发现的问题提前到提交前——上面那几类现在一次就能拦住。

### 局限（明确写出来）

- **查不到 execute 的真实返回值**：它只验证 schema 本身 + render 用样例值不炸；"execute 返回了 schema 没声明的字段"仍然要真调用才能发现（那是 `verify` / e2e 的活）；
- 假 ctx 只提供 `tools/effect/on/get/systemPrompt` 等最小表面，需要更多服务的插件会在 apply 阶段报错——那属于夹具需要扩展，不是插件 bug（`dsh-staleness-watch` 因为只用 `tools.guard` 且不注册工具，会显示 SKIP）。

### fixtures/bad-bundle

故意写坏的样例（enum 类型不符、array 缺 items、required 漏声明、未知关键字、render 形状错）。用来证明检查器真的会失败，而不是永远绿：

```
FAIL bad-bundle/bad_tool
       - output.schema: required 里的 "missingField" 不在 properties 中
       - output.schema: additionalProperties 必须是布尔
       - output.schema.kind: enum 取值与 type=integer 不符
       - output.schema.list: type=array 但缺 items
       - output.schema.weird: 未知 schema 关键字 "nonsense"
       - render 返回的块不是 {type:"text",text}
```

## 当前结果（2026-10-26）

```
25 个工具全部 PASS；staleness-watch SKIP（不注册工具）
```

（2026-10-26：memory 4→5、checkpoint 5→6，新增 dsh-usage 2 个、dsh-audit 3 个、dsh-notify 2 个工具；repomap/skill-usage/verify 不变。）
