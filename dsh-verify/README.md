# dsh-verify —— 改完自检

DSH bundle（Host 侧插件）：识别并运行项目自己的检查命令（测试 / lint / 类型检查），返回**人话结论 + 失败片段**。

- **学谁**：Aider / Cline 的"改完跑测试"闭环，以及 CI 的"检查先于交付"习惯。
- **没做成什么样**：不做"每次编辑后自动跑"——那会让每一步都变慢、输出还吵（UX 优先）。做成**按需工具**，agent 改完自己调。

- **安装位置**：`D:\AI\dsh-bundles\dsh-verify`
- **生效范围**：desktop profile，所有会话/工作目录

## 工具

| 工具 | 作用 |
|---|---|
| `verify` | 跑检查：`kind` = `auto`（默认）/ `test` / `lint` / `typecheck` / `check` / `custom` |
| `verify_status` | 看这个工作区"将执行什么"、可用 scripts、上限、上次结果 |

## 识别顺序

1. bundle patch 的 `customCommand`（字符串走 shell，数组直接 argv）
2. `package.json` 的 `scripts`：按 `test` → `lint` → `typecheck` → `check` 取第一个存在的；包管理器由锁文件判断（`pnpm-lock.yaml` → pnpm，`yarn.lock` → yarn，否则 npm）
3. `go.mod` → `go test ./...`；`Cargo.toml` → `cargo test`
4. `pyproject.toml` / `pytest.ini` / `tests` 目录 → `python -m pytest -q`
5. `*.sln` → `dotnet test`
6. 都没有 → 明确说"没检测到"，并提示怎么配 `customCommand`

## 配置

```yaml
- insert:
    - id: verify
      name: '@local/dsh-verify'
      config:
        timeoutMs: 300000        # 超时先 terminate 再报告
        maxOutputLines: 40       # 主输出最多展示多少行失败信息
        # customCommand: 'npm run test:unit'   # 可选：覆盖自动识别（字符串走 shell）
```

## 输出长什么样（UX）

通过：
```
✓ 检查通过：npm run test（0.5s，输出 3 行）
```

失败：
```
✗ 检查失败：npm run test（exit 1，1.7s）
  node:internal/assert/utils:146
    throw error;
  AssertionError [ERR_ASSERTION]: expected 2 but got 1+1=2
    code: 'ERR_ASSERTION',
    expected: 3,
… 另有 18 行未显示（完整输出可在项目目录重跑该命令）
修好上面这些失败后再跑一次 verify；完整输出可在项目目录手动重跑该命令。
```

没检测到：
```
没检测到可运行的检查命令（D:\...\some-dir）。
没有检测到可运行的检查命令。可以在 bundle patch 里配 customCommand，或先给项目加 test/lint 脚本。
```

失败行挑选逻辑：优先取含 `error/fail/assert/expected/panic` 的行，没有就取最后 N 行；总数超过 `maxOutputLines` 时说明省略了多少。

## 验证记录（2026-10-25，本机 desktop profile）

| 场景 | 结果 |
|---|---|
| 失败项目（`assert.strictEqual(1+1,3)`） | 返回 `✗ 检查失败：npm run test（exit 1）` + AssertionError 行 + "另有 18 行未显示" ✅ |
| 修好后重跑 | `✓ 检查通过：npm run test（0.5s，输出 3 行）` ✅ |
| `verify_status` | 显示将执行 `npm run test`、包管理器 npm、可用 scripts `test`、上次结果/耗时/时间 ✅ |
| `kind=lint`（项目没有 lint 脚本） | 明确返回"没检测到"，没有瞎猜命令 ✅ |
| 不存在的目录 | 返回"没检测到"，不抛异常 ✅ |

## 验证记录补充（2026-10-26，工作目录解析修复）

| 场景 | 结果 |
|---|---|
| 修复前 | 不带 `path` 调 `verify_status`，报的工作区是 `C:\Users\...\.dsh\profiles\desktop`（Host 的 `process.cwd()`），是假路径 |
| 修复后 | 解析顺序改为 `get(session)` → `ensure(agent)` → 明确报未解析；`verify_status` 输出 `（未解析）` 并附 ⚠ 提示要求传 `path`，不再显示 profile 目录 ✅ |
| 回归 | `node --check` 通过；`verify.test.mjs` 7 项全过；`schema-check.mjs dsh-verify` 2 个工具 PASS（新增可选 `notice` 字段）✅ |

## 剩下的边界

- **命令以宿主进程权限运行**，没有经过 fs 沙箱（用的是 `ctx.subprocess`，不是 shell 工具的沙箱路径）；在只读/受限会话里新增 `customCommand` 要谨慎；
- 不做"编辑后自动跑"（有意）：需要时由 agent 调 `verify`；
- 只识别常见项目文件；特殊项目用 `customCommand` 覆盖；
- 输出采集上限 256 KiB，超出部分丢弃（`verify_status` 里会体现退出码，但看不到完整输出）；
- **会话工作目录解析**（v1.0.1 修）：优先 `workingDirectory.get(session)`（同步、无 fs I/O）→ 失败再 `ensure(agent)`（校验/恢复目录）→ 两者都失败时**不去猜** `process.cwd()`，而是明确报"未取到会话工作目录"并请你传 `path`。桌面版 Host 的 `process.cwd()` 是 profile 目录，以前静默拿它冒充工作区，会让 `verify` 在错误目录跑检查、让 `verify_status` 显示假路径。
