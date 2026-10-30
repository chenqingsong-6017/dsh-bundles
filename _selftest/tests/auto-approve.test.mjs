/**
 * dsh-auto-approve 行为测试。
 *
 * 两层：
 *   1) 纯函数：规则解析（数组 / {rules} / 坏 JSON / 坏正则 / 坏 decision）、
 *      优先级（deny > ask > allow、同级项目级先行）、内置红线命中与不误伤、无命中
 *   2) 端到端：mock ctx + 临时规则目录（DSH_HOME 指向临时用户目录），喂 tools/pre-execute，
 *      断言 deny 时 next 不被调用、无命中时 next 恰好一次、allow 把下游 ask 降级、
 *      下游 deny 不被放松、坏配置 fail-safe、两个工具的人话输出
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

// ---- 0) 结构合规 ----
await runSmoke('dsh-auto-approve')
ok('结构合规、apply 可挂载')

const mod = await import('../../dsh-auto-approve/index.js')

// ---- 1) 规则文件路径（DSH_HOME 用 os.homedir 拼，不写死用户名）----
{
  assert.equal(mod.dshHome({ DSH_HOME: 'D:\\AI\\dsh-data\\dsh-home' }), 'D:\\AI\\dsh-data\\dsh-home')
  assert.ok(mod.dshHome({}).endsWith('.dsh'), '没有 DSH_HOME 时应回落到 <主目录>/.dsh')
  const files = mod.ruleFiles({ cwd: 'C:\\work\\proj', dshHome: 'D:\\home\\.dsh' })
  assert.equal(files[0].scope, 'project', '项目级排第一')
  assert.equal(files[0].file, path.join('C:\\work\\proj', '.dsh', 'auto-approve.json'))
  assert.equal(files[1].scope, 'user')
  assert.equal(files[1].file, path.join('D:\\home\\.dsh', 'auto-approve.json'))
  ok('规则文件路径：项目级在前、用户级由 DSH_HOME / 主目录拼出')
}

// ---- 2) 规则解析 ----
{
  const array = mod.parseRulesConfig(
    JSON.stringify([
      { name: '跑测试', tool: '^bash$', match: '(pnpm|npm) test', decision: 'allow', reason: '测试命令' },
      { name: '删构建产物', tool: '^bash$', match: 'rm -rf (dist|build)', decision: 'ask' },
    ]),
    'project',
  )
  assert.equal(array.rules.length, 2)
  assert.equal(array.rules[0].source, 'project')
  assert.equal(array.rules[0].decision, 'allow')
  assert.ok(array.rules[0].tool instanceof RegExp)
  assert.ok(array.rules[0].match instanceof RegExp)
  assert.equal(array.errors.length, 0)

  const object = mod.parseRulesConfig(JSON.stringify({ rules: [{ tool: '^write$', decision: 'deny' }] }), 'user')
  assert.equal(object.rules.length, 1)
  assert.equal(object.rules[0].name, '#1', '没写 name 时自动编号')
  assert.equal(object.rules[0].source, 'user')

  const broken = mod.parseRulesConfig('{ 这不是 JSON', 'user')
  assert.equal(broken.rules.length, 0)
  assert.match(broken.errors[0], /不是合法 JSON/)
  assert.doesNotThrow(() => mod.parseRulesConfig('null'))
  assert.doesNotThrow(() => mod.parseRulesConfig(undefined))

  const mixed = mod.parseRulesConfig(
    JSON.stringify([
      { name: '坏正则', tool: '([', decision: 'deny' },
      { name: '坏 decision', decision: 'maybe' },
      { name: '坏 match', decision: 'deny', match: '(' },
      '不是对象',
      { name: '幸存者', decision: 'deny', match: 'DROP TABLE' },
    ]),
    'user',
  )
  assert.equal(mixed.rules.length, 1, '坏的丢掉，好的保留')
  assert.equal(mixed.rules[0].name, '幸存者')
  assert.equal(mixed.errors.length, 4)
  ok('规则解析：数组 / {rules} / 坏 JSON / 坏正则 / 坏 decision 都不抛错')
}

// ---- 3) 内置红线：命中 ----
{
  const hits = [
    ['rm -rf /', 'bash', { command: 'rm -rf /', description: '清理' }],
    ['rm -fr / --no-preserve-root', 'pwsh', { command: 'sudo rm -fr / --no-preserve-root' }],
    ['format C:', 'bash', { command: 'format C: /q' }],
    ['Format-Volume', 'pwsh', { command: 'Format-Volume -DriveLetter D' }],
    ['vssadmin delete shadows', 'bash', { command: 'vssadmin delete shadows /all /quiet' }],
    ['写 .ssh', 'write', { file_path: 'C:\\Users\\x\\.ssh\\config' }],
    ['写 .credentials', 'write', { file_path: 'D:\\proj\\.credentials.yaml' }],
  ]
  for (const [label, toolName, args] of hits) {
    const verdict = mod.decideCall({ toolName, args })
    assert.equal(verdict.decision, 'deny', label + ' 应被拒绝')
    assert.equal(verdict.rule.source, 'builtin', label + ' 应标明命中内置红线')
    assert.ok(verdict.rule.reason.length > 0, label + ' 应带理由')
  }
  ok('内置红线命中：rm -rf /、format、vssadmin delete shadows、写 .ssh、写 .credentials')
}

// ---- 4) 内置红线：不误伤 ----
{
  const misses = [
    ['rm -rf /tmp/build', 'bash', { command: 'rm -rf /tmp/build' }],
    ['rm -rf node_modules', 'bash', { command: 'rm -rf node_modules && pnpm i' }],
    ['git log --format=%H', 'bash', { command: 'git log --format=%H -3' }],
    ['vssadmin list shadows', 'bash', { command: 'vssadmin list shadows' }],
    ['只读 .ssh', 'read', { file_path: 'C:\\Users\\x\\.ssh\\config' }],
    ['format 这个词出现在脚本名里', 'bash', { command: 'pnpm run format', description: '代码格式化' }],
  ]
  for (const [label, toolName, args] of misses) {
    const verdict = mod.decideCall({ toolName, args })
    assert.notEqual(verdict.decision, 'deny', label + ' 不该被拦')
  }
  const off = mod.decideCall({ toolName: 'bash', args: { command: 'rm -rf /' }, builtins: false })
  assert.equal(off.decision, 'none', 'builtins: false 可整体关掉红线')
  ok('内置红线不误伤：/tmp、node_modules、--format=、list shadows、只读 .ssh、format 脚本')
}

// ---- 4.5) 内置红线只查路径与命令文本，不查文件内容（避免误伤写文档） ----
{
  const benignDoc = mod.decideCall({
    toolName: 'write',
    args: { file_path: 'D:\\AI\\dsh-bundles\\docs\\security.md', content: '禁止写 .ssh/config，也不要 rm -rf /' },
  })
  assert.notEqual(benignDoc.decision, 'deny', '写安全文档时正文提到 .ssh / rm -rf / 不该被拦')

  const benignDesc = mod.decideCall({ toolName: 'bash', args: { command: 'echo ok', description: 'rm -rf / 的说明文字' } })
  assert.notEqual(benignDesc.decision, 'deny', 'description 只是说明文字，不参与红线匹配')

  const realSsh = mod.decideCall({ toolName: 'write', args: { file_path: 'C:\\Users\\x\\.ssh\\authorized_keys', content: 'ssh-rsa AAA' } })
  assert.equal(realSsh.decision, 'deny', '真写 .ssh 仍然拦')

  const codeSsh = mod.decideCall({ toolName: 'run_code', args: { code: 'fs.writeFileSync("C:/Users/x/.ssh/config", "x")' } })
  assert.equal(codeSsh.decision, 'deny', 'run_code 代码里出现 .ssh 路径也拦')

  assert.deepEqual(mod.fieldTexts({ command: 'echo', file_path: '' }, mod.BUILTIN_REDLINES[0].fields), ['echo'])
  assert.deepEqual(mod.fieldTexts(null, ['a']), [])
  ok('内置红线只查路径与命令文本：写文档提到 .ssh / rm -rf / 不误伤')
}

// ---- 5) 优先级 ----
{
  const project = (list) => mod.parseRulesConfig(JSON.stringify(list), 'project').rules
  const user = (list) => mod.parseRulesConfig(JSON.stringify(list), 'user').rules

  const denyBeatsAllow = mod.decideCall({
    toolName: 'bash',
    args: { command: 'pnpm test' },
    projectRules: project([{ name: '项目放行测试', tool: '^bash$', match: 'pnpm test', decision: 'allow' }]),
    userRules: user([{ name: '用户拒绝测试', tool: '^bash$', match: 'pnpm test', decision: 'deny' }]),
  })
  assert.equal(denyBeatsAllow.decision, 'deny', 'deny 优先于 allow')
  assert.equal(denyBeatsAllow.rule.name, '用户拒绝测试')

  const tie = mod.decideCall({
    toolName: 'bash',
    args: { command: 'echo hi' },
    projectRules: project([{ name: '项目拒绝', tool: '^bash$', decision: 'deny' }]),
    userRules: user([{ name: '用户拒绝', tool: '^bash$', decision: 'deny' }]),
  })
  assert.equal(tie.rule.name, '项目拒绝', '同级并列时项目级先行')
  assert.equal(tie.matches.length, 2, '全部命中都要留痕')

  const askBeatsAllow = mod.decideCall({
    toolName: 'bash',
    args: { command: 'echo hi' },
    projectRules: project([{ name: '要确认', tool: '^bash$', decision: 'ask' }]),
    userRules: user([{ name: '放行', tool: '^bash$', decision: 'allow' }]),
  })
  assert.equal(askBeatsAllow.decision, 'ask', 'ask 优先于 allow')
  ok('优先级：deny > ask > allow；同级时项目级先行')
}

// ---- 6) 无命中 ----
{
  const verdict = mod.decideCall({ toolName: 'read', args: { file_path: 'README.md' } })
  assert.equal(verdict.decision, 'none')
  assert.equal(verdict.rule, null)
  assert.deepEqual(verdict.matches, [])
  ok('无命中返回 none（调用方据此 next() 不干预，保持既有行为）')
}

// ---- 7) 端到端：mock ctx ----
{
  const home = mkdtempSync(path.join(tmpdir(), 'auto-approve-home-'))
  const proj = mkdtempSync(path.join(tmpdir(), 'auto-approve-proj-'))
  const empty = mkdtempSync(path.join(tmpdir(), 'auto-approve-empty-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mkdirSync(path.join(proj, '.dsh'), { recursive: true })
    writeFileSync(
      path.join(proj, '.dsh', 'auto-approve.json'),
      JSON.stringify([
        { name: '禁止删库', tool: '^bash$', match: 'DROP TABLE', decision: 'deny', reason: '生产库不能直接删表' },
        { name: '放行测试', tool: '^bash$', match: 'pnpm test', decision: 'allow', reason: '跑测试不需要每次点确认' },
        { name: '要确认推送', tool: '^bash$', match: 'git push', decision: 'ask', reason: '推送会改远端' },
      ]),
      'utf8',
    )
    writeFileSync(
      path.join(home, 'auto-approve.json'),
      JSON.stringify([{ name: '用户级放行 echo', tool: '^bash$', match: 'echo hi', decision: 'allow' }]),
      'utf8',
    )

    const { ctx, registered, listeners } = makeMockContext()
    ctx.get = (service) => (service === 'workingDirectory' ? { get: () => proj } : undefined)
    mod.apply(ctx, {})
    const pre = listeners.find((entry) => entry.name === 'tools/pre-execute')?.handler
    assert.ok(typeof pre === 'function', '应注册 tools/pre-execute')
    const execFor = (toolName, args) => ({ name: toolName, arguments: args, agent: { session: { id: 's1' } } })

    // deny → 早停，next 不被调用
    let calls = 0
    const denied = await pre(execFor('bash', { command: 'psql -c "DROP TABLE users"' }), async () => {
      calls += 1
      return { kind: 'allow' }
    })
    assert.equal(denied.kind, 'deny')
    assert.equal(calls, 0, '命中 deny 时 next 不应被调用')
    assert.match(denied.reason, /禁止删库/)
    assert.match(denied.reason, /生产库不能直接删表/)
    assert.equal(denied.info.code, 'AUTO_APPROVE_DENIED')
    ok('端到端：命中 deny → next 不被调用（早停），理由可操作')

    // 无命中 → next 恰好一次
    calls = 0
    const passedThrough = await pre(execFor('read', { file_path: 'AGENTS.md' }), async () => {
      calls += 1
      return { kind: 'allow' }
    })
    assert.deepEqual(passedThrough, { kind: 'allow' })
    assert.equal(calls, 1, '无命中时 next 恰好调用一次')
    ok('端到端：无命中 → next 恰好一次，原有行为不变')

    // allow + 下游 ask → 直接放行（代审的价值）
    calls = 0
    const rescued = await pre(execFor('bash', { command: 'pnpm test' }), async () => {
      calls += 1
      return { kind: 'ask', reason: '需要审批' }
    })
    assert.equal(rescued.kind, 'allow')
    assert.equal(calls, 1, 'allow 也要先问下游，不能跳过护栏')
    ok('端到端：命中 allow + 下游要审批 → 直接放行（省掉一次点击）')

    // allow 不放松下游 deny
    const keptDeny = await pre(execFor('bash', { command: 'pnpm test' }), async () => ({ kind: 'deny', reason: '下游护栏拒绝' }))
    assert.equal(keptDeny.kind, 'deny')
    assert.equal(keptDeny.reason, '下游护栏拒绝')
    ok('端到端：allow 不放松下游 deny（只收紧、不放松）')

    // ask：下游 deny 时听下游；下游没拦就要人工确认
    const askKept = await pre(execFor('bash', { command: 'git push origin main' }), async () => ({ kind: 'deny', reason: '下游护栏拒绝' }))
    assert.equal(askKept.kind, 'deny')
    const asked = await pre(execFor('bash', { command: 'git push origin main' }), async () => ({ kind: 'allow' }))
    assert.equal(asked.kind, 'ask')
    assert.match(asked.reason, /要确认推送/)
    ok('端到端：命中 ask → 人工确认（下游已 deny 则听下游）')

    // 无任何配置时内置红线照拦
    const builtinDenied = await pre(execFor('bash', { command: 'rm -rf /' }), async () => ({ kind: 'allow' }))
    assert.equal(builtinDenied.kind, 'deny')
    assert.match(builtinDenied.reason, /删除根目录/)
    ok('端到端：无配置时内置红线照拦')

    // status：文件 / 条数 / 统计 / 最近记录 / 人话渲染
    const statusTool = registered.find((tool) => tool.name === 'auto_approve_status')
    assert.ok(statusTool !== undefined, '应注册 auto_approve_status')
    const status = await statusTool.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(status.files.length, 2, '项目级 + 用户级两个文件')
    assert.ok(status.files.some((entry) => entry.scope === 'project' && entry.exists && entry.rules === 3))
    assert.ok(status.files.some((entry) => entry.scope === 'user' && entry.exists && entry.rules === 1))
    assert.equal(status.projectRules, 3)
    assert.equal(status.userRules, 1)
    assert.equal(status.builtinRules, 5)
    assert.ok(status.stats.checks >= 7, '每次 pre-execute 都计一次')
    assert.ok(status.stats.deny >= 3)
    assert.ok(status.stats.allow >= 1)
    assert.ok(status.stats.ask >= 1)
    assert.ok(status.stats.pass >= 1)
    assert.ok(status.recent.length > 0, '应有最近判断记录')
    assert.match(status.recent[0].time, /^\d{2}:\d{2}:\d{2}$/, '时间用 HH:MM:SS')
    assert.ok(status.recent.length <= status.maxRecords, '记录条数受 maxRecords 限制')
    const statusText = statusTool.output.render({}, status).map((block) => block.text).join('\n')
    assert.match(statusText, /dsh-auto-approve 已启用/)
    assert.match(statusText, /最近判断/)
    assert.match(statusText, /内置红线 5 条/)
    ok('status：规则文件 / 条数 / 统计 / 最近 20 条 / 人话渲染')

    // check：干跑 + 人话输出
    const checkTool = registered.find((tool) => tool.name === 'auto_approve_check')
    assert.ok(checkTool !== undefined, '应注册 auto_approve_check')
    const dry = await checkTool.execute(
      { tool: 'bash', arguments: { command: 'psql -c "DROP TABLE users"' } },
      { agent: { session: { id: 's1' } } },
    )
    assert.equal(dry.decision, 'deny')
    assert.equal(dry.rule, '禁止删库')
    assert.equal(dry.source, '项目规则')
    const dryText = checkTool.output.render({}, dry).map((block) => block.text).join('\n')
    assert.match(dryText, /拒绝/)
    assert.match(dryText, /生产库不能直接删表/)
    const dryNone = await checkTool.execute({ tool: 'read', arguments: { file_path: 'README.md' } }, { agent: { session: { id: 's1' } } })
    assert.equal(dryNone.decision, 'none')
    assert.match(checkTool.output.render({}, dryNone).map((block) => block.text).join('\n'), /不干预/)
    ok('auto_approve_check：干跑给人话决策（拒绝 / 不干预）')

    // 坏配置 fail-safe：只丢这一层规则，工具调用不挂，错误进 status
    writeFileSync(path.join(proj, '.dsh', 'auto-approve.json'), '{ 这不是合法 JSON，故意写坏 ', 'utf8')
    calls = 0
    const afterBroken = await pre(execFor('read', { file_path: 'AGENTS.md' }), async () => {
      calls += 1
      return { kind: 'allow' }
    })
    assert.equal(afterBroken.kind, 'allow')
    assert.equal(calls, 1, '坏配置下也要 fail-safe 调 next')
    const brokenStatus = await statusTool.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(brokenStatus.files.find((entry) => entry.scope === 'project').rules, 0)
    assert.ok(brokenStatus.errors.some((entry) => /不是合法 JSON/.test(entry)), '坏配置要记进 status')
    ok('坏配置 fail-safe：不干预 + 记进 status + 工具调用不挂')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
}

// ---- 8) v2 分类器接口（默认关闭；注入后才接管）----
{
  const home2 = mkdtempSync(path.join(tmpdir(), 'auto-approve-llm-'))
  const proj2 = mkdtempSync(path.join(tmpdir(), 'auto-approve-llm-proj-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home2
  try {
    const mount = (config) => {
      const { ctx, listeners } = makeMockContext()
      ctx.get = (service) => (service === 'workingDirectory' ? { get: () => proj2 } : undefined)
      mod.apply(ctx, config)
      return listeners.find((entry) => entry.name === 'tools/pre-execute').handler
    }
    const exec = { name: 'bash', arguments: { command: 'echo hi' }, agent: { session: { id: 's2' } } }

    // 默认关闭：下游 ask 原样保留
    const off = await mount({})(exec, async () => ({ kind: 'ask', reason: '需要审批' }))
    assert.equal(off.kind, 'ask', 'v2 默认关闭，不接管')

    // 注入分类器后：无规则命中时由分类器给决策
    const on = mount({ llm: { enabled: true }, classifier: async () => ({ decision: 'allow', reason: 'v2 判定安全' }) })
    const rescued = await on(exec, async () => ({ kind: 'ask', reason: '需要审批' }))
    assert.equal(rescued.kind, 'allow')

    // 分类器抛错 → 不干预，下游 ask 原样返回
    const broken = mount({ llm: { enabled: true }, classifier: async () => { throw new Error('boom') } })
    const kept = await broken(exec, async () => ({ kind: 'ask', reason: '需要审批' }))
    assert.equal(kept.kind, 'ask', '分类器异常必须 fail-safe')
    ok('v2 分类器接口：默认关闭、注入后接管、异常 fail-safe')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home2, { recursive: true, force: true })
    rmSync(proj2, { recursive: true, force: true })
  }
}

// ---- 9) 干跑/诊断工具自身豁免策略（否则没法用它试危险规则）----
{
  const { ctx, listeners } = makeMockContext()
  const cwd = mkdtempSync(path.join(tmpdir(), 'auto-approve-exempt-'))
  ctx.get = (service) => (service === 'workingDirectory' ? { get: () => cwd } : undefined)
  mod.apply(ctx, {})
  const pre = listeners.find((entry) => entry.name === 'tools/pre-execute').handler
  const dangerousArgs = { command: 'rm -rf' + ' /' }

  let calls = 0
  const dry = await pre({ name: 'auto_approve_check', arguments: dangerousArgs, agent: { session: { id: 's3' } } }, async () => { calls += 1; return { kind: 'allow' } })
  assert.equal(calls, 1, '干跑工具必须豁免，否则无法用它试危险规则')
  assert.equal(dry.kind, 'allow')

  calls = 0
  const real = await pre({ name: 'bash', arguments: dangerousArgs, agent: { session: { id: 's3' } } }, async () => { calls += 1; return { kind: 'allow' } })
  assert.equal(real.kind, 'deny', '真实工具仍然要拦')
  assert.equal(calls, 0, 'deny 时下游不应被调用')
  ok('干跑/诊断工具豁免策略；真实工具仍拦危险调用')
  rmSync(cwd, { recursive: true, force: true })
}

console.log('\nauto-approve: ' + passed + ' 项通过')
