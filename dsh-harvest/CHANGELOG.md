# CHANGELOG

## 0.1.0 — 2026-11-03

- 首个版本：读本机会话（session.v4.jsonl.zstd）→ 规则抽取候选（规则/纠正/偏好）→ 带证据写 JSONL。
- 幂等：按会话文件 mtime + state 跳过已处理会话。
- 删除闸门：harvest_gate 校验要删的会话是否都被 harvest 覆盖过。
- 只写候选，不自动写 memory；零第三方依赖；数据落 D:\AI\dsh-data\harvest。
- 测试：core / plugin / edge 三套自检全绿。
