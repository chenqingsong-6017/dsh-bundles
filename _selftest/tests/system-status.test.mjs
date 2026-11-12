// dsh-system-status 回归：工具契约完整 + 不可用时如实报 + 真实工作区能出 rows。
import assert from 'node:assert/strict'
import { apply } from '../../dsh-system-status/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}

function host(cfg) {
  const defs = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    get: () => undefined,
  }
  apply(ctx, cfg)
  return defs
}

// 1) 工具契约：name/execute/output.schema/render 一个都不能少（gate 工具契约门会查这个）
{
  const defs = host({})
  const tool = defs.get('system_status')
  assert.ok(tool, '必须注册名为 system_status 的工具')
  assert.equal(typeof tool.execute, 'function', 'execute 必须是函数')
  assert.ok(tool.output?.schema, '必须有 output.schema')
  assert.equal(typeof tool.output?.render, 'function', '必须有 render')
  assert.equal(tool.parameters?.additionalProperties, false, '参数要闭合')
  ok('工具定义完整（schema + render + 闭合参数）')
}

// 2) render 必须返回 content 数组（v0.1.0 真机踩过：返回裸字符串 → content.some is not a function）
{
  const defs = host({})
  const rendered = defs.get('system_status').output.render({}, {
    ok: true,
    failed: 1,
    total: 2,
    durationMs: 3,
    rows: [
      { layer: 'L1', name: '通过项', ok: true, note: '' },
      { layer: 'L6', name: '未过项', ok: false, note: '示例' },
    ],
  })
  assert.ok(Array.isArray(rendered), 'render 必须返回数组')
  assert.equal(rendered[0]?.type, 'text', '首元素必须是 text part')
  assert.match(String(rendered[0]?.text ?? ''), /1 项未过/, '要概括未过项数量')
  ok('render 返回 content 数组（防 content.some 崩溃）')
}

// 3) 找不到体检脚本时必须 ok:false + unavailableReason，绝不报「全部正常」
{
  const defs = host({ workspaceDir: 'C:\\Windows\\Temp' })
  const result = await defs.get('system_status').execute({})
  assert.equal(result.ok, false, '没脚本时必须报不可用')
  assert.match(String(result.unavailableReason ?? ''), /没有体系体检脚本/, '要说明是找不到脚本')
  assert.equal(result.rows.length, 0)
  ok('找不到脚本时明确报不可用（不粉饰）')
}

// 3) 真实工作区：能拿到 rows，total 与 rows 长度一致
{
  const defs = host({ workspaceDir: 'D:/AI-date/dsh-date/dsh-创建' })
  const result = await defs.get('system_status').execute({})
  assert.equal(result.ok, true, String(result.unavailableReason ?? ''))
  assert.ok(Array.isArray(result.rows) && result.rows.length > 0, '要返回体检行')
  assert.equal(result.total, result.rows.length)
  assert.ok(result.rows.every((r) => typeof r.layer === 'string' && typeof r.name === 'string'))
  ok('真实工作区能出结构化 rows')
}

console.log(`system-status: ${passed} 项通过`)
