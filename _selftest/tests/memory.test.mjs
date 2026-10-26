import assert from 'node:assert/strict'
import { renderMemory, scoreMemory } from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- v1.0 行为（全量渲染，不传 options）----
assert.equal(renderMemory([]), '')
assert.equal(renderMemory(undefined), '')
ok('空记忆不注入')

const block = renderMemory([
  { id: 'm1', text: '用户要求回答用中文' },
  { id: 'm2', text: '插件都放 D 盘' },
])
assert.ok(block.startsWith('<memory>'))
assert.ok(block.endsWith('</memory>'))
assert.ok(block.includes('- 用户要求回答用中文'))
assert.ok(block.includes('- 插件都放 D 盘'))
ok('非空记忆渲染成 <memory> 块且逐条列出')

const ordered = renderMemory([{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }])
assert.ok(ordered.indexOf('first') < ordered.indexOf('second'))
ok('保持写入顺序（越靠后越新）')

// ---- v1.1 分层注入 ----
const pinnedEntry = { id: 'p1', text: 'PINNED-HARD-RULE', pinned: true }
const bulk = Array.from({ length: 12 }, (_, i) => ({
  id: `b${i}`,
  text: `记忆条目内容 ${i} ${'填充'.repeat(12)}`,
}))

const layered = renderMemory([...bulk, pinnedEntry], { maxInjectChars: 260 })
assert.ok(layered.includes('PINNED-HARD-RULE'), 'pinned 条目必须全文注入')
assert.ok(layered.includes('📌'), 'pinned 条目带置顶标记')
ok('分层注入：pinned 优先全文')

const indexLines = layered.split('\n').filter((line) => /^- \(\w+\)/.test(line))
assert.ok(indexLines.length > 0, '预算不够时应出现索引行')
assert.ok(layered.includes('memory_search'), '索引提示要引导用 memory_search 取全文')
ok('分层注入：装不下的条目降级成索引行')

assert.ok(layered.includes('记忆条目内容 11'), '最新的非 pinned 条目应优先拿到全文')
ok('分层注入：其余条目按从新到旧分配')

assert.ok(layered.length < 700, `分层后总长应受控（实际 ${layered.length}）`)
ok('分层注入：总长度远小于全量渲染')

const allLines = renderMemory([...bulk, pinnedEntry])
assert.ok(allLines.length > layered.length, '全量渲染应比分层渲染长')
assert.equal(allLines.split('\n').filter((line) => /^- \(\w+\)/.test(line)).length, 0, '全量模式不产生索引行')
ok('不传 maxInjectChars 时保持全量渲染（向后兼容）')

// ---- 检索打分 ----
const sample = { id: 'm1', text: '用户要求：所有回答用中文', tag: 'preference' }
assert.ok(scoreMemory(sample, '中文') > 0, '子串命中要有分')
assert.ok(scoreMemory(sample, '中文') > scoreMemory(sample, 'php'), '命中的分高于不命中')
assert.equal(scoreMemory(sample, '完全不存在的词xyz'), 0)
assert.equal(scoreMemory(sample, '   '), 0, '空 query 得 0 分')
assert.ok(scoreMemory(sample, 'preference') > 0, 'tag 也参与检索')
ok('scoreMemory：子串优先、tag 参与、空查询为 0')

console.log(`memory: ${passed} 项通过`)
