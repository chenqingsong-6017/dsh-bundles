import assert from 'node:assert/strict'
import { diffTextLines, buildHunks } from '../../dsh-checkpoint/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const same = diffTextLines('a\nb\nc', 'a\nb\nc')
assert.equal(same.added, 0)
assert.equal(same.removed, 0)
ok('相同文本无变化')

const changed = diffTextLines('a\nb\nc', 'a\nB\nc')
assert.equal(changed.added, 1)
assert.equal(changed.removed, 1)
assert.equal(changed.ops.map((op) => `${op.op}:${op.text}`).join('|'), 'keep:a|del:b|add:B|keep:c')
ok('单行替换 = 1 增 1 删，上下文保留')

assert.equal(diffTextLines('a\nb', 'a\nb\nc').added, 1)
ok('追加一行')

assert.equal(diffTextLines('a\nb\nc', '').removed, 3)
ok('回滚到空 = 全部删除')

assert.equal(diffTextLines('x\n'.repeat(700), 'y\n').truncated, true)
ok('超长文本退化为统计')

const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`)
const after = [...lines]
after[5] = 'line-6-changed'
const hunks = buildHunks(diffTextLines(lines.join('\n'), after.join('\n')).ops)
assert.equal(hunks.length, 1)
assert.equal(hunks[0].oldStart, 4)
assert.equal(hunks[0].lines.map((line) => line.op).join(','), 'context,context,del,add,context,context')
ok('单个改动折成一个 hunk（2 行上下文 + 改动对）')

const after2 = [...lines]
after2[0] = 'line-1-changed'
after2[9] = 'line-10-changed'
assert.equal(buildHunks(diffTextLines(lines.join('\n'), after2.join('\n')).ops).length, 2)
ok('相距远的改动拆成两个 hunk')

console.log(`checkpoint: ${passed} 项通过`)
