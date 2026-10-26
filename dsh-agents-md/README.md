# dsh-agents-md —— 重新启用 AGENTS.md / CLAUDE.md 加载

纯配置 bundle（没有 `index.js`）：只改 profile 里一条官方插件行的开关。

## 背景

`@deepseek-ai/dsh-agent-instructions` 是官方包，`dsh-base` 默认挂着（65 KB 预算），但当前 profile 的 preset 层把它 `disabled: true` 关掉了——结果是**你写的 AGENTS.md / CLAUDE.md 不会被读到**。

本 bundle 排在 profile bundle 列表末尾，按"后写赢"把它覆盖回：

```yaml
- id: agent-instructions
  disabled: false
  config:
    maxBytes: 65536
```

## 生效范围

- 用户级：`$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md`（默认 `~/.agents`）
- 项目级：从 `.git` 根（没有 `.git` 时退回 cwd）一路到会话工作目录，逐层 `AGENTS.md` / `CLAUDE.md`
- 叠加：`AGENTS.local.md` / `CLAUDE.local.md`
- 预算：整条基线最多 65536 字节，超出先丢宽泛文件、最后才截断最具体的

## 验证记录（2026-10-25）

| 场景 | 结果 |
|---|---|
| 启用后写 `~/.dsh/AGENTS.md`（测试标记） | 下一轮请求的 workspace instructions 里出现了该内容 ✅ |
| 删除该文件 | 系统提示 "Instructions removed" ✅ |
| 工作区级 `AGENTS.md`（无 `.git`） | 同样被加载（项目根回退到 cwd）✅ |

## 备注

- 纯配置 bundle 不需要 `index.js`，`package.json` 只声明 `dsh.bundle.patch` + locale/icon 导出；
- 关闭方式：`plugin_manager remove_bundle target=@local/dsh-agents-md`（把行恢复成 preset 的关闭状态）。
