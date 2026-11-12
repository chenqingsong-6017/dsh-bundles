/**
 * dsh-path-rules v2 行为测试。
 *
 * 三层：
 *   1) 纯函数：frontmatter（paths / always / id）、glob、优先级、同 id 去重、预算截断、注入文本
 *   2) 端到端：mock ctx + 临时规则目录，喂 tools/post-execute 事件
 *      —— 断言「触碰前不注入路径规则、always 装配时就注入、三层覆盖、会话隔离、status 用会话 cwd」
 *   3) 兼容：原有 schema 字段一个不少；老规则文件（只有 paths）不用改也照旧工作
 *
 * 用户级目录默认是 $DSH_HOME/rules，会污染断言，所以全程指到临时目录。
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

const rootTmp = mkdtempSync(path.join(tmpdir(), 'path-rules-v2-'))
const homeDir = path.join(rootTmp, 'home')
mkdirSync(path.join(homeDir, 'rules'), { recursive: true })
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = homeDir

const mkRule = (file, layer, text) => mod.createRule({ file, layer, sourceText: text })

try {
  // ---- 2) frontmatter 解析（v1 断言，保持不变） ----
  {
    const block = mod.parseRule('---\npaths:\n  - "src/**/*.ts"\n  - "*.json"\n---\n改 TS 文件前先跑类型检查。')
    assert.deepEqual(block.paths, ['src/**/*.ts', '*.json'])
    assert.match(block.body, /类型检查/)
    assert.equal(block.always, false, '老文件没写 always 就是 false')
    ok('block 风格 paths 解析')

    const inline = mod.parseRule('---\npaths: ["a/*.md", \'b/*.md\']\n---\n正文')
    assert.deepEqual(inline.paths, ['a/*.md', 'b/*.md'])
    ok('inline 数组风格 paths 解析')

    assert.equal(mod.parseRule('没有 frontmatter 的普通 markdown'), null)
    assert.equal(mod.parseRule('---\nother: 1\n---\n正文'), null, '缺 paths 应跳过')
    assert.equal(mod.parseRule('---\npaths: ["a"]\n---\n   '), null, '空正文应跳过')
    ok('非法规则文件静默跳过，不抛错')
  }

  // ---- 3) glob 匹配（v1 断言，保持不变） ----
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

  // ---- 4) 路径归一化（v1 断言，保持不变） ----
  {
    const cwd = path.resolve('C:/work/project')
    assert.equal(mod.normalizePath(cwd, path.join(cwd, 'src', 'App.tsx')), 'src/App.tsx')
    assert.equal(mod.normalizePath(cwd, 'src\\App.tsx'), 'src/App.tsx')
    ok('Windows 分隔符与绝对路径都能归一化')
  }

  // ---- 5) 端到端：触发 / 不触发 / 会话隔离 / status（v1 断言，保持不变） ----
  const dir = path.join(rootTmp, 'proj-v1')
  {
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
  }

  // ---- 6) always 与 id 解析（v2 新增） ----
  {
    const always = mod.parseRule('---\nalways: true\n---\n每轮都要：先跑类型检查。')
    assert.equal(always.always, true)
    assert.deepEqual(always.paths, [], 'always 规则不需要 paths')
    assert.match(always.body, /先跑类型检查/)

    for (const word of ['true', 'yes', 'on', '1', 'TRUE']) {
      assert.equal(mod.parseRule('---\nalways: ' + word + '\n---\n正文').always, true, 'always: ' + word)
    }
    for (const word of ['false', 'no', 'off', '0']) {
      assert.equal(mod.parseRule('---\nalways: ' + word + '\npaths: ["*.md"]\n---\n正文').always, false, 'always: ' + word)
    }
    ok('always 支持 true/yes/on/1，false/no/off/0 不算')

    const withId = mod.parseRule('---\nid: 前端规范\npaths: ["src/*.ts"]\n---\n正文')
    assert.equal(withId.id, '前端规范')

    const noId = mkRule('D:/proj/.dsh/rules/plain.md', 'project', '---\npaths: ["*.ts"]\n---\n正文')
    assert.equal(noId.id, 'D:/proj/.dsh/rules/plain.md', '无 id 时用文件路径当 id')
    ok('id 解析：显式 id 优先，缺省用文件路径')

    assert.equal(mod.parseRule('---\nid: 只有 id\n---\n正文'), null, '既无 paths 又无 always 继续跳过')
    assert.equal(mod.parseRule('---\nalways: false\n---\n只有开关没 paths\n') !== null, false, 'always: false 且无 paths 也跳过')

    const meta = mod.parseFrontmatter('paths: ["a/*.js"]\nunknown: 1\nalways: true\nid: x')
    assert.deepEqual(meta.paths, ['a/*.js'])
    assert.equal(meta.always, true)
    assert.equal(meta.id, 'x')
    assert.equal(mod.parseBoolFlag('YES'), true)
    assert.equal(mod.parseBoolFlag('随便'), false)
    ok('frontmatter 忽略未知键、大小写不敏感')
  }

  // ---- 7) 三层优先级与同 id 覆盖（v2 新增） ----
  {
    const userAlways = { rule: mkRule('C:/home/rules/common.md', 'user', '---\nid: 约定\nalways: true\n---\n用户级正文'), activation: 'always' }
    const projectAlways = { rule: mkRule('D:/proj/.dsh/rules/common.md', 'project', '---\nid: 约定\nalways: true\n---\n项目级正文'), activation: 'always' }
    const userPath = { rule: mkRule('C:/home/rules/fe.md', 'user', '---\nid: 约定\npaths: ["src/*.ts"]\n---\n用户路径正文'), activation: 'path' }
    const projectPath = { rule: mkRule('D:/proj/.dsh/rules/fe.md', 'project', '---\nid: 约定\npaths: ["src/*.ts"]\n---\n项目路径正文'), activation: 'path' }

    assert.ok(
      mod.rulePriority(userAlways.rule, 'always') < mod.rulePriority(projectAlways.rule, 'always'),
      '项目级高于用户级',
    )
    assert.ok(
      mod.rulePriority(projectAlways.rule, 'always') < mod.rulePriority(userPath.rule, 'path'),
      '路径命中高于每轮注入',
    )
    assert.ok(
      mod.rulePriority(userPath.rule, 'path') < mod.rulePriority(projectPath.rule, 'path'),
      '同为路径命中时项目级更高',
    )
    ok('优先级：用户级 < 项目级 < 路径命中')

    const byProject = mod.dedupeById([userAlways, projectAlways]).kept
    assert.equal(byProject.length, 1)
    assert.match(byProject[0].rule.body, /项目级正文/, '同 id 项目级覆盖用户级')

    const byPath = mod.dedupeById([userAlways, userPath]).kept
    assert.equal(byPath.length, 1)
    assert.equal(byPath[0].activation, 'path', '同 id 路径命中覆盖用户级')
    assert.match(byPath[0].rule.body, /用户路径正文/)

    const pathBeatsAlways = mod.dedupeById([projectAlways, userPath]).kept
    assert.match(pathBeatsAlways[0].rule.body, /用户路径正文/, '路径命中比项目级每轮注入更具体，优先')

    const unique = mod.dedupeById([userAlways, projectAlways, userPath, projectPath]).kept
    assert.equal(unique.length, 1)
    assert.equal(unique[0].rule.file, 'D:/proj/.dsh/rules/fe.md', '四条同 id 只留最高优先级的项目级路径规则')
    ok('同 id 去重：项目级覆盖用户级、路径命中覆盖更泛的层')
  }

  // ---- 8) 注入文本标明层级 + 顺序（v2 新增） ----
  {
    const cwd = 'D:/proj'
    const entries = [
      { rule: mkRule(cwd + '/.dsh/rules/core.md', 'project', '---\nalways: true\n---\n项目每轮纪律'), activation: 'always' },
      { rule: mkRule(cwd + '/.dsh/rules/fe.md', 'project', '---\nid: 前端\npaths: ["src/**/*.tsx"]\n---\n改组件先看设计稿'), activation: 'path' },
      { rule: mkRule('C:/Users/x/.dsh/rules/user.md', 'user', '---\nalways: true\n---\n用户级通用纪律'), activation: 'always' },
    ]
    const out = mod.composeInjection(entries, { cwd, maxChars: 3000, maxAlwaysChars: 2000 })
    assert.match(out.text, /<path-rules>/)
    assert.match(out.text, /【核心层 · 每轮生效】/)
    assert.match(out.text, /【路径层 · 触及匹配文件后生效】/)
    assert.match(out.text, /▌ 用户级 · /)
    assert.match(out.text, /▌ 项目级 · /)
    assert.match(out.text, /核心层，每轮生效/)
    assert.match(out.text, /路径命中，匹配 src\/\*\*\/\*\.tsx/)
    assert.match(out.text, /id: 前端/)
    assert.match(out.text, /用户级 < 项目级 < 路径命中/)
    assert.ok(
      out.text.indexOf('用户级通用纪律') < out.text.indexOf('项目每轮纪律'),
      '同一层内低优先级在前，最高优先级离模型最近',
    )
    assert.equal(out.active.length, 3)
    assert.ok(out.always.usedChars > 0 && out.path.usedChars > 0, '两份预算各自记账')
    ok('注入文本标明来源层/生效方式，并把高优先级排在后面')
  }

  // ---- 9) 两份预算各自截断、互不占用（v2 新增） ----
  {
    const cwd = 'D:/proj'
    const longBody = '很长的规则正文'.repeat(120)
    const alwaysRules = []
    for (let i = 0; i < 6; i += 1) {
      alwaysRules.push({
        rule: mkRule(cwd + '/.dsh/rules/a' + i + '.md', 'project', '---\nalways: true\n---\n' + longBody),
        activation: 'always',
      })
    }
    const pathRules = []
    for (let i = 0; i < 6; i += 1) {
      pathRules.push({
        rule: mkRule(cwd + '/.dsh/rules/p' + i + '.md', 'project', '---\npaths: ["src/*.ts"]\n---\n' + longBody),
        activation: 'path',
      })
    }
    const out = mod.composeInjection(alwaysRules.concat(pathRules), { cwd, maxAlwaysChars: 400, maxChars: 500 })
    assert.equal(out.always.maxChars, 400)
    assert.equal(out.path.maxChars, 500)
    assert.ok(out.always.usedChars <= 400, '核心层不超自己的预算')
    assert.ok(out.path.usedChars <= 500, '路径层不超自己的预算')
    assert.ok(out.always.truncated >= 1, '核心层超长正文被截断')
    assert.ok(out.always.omitted >= 1, '核心层放不下的整条跳过')
    assert.ok(out.path.truncated >= 1, '路径层超长正文被截断')
    assert.ok(out.path.omitted >= 1, '路径层放不下的整条跳过')
    assert.match(out.text, /超出本轮 400 字符预算/, '核心层截断/跳过要说明')
    assert.match(out.text, /超出本轮 500 字符预算/, '路径层截断/跳过要说明')
    assert.match(out.text, /正文已截断/)
    assert.match(out.text, /未展开/)
    ok('核心层 400 / 路径层 500 各自截断，互不吃预算，并写明原因')

    const defaults = mod.composeInjection([], {})
    assert.equal(defaults.always.maxChars, 2000, 'maxAlwaysChars 默认 2000')
    assert.equal(defaults.path.maxChars, 3000, 'maxChars 默认保持 3000')
    assert.equal(defaults.text, '', '没有规则时不注入任何东西')
    ok('默认预算：核心层 2000、路径层 3000，空规则不注入')
  }

  // ---- 9b) 常驻预算按工作区覆盖（2026-11-12：开发工作区 3000，其余仍 2000） ----
  {
    const byWorkspace = {
      maxAlwaysChars: 2000,
      maxAlwaysCharsByWorkspace: {
        'D:/AI-date/dsh-date/dsh-创建': 3000,
        'C:\\Work\\Other': 2500,
      },
    }
    assert.equal(mod.resolveAlwaysBudget(byWorkspace, 'D:/AI-date/dsh-date/dsh-创建'), 3000)
    assert.equal(mod.resolveAlwaysBudget(byWorkspace, 'D:\\AI-date\\dsh-date\\dsh-创建\\'), 3000, '反斜杠/尾斜杠归一后命中')
    assert.equal(mod.resolveAlwaysBudget(byWorkspace, 'C:/Users/cqs6017/other'), 2000, '未命中回默认 2000')
    assert.equal(mod.resolveAlwaysBudget(byWorkspace, 'C:/Work/Other'), 2500, '大小写/斜杠归一')
    assert.equal(mod.resolveAlwaysBudget({}, 'D:/x'), 2000, '无配置回默认')
    assert.equal(mod.resolveAlwaysBudget({ maxAlwaysCharsByWorkspace: {} }, 'D:/x'), 2000, '空表回默认')
    ok('常驻预算按工作区覆盖；反斜杠/尾斜杠/大小写归一；未命中回默认')
  }

  // ---- 10) 端到端：always 装配时就注入，路径规则触碰后才注入（v2 新增） ----
  {
    const projectDir = path.join(rootTmp, 'proj-always')
    const rulesDir = path.join(projectDir, '.dsh', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(path.join(rulesDir, 'core.md'), '---\nalways: true\n---\n每轮都要：提交前跑类型检查。')
    writeFileSync(path.join(rulesDir, 'paths.md'), '---\npaths: ["src/**/*.ts"]\n---\n改 TS 先看类型。')

    const { ctx, registered } = makeMockContext()
    const contexts = []
    const live = []
    ctx.get = (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined)
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
    mod.apply(ctx, {})
    const session = { id: 'always-session' }
    const renderNow = () => contexts[0].text({ agent: { session } })

    assert.match(renderNow(), /每轮都要：提交前跑类型检查/, 'always 规则装配系统提示时就注入')
    assert.doesNotMatch(renderNow(), /改 TS 先看类型/, '路径规则在触碰前不能注入')

    const post = live.find((entry) => entry.name === 'tools/post-execute')
    const accept = async () => ({ kind: 'accept' })
    await post.handler(
      { name: 'read', arguments: { file_path: path.join(projectDir, 'src', 'a.ts') }, agent: { session } },
      {},
      accept,
    )
    assert.match(renderNow(), /改 TS 先看类型/, '触碰匹配文件后路径规则补进来')
    assert.match(renderNow(), /<path-rules>/, '两块规则共用一个外壳')
    ok('端到端：always 装配即注入，路径规则触碰后才注入')

    const statusTool = registered.find((tool) => tool.name === 'path_rules_status')
    assert.ok(statusTool !== undefined)
    const out = await statusTool.execute({}, { agent: { session } })

    // 老字段一个不少、类型不变（schema 兼容）
    assert.ok(Array.isArray(out.ruleDirs))
    assert.ok(out.ruleDirs.every((entry) => typeof entry.dir === 'string' && typeof entry.exists === 'boolean' && Number.isInteger(entry.rules)))
    assert.ok(Number.isInteger(out.totalRules) && out.totalRules >= 2)
    assert.equal(out.maxChars, 3000)
    assert.ok(Array.isArray(out.triggeredRules))
    assert.equal(out.triggeredRules.length, 1, 'always 不计入「触发过的路径规则」')
    assert.ok(out.triggeredRules.every((rule) => typeof rule.file === 'string' && Array.isArray(rule.paths) && Number.isInteger(rule.chars)))
    ok('status 原有字段保留（ruleDirs / totalRules / triggeredRules / maxChars）')

    // 新字段：分层、优先级、两份预算
    assert.equal(out.enabled, true)
    assert.equal(out.maxAlwaysChars, 2000)
    assert.deepEqual(out.layers.map((item) => item.layer), ['用户级', '项目级', '核心层'])
    assert.ok(out.layers.every((item) => Number.isInteger(item.scanned) && Number.isInteger(item.active)))
    assert.equal(out.layers[0].scanned, 0, '临时 DSH_HOME 里没有用户级规则')
    assert.equal(out.layers[1].scanned, 2, '项目级扫到 2 条')
    assert.equal(out.layers[2].scanned, 1, '核心层扫到 1 条')
    assert.equal(out.layers[2].active, 1)
    for (const budget of [out.alwaysBudget, out.pathBudget]) {
      for (const key of ['maxChars', 'usedChars', 'rules', 'omitted', 'truncated']) {
        assert.ok(Number.isInteger(budget[key]), '预算字段 ' + key + ' 应是整数')
      }
    }
    assert.equal(out.alwaysBudget.rules, 1)
    assert.equal(out.pathBudget.rules, 1)
    const core = out.activeRules.find((rule) => rule.activation === '核心层')
    assert.ok(core !== undefined, '核心层规则应出现在 activeRules')
    assert.equal(core.source, '项目级')
    assert.ok(Number.isInteger(core.priority))
    const pathRule = out.activeRules.find((rule) => rule.activation === '路径命中')
    assert.ok(pathRule !== undefined, '路径规则应出现在 activeRules')
    assert.ok(pathRule.priority > core.priority, '路径命中优先级高于核心层')
    // 返回值必须和 schema 严格对齐（多一个字段就是 invalid output）
    const schemaKeys = Object.keys(statusTool.output.schema.properties).sort()
    assert.deepEqual(Object.keys(out).sort(), schemaKeys, '返回字段与 schema 完全一致')
    assert.deepEqual(statusTool.output.schema.required.slice().sort(), schemaKeys, 'required 覆盖全部字段')
    ok('status 新字段：分层扫描/生效、每条来源层与优先级、两份预算用量')
  }

  // ---- 11) 端到端三层覆盖（用户级 vs 项目级 vs 路径命中）（v2 新增） ----
  {
    const projectDir = path.join(rootTmp, 'proj-cover')
    const projRules = path.join(projectDir, '.dsh', 'rules')
    const userRules = path.join(rootTmp, 'home-cover', 'rules')
    mkdirSync(projRules, { recursive: true })
    mkdirSync(userRules, { recursive: true })
    writeFileSync(path.join(userRules, 'a.md'), '---\nid: 提交约定\nalways: true\n---\n用户级：提交前跑全量测试。')
    writeFileSync(path.join(userRules, 'b.md'), '---\nid: 样式约定\nalways: true\n---\n用户级：样式色值直接写死。')
    writeFileSync(path.join(projRules, 'c.md'), '---\nid: 提交约定\nalways: true\n---\n项目级：提交前只跑类型检查。')
    writeFileSync(path.join(projRules, 'd.md'), '---\nid: 样式约定\npaths: ["src/*.css"]\n---\n项目级：样式只用设计 token。')

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = path.join(rootTmp, 'home-cover')
    try {
      const { ctx } = makeMockContext()
      const contexts = []
      const live = []
      ctx.get = (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined)
      ctx.systemPrompt = { context(definition) { contexts.push(definition); return () => {} } }
      ctx.on = (name, handler) => { live.push({ name, handler }); return () => {} }
      mod.apply(ctx, {})
      const session = { id: 'cover-session' }
      const renderNow = () => contexts[0].text({ agent: { session } })

      const before = renderNow()
      assert.match(before, /项目级：提交前只跑类型检查/, '同 id 项目级覆盖用户级')
      assert.doesNotMatch(before, /用户级：提交前跑全量测试/, '被覆盖的用户级规则不出现')
      assert.match(before, /用户级：样式色值直接写死/, '项目级路径规则还没命中，用户级的先顶着')
      assert.doesNotMatch(before, /项目级：样式只用设计 token/, '路径规则未命中不注入')
      ok('端到端：项目级 always 覆盖用户级 always')

      const post = live.find((entry) => entry.name === 'tools/post-execute')
      await post.handler(
        { name: 'read', arguments: { file_path: path.join(projectDir, 'src', 'a.css') }, agent: { session } },
        {},
        async () => ({ kind: 'accept' }),
      )
      const after = renderNow()
      assert.match(after, /项目级：样式只用设计 token/, '同 id 路径命中覆盖用户级')
      assert.doesNotMatch(after, /用户级：样式色值直接写死/, '被路径规则覆盖后不再重复注入')
      ok('端到端：路径命中覆盖用户级')
    } finally {
      process.env.DSH_HOME = previousHome
    }
  }

  // ---- 12) 老规则文件向后兼容（只有 paths，没有任何新字段）（v2 新增） ----
  {
    const projectDir = path.join(rootTmp, 'proj-legacy')
    const rulesDir = path.join(projectDir, '.dsh', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    // 完全按 v1 的写法：无 id、无 always，只有 paths
    writeFileSync(path.join(rulesDir, 'legacy.md'), '---\npaths:\n  - "src/**/*.js"\n---\n老规则：改 JS 前先跑 lint。')

    const { ctx } = makeMockContext()
    const contexts = []
    const live = []
    ctx.get = (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined)
    ctx.systemPrompt = { context(definition) { contexts.push(definition); return () => {} } }
    ctx.on = (name, handler) => { live.push({ name, handler }); return () => {} }
    mod.apply(ctx, { maxChars: 3000 })
    const session = { id: 'legacy-session' }
    const renderNow = () => contexts[0].text({ agent: { session } })
    assert.equal(renderNow(), '', '老规则仍要命中才注入')
    const post = live.find((entry) => entry.name === 'tools/post-execute')
    await post.handler(
      { name: 'edit', arguments: { file_path: path.join(projectDir, 'src', 'a.js') }, agent: { session } },
      {},
      async () => ({ kind: 'accept' }),
    )
    const injected = renderNow()
    assert.match(injected, /老规则：改 JS 前先跑 lint/)
    assert.match(injected, /路径命中/, '老规则被标成路径命中层')
    assert.match(injected, /用户级 < 项目级 < 路径命中/, '注入头解释优先级')
    ok('老规则文件不改也照旧工作（只多一层层级标注）')
  }

  // ---- 13) config：enabled 开关与预算（v2 新增） ----
  {
    const projectDir = path.join(rootTmp, 'proj-config')
    mkdirSync(path.join(projectDir, '.dsh', 'rules'), { recursive: true })

    const off = makeMockContext()
    const offLive = []
    off.ctx.on = (name, handler) => { offLive.push({ name, handler }); return () => {} }
    let offContexts = 0
    off.ctx.systemPrompt = { context() { offContexts += 1; return () => {} } }
    mod.apply(off.ctx, { enabled: false })
    assert.equal(off.registered.length, 0, 'enabled: false 不注册工具')
    assert.equal(offLive.length, 0, 'enabled: false 不注册事件')
    assert.equal(offContexts, 0, 'enabled: false 不注册注入')

    const on = makeMockContext()
    on.ctx.get = (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined)
    on.ctx.systemPrompt = { context() { return () => {} } }
    mod.apply(on.ctx, { maxChars: 800, maxAlwaysChars: 600 })
    const statusTool = on.registered.find((tool) => tool.name === 'path_rules_status')
    const out = await statusTool.execute({}, { agent: { session: { id: 'cfg-session' } } })
    assert.equal(out.enabled, true)
    assert.equal(out.maxChars, 800)
    assert.equal(out.maxAlwaysChars, 600)
    assert.equal(out.alwaysBudget.maxChars, 600)
    assert.equal(out.pathBudget.maxChars, 800)
    assert.equal(out.totalRules, 0, '空规则目录')
    assert.equal(out.activeRules.length, 0)
    assert.equal(out.layers.length, 3)
    ok('enabled 开关生效，maxChars / maxAlwaysChars 从 config 读')
  }

  // ---- 14) 2026-11-02 升级：#16 大小写 / #17 cwd 外绝对路径 / #18 always 认不出 / #19 跳过文件可见 ----
  {
    // #16：Windows 大小写双方归一，不能再「规则写了却永不激活」
    const caseRule = mkRule(path.join(homeDir, 'rules', 'case.md'), 'user',
      '---\npaths:\n  - "D:/AI/Dsh-Bundles/**"\n---\n大小写规则。')
    assert.equal(mod.ruleMatches(caseRule, 'D:/AI/dsh-bundles/dsh-memory/index.js'), true, 'Windows 大小写不影响命中')
    assert.equal(mod.ruleMatches(caseRule, 'src/a.js'), false)

    // #18：认不出的 always 值必须留 warnings，不能静默降级
    const badBoolPath = path.join(homeDir, 'rules', 'bad-bool.md')
    writeFileSync(badBoolPath, '---\npaths:\n  - "*.js"\nalways: yes.\n---\n认不出的布尔值。', 'utf8')
    const badBool = mkRule(badBoolPath, 'user',
      '---\npaths:\n  - "*.js"\nalways: yes.\n---\n认不出的布尔值。')
    assert.equal(badBool.always, false)
    assert.ok(badBool.warnings.some((warning) => warning.includes('无法识别')), 'always 值认不出必须留 warnings')

    // #17：cwd 外文件的绝对路径也要能命中绝对 glob；#19：超限规则文件不能静默消失
    const projectDir = path.join(rootTmp, 'proj-abs')
    const rulesDir = path.join(projectDir, '.dsh', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(path.join(rulesDir, 'abs.md'), '---\npaths:\n  - "D:/AI/dsh-bundles/**"\n---\n外部目录规则。', 'utf8')
    writeFileSync(path.join(rulesDir, 'too-big.md'), '---\npaths:\n  - "*.tmp"\n---\n' + 'x'.repeat(40 * 1024), 'utf8')

    const mock = makeMockContext()
    const contexts = []
    const live = []
    mock.ctx.get = (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined)
    mock.ctx.systemPrompt = { context(definition) { contexts.push(definition); return () => {} } }
    mock.ctx.on = (name, handler) => { live.push({ name, handler }); return () => {} }
    mod.apply(mock.ctx, { maxChars: 3000 })
    const session = { id: 'abs-session' }
    const renderNow = () => contexts[0].text({ agent: { session } })
    assert.equal(renderNow(), '')
    const post = live.find((entry) => entry.name === 'tools/post-execute')
    await post.handler(
      { name: 'edit', arguments: { file_path: 'D:/AI/dsh-bundles/dsh-memory/index.js' }, agent: { session } },
      {},
      async () => ({ kind: 'accept' }),
    )
    assert.match(renderNow(), /外部目录规则/, 'cwd 外绝对路径必须命中绝对 glob（#17）')

    const statusTool = mock.registered.find((tool) => tool.name === 'path_rules_status')
    const status = await statusTool.execute({}, { agent: { session } })
    assert.ok(Array.isArray(status.warnings), 'status 必须带 warnings 数组')
    assert.ok(status.warnings.some((warning) => warning.includes('已跳过')), '超限规则文件必须被点名（#19）')
    assert.ok(status.warnings.some((warning) => warning.includes('too-big')), '要点到具体文件')
    assert.ok(status.warnings.some((warning) => warning.includes('无法识别')), 'always 认不出的告警要汇总进 status')
    const statusRendered = statusTool.output.render({}, status)[0].text
    assert.ok(statusRendered.includes('规则文件告警'), 'render 要把告警显示出来')

    ok('升级：大小写命中 / cwd 外绝对路径命中 / always 认不出告警 / 超限文件点名')
  }
} finally {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(rootTmp, { recursive: true, force: true })
}

console.log('\npath-rules: ' + passed + ' 项通过')
