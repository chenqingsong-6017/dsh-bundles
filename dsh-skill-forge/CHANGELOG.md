# CHANGELOG — dsh-skill-forge

本文件于 2026-10-31 按「改到谁补谁」的规则建立；v0.1.0 为存量版本补记。

## v0.1.1 — 2026-10-31

### Added
- 补 `locale/zh.json`、`locale/en.json`（meta.title + meta.description）与 `icon.svg`，并在 `package.json` 的 `exports` / `files` 中导出 —— 按本工作区 AGENTS 交付标准，此前缺这三项（`standard-check` 不查此项，故长期未暴露）。

### Verification
- `standard-check.mjs` 19/19 合规；`plugin-smoke` 的 locale/icon 检查通过；验证门通过。

## v0.1.0（补记于 2026-10-31）

### Added
- `skill_forge`：把刚完成的工作锻造成 `SKILL.md`（kebab-case 名称、≤60 字符描述、强制「何时用 / 步骤 / 验证」三节），注册进 DSH 原生技能目录。
- `skill_forge_search`：按名称 / 描述 / 正文关键词搜索已锻造技能。
- `skill_forge_retire`：退役到 `_archive`，不物理删除。
- 不做模型调用（离线、可复现）。
