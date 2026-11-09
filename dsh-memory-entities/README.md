# dsh-memory-entities —— 零模型实体共现图

独立插件：读 dsh-memory 的 memory.db（只读），查实体出现在哪些记忆、与谁共现。
职责单一，不依赖 dsh-memory 运行时；数据唯一真源是 memory.db。

## 工具
- `memory_entities {entity}`：返回提到该实体的记忆 + 共现实体（按次数排序）。

## 设计（整体强）
- 单个强：只做实体共现，零模型、零写、零依赖；
- 整体强：与 dsh-memory（核心记忆）/ dsh-obsidian（冷库）靠同一份 memory.db 协同，互不拖累。
