import assert from 'node:assert/strict'
import { renderMemory } from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

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

console.log(`memory: ${passed} 项通过`)
