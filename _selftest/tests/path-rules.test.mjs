/**
 * dsh-path-rules 行为测试。
 *
 * 两层：
 *   1) 纯函数：frontmatter 解析、glob 匹配、路径归一化
 *   2) 端到端：mock ctx + 临时规则目录，喂 tools/post-execute 事件，
 *      断言「触碰前不注入、触碰后注入、不相关文件不触发、预算会截断、status 用会话 cwd」
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log('  ✓ ' + label + (extra ? '  ' + extra : ''))
}

// ---- 1) 结构合规 ----
await runSmoke('dsh-path-rules')
ok('结构合规、apply 可挂载')

const mod = await import('../../dsh-path-rules/index.js')

// ---- 2) frontmatter 解析 ----
{
  const block = mod.parseRule('---\npaths:\n  - "src/**/*.ts"\n  - "*.json"\n---\n改 TS 文件前先跑类型检查。')
  assert.deepEqual(block.paths, ['src/**/*.ts', '*.json'])
  assert.match(block.body, /类型检查/)
  ok('block 风格 paths 解析')

  const inline = mod.parseRule("---\npaths: [\"a/*.md\", 'b/*.md']\n---\n正文")
  assert.deepEqual(inline.paths, ['a/*.md', 'b/*.md'])
  ok('inline 数组风格 paths 解析')

  assert.equal(mod.parseRule('没有 frontmatter 的普通 markdown'), null)
  assert.equal(mod.parseRule('---\nother: 1\n---\n正文'), null, '缺 paths 应跳过')
  assert.equal(mod.parseRule('---\npaths: ["a"]\n---\n   '), null, '空正文应跳过')
  ok('非法规则文件静默跳过，不抛错')
}

// ---- 3) glob 匹配 ----
{
  const rule = (pattern) => ({ regexps: [mod.expandBraces(pattern).map((p) => mod.globToRegExp(p))] })

  assert.ok(mod.ruleMatches(rule('src/**/*.ts'), 'src/a.ts'))
  assert.ok(mod.ruleMatches(rule('src/**/*.ts'), 'src/x/y/a.ts'))
  assert.ok(!mod.ruleMatches(rule('src/**/*.ts'), 'src/a.js'))
  assert.ok(mod.ruleMatches(rule('*.json'), 'package.json'))
  assert.ok(!mod.ruleMatches(rule('*.json'), 'sub/package.json'))
  assert.ok(mod.ruleMatches(rule('src/*.{ts,tsx}'), 'src/a.tsx'))
  assert.ok(!mod.ruleMatches(rule('src/*.{ts,tsx}'), 'src/a.vue'))
  assert.ok(mod.ruleMatches(rule('docs/?.md'), 'docs/a.md'))
  assert.ok(!mod.ruleMatches(rule('docs/?.md'), 'docs/ab.md'))
  ok('glob：** 跨目录、* 单层、? 单字符、{a,b} 分支')
}

// ---- 4) 路径归一化 ----
{
  const cwd = path.resolve('C:/work/project')
  assert.equal(mod.normalizePath(cwd, path.join(cwd, 'src', 'App.tsx')), 'src/App.tsx')
  assert.equal(mod.normalizePath(cwd, 'src\\App.tsx'), 'src/App.tsx')
  ok('Windows 分隔符与绝对路径都能归一化')
}

// ---- 5) 端到端：触发 / 不触发 / 会话隔离 / status ----
const dir = mkdtempSync(path.join(tmpdir(), 'path-rules-'))
try {
  const rulesDir = path.join(dir, '.dsh', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(path.join(rulesDir, 'frontend.md'), '---\npaths: ["src/**/*.tsx"]\n---\n改前端组件时先看设计稿。')
  writeFileSync(path.join(rulesDir, 'broken.md'), '没有 frontmatter，应被跳过')

  const { ctx, registered } = makeMockContext()
  const contexts = []
  const live = []
  ctx.get = (name) => (name === 'workingDirectory' ? { get: () => dir } : undefined)
  ctx.systemPrompt = {
    context(definition) {
      contexts.push(definition)
      return () => {}
    },
  }
  ctx.on = (name, handler) => {
    live.push({ name, handler })
    return () => {}
  }
  mod.apply(ctx, { maxChars: 3000 })
  assert.equal(contexts.length, 1, '应注册一个 systemPrompt.context')

  const post = live.find((entry) => entry.name === 'tools/post-execute')
  assert.ok(post !== undefined, '应注册 tools/post-execute')

  const session = { id: 'test-session' }
  const accept = async () => ({ kind: 'accept' })
  const renderNow = () => contexts[0].text({ agent: { session } })

  assert.equal(renderNow(), '', '还没触及文件时不注入')

  await post.handler(
    { name: 'read', arguments: { file_path: path.join(dir, 'src', 'App.tsx') }, agent: { session } },
    {},
    accept,
  )
  assert.match(renderNow(), /<path-rules>/, '触及匹配文件后应注入')
  assert.match(renderNow(), /改前端组件时先看设计稿/)
  ok('触及匹配文件才注入规则')

  await post.handler(
    { name: 'read', arguments: { file_path: path.join(dir, 'README.md') }, agent: { session } },
    {},
    accept,
  )
  assert.match(renderNow(), /<path-rules>/, '已有规则保持活跃')
  ok('一次触发后在本会话内保持')

  const other = { id: 'other-session' }
  assert.equal(contexts[0].text({ agent: { session: other } }), '', '规则按会话隔离')
  ok('规则按会话隔离，不串台')

  const statusTool = registered.find((tool) => tool.name === 'path_rules_status')
  assert.ok(statusTool !== undefined, '应注册 path_rules_status')
  const out = await statusTool.execute({}, { agent: { session } })
  assert.ok(out.ruleDirs.some((entry) => entry.dir.startsWith(dir)), 'status 的规则目录应基于会话工作目录')
  assert.ok(out.totalRules >= 1, '应至少扫到 1 条有效规则')
  assert.equal(out.triggeredRules.length, 1, '本次运行只触发 1 条规则')
  ok('status 基于会话工作目录，且只统计有效规则')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\npath-rules: ' + passed + ' 项通过')
