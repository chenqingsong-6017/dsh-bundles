# 第三方 / 独立仓 bundle（不进外层 git）

外层 `D:\AI\dsh-bundles` 的 git 只跟踪**自研**插件。下列目录来自外部，已被 `.gitignore:12` 排除；
它们各自是独立 git 仓，**升级与回滚各自由它们自己负责**：外层 git 不备份、不回滚、也不替它们提交。

## dsh-plugin-eva-theme（EVA 主题）

| 项 | 值（2026-11-02 实查） |
|---|---|
| 来源 | https://github.com/seaison/dsh-plugin-eva-theme |
| 许可证 | MIT（该目录 `LICENSE`） |
| 当前版本 | `0.51.2`，commit `f8b9638` |
| 外层 git | 不跟踪：`.gitignore:12` 的 `dsh-plugin-eva-theme/` |
| 外层仓里与它有关的只有 | `_selftest/tests/plugin-eva-theme.test.mjs`（外层回归，跟自研插件一起跑） |

### 升级（在它自己的仓里做）

```powershell
git -C D:\AI\dsh-bundles\dsh-plugin-eva-theme status   # 先看有没有本地改动
git -C D:\AI\dsh-bundles\dsh-plugin-eva-theme stash    # 有本地改动先存（见下方注意）
git -C D:\AI\dsh-bundles\dsh-plugin-eva-theme pull --ff-only
```

### 回滚（同样在它自己的仓里做）

```powershell
git -C D:\AI\dsh-bundles\dsh-plugin-eva-theme log --oneline -5
git -C D:\AI\dsh-bundles\dsh-plugin-eva-theme reset --hard <升级前的 sha>
```

### 注意（实测）

- **它的工作区现在就不干净**：2026-11-02 实查 `git status` 为 `M package.json`、`?? icon.svg`、`?? locale/`
  （本机补的 DSH 所需文件）。直接 `pull --ff-only` 可能被拒，先 stash 或先把它提交到本地分支，否则升级会卡在这里。
- 外层 `git status` 看不到它的改动——**别拿「外层干净」当成「它没改」**。
- 外层验证门只跑 `_selftest/tests/plugin-eva-theme.test.mjs` 和结构门（package.json / patch / 入口），
  **不跑它自带的 `npm test`**（那套要浏览器与 Node 22+）。升级后要真机切一次暗色/亮色看主题，结构门过 ≠ 界面没坏。
