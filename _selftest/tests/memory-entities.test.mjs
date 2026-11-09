import assert from 'node:assert/strict'
import { queryEntity } from '../../dsh-memory-entities/index.js'

// 零模型实体共现图：queryEntity 纯函数
{
  const r = queryEntity([
    { id: 'a', text: 't', entities: ['Obsidian', '记忆'] },
    { id: 'b', text: 't2', entities: ['Obsidian', '插件'] },
    { id: 'c', text: 't3', entities: ['DSH'] },
  ], 'Obsidian')
  assert.equal(r.count, 2, '命中 2 条')
  assert.equal(r.cooccurring.length, 2, '共现 2 个实体')
  assert.equal(r.cooccurring[0].entity, '记忆', '共现按次数排序')
}
{
  assert.equal(queryEntity([{ id: 'x', text: 't', entities: ['DSH-Memory'] }], 'dsh-memory').count, 1, '大小写不敏感')
  assert.equal(queryEntity([], '').count, 0, '空实体')
  assert.equal(queryEntity([{ id: 'x', text: 't' }], 'Obsidian').count, 0, '无 entities 的条目')
}
console.log('memory-entities: 通过')
