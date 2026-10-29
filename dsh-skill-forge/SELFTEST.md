# 自测记录 · dsh-skill-forge v0.1.0

日期：2026-10-29
环境：Node v26.12.1 / Windows 11 25H2

## 一、语法与单元测试

```
node --check index.js          → OK
node tests/skill-forge.test.mjs → 20 项全过
```

覆盖项：

- 名字规则：大写/下划线被拒、超长被拒、kebab-case 通过
- 描述规则：>60 字符被拒、无句号被拒、合规通过
- 正文规则：缺「## 验证」被拒且理由明确
- frontmatter 往返（描述含冒号也能正确读回）
- `apply()` 注册 3 个工具 + 1 个技能 provider
- 锻造落盘、provider 列表元数据（rank=700 / source=forged / invocation 双可调用）
- `provider.get` 返回去 frontmatter 正文，并剥掉 rank/locator 内部字段
- 关键词检索命中与不误报
- 重名未 overwrite 被拒并提示解法
- overwrite 时旧版归档（不删除）
- `_archive` 不参与目录收集
- `skill_forge_retire` 后技能退出目录、文件仍在

## 二、端到端锻造（首个技能）

```
node _selftest/forge-first-skill.mjs
→ D:\AI\dsh-data\skills\windows\nvidia-driver-upgrade\SKILL.md
→ provider.list() 返回 1 条：nvidia-driver-upgrade | rank 700 | 升级 NVIDIA 显卡驱动并保留回滚路径。
```

## 三、安装接线

- profile 依赖与 bundles 已加入 `@local/dsh-skill-forge`
- `node_modules\@local\dsh-skill-forge` → junction 指向 `D:\AI\dsh-bundles\dsh-skill-forge`
- `node -e "import('@local/dsh-skill-forge')"` 解析成功（导出 apply/inject/name + 三个纯函数）

## 四、待验证（需重启后）

- [ ] 重启 DSH 后 `skill_forge` / `skill_forge_search` / `skill_forge_retire` 三个工具出现
- [ ] `nvidia-driver-upgrade` 出现在技能索引中，可用 `/nvidia-driver-upgrade` 或 `skill` 工具加载
- [ ] 锻造第二个技能后，无需重启即可被 `skill_forge_search` 找到（目录收集缓存可能延迟进提示）
