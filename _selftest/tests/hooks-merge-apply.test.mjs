#!/usr/bin/env node
/**
 * _ops/hooks-merge-apply.mjs 的回归测试：合并 / 预演 / 备份 / 回滚 / 各种拒绝路径。
 *
 * 全部在临时目录里做，绝不碰真实护栏配置（真实配置由人工执行 --apply 才动）。
 * 每个用例都有明确的反向判据：写路径必须留下备份、dry-run 必须字节不变、
 * 缺脚本/缺一条/坏 JSON 必须拒绝且不写、非 TTY 的 --apply 必须退 2。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_FILE, MERGE_NAME, MERGED_SCRIPT, applyMerge, mergeHooks, revertMerge, validate } from '../../_ops/hooks-merge-apply.mjs'

const NODE = process.execPath
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APPLY_CLI = path.join(HERE, '../../_ops/hooks-merge-apply.mjs')

let pass = 0
const failures = []
const ok = (label) => { pass += 1; console.log('  ✓ ' + label) }
const bad = (label, detail) => { failures.push(label + ' —— ' + detail); console.log('  ✗ ' + label + ' —— ' + detail) }

const tmp = mkdtempSync(path.join(tmpdir(), 'hooks-merge-apply-'))
const backupDir = path.join(tmp, 'backups')
const cfg = path.join(tmp, 'cfg.json')

// 生产配置的形状：7 条 hook，其中 danger-guard 与 self-guard 正是要被合并的两条
const ORIGINAL = {
  version: 1,
  hooks: [
    { name: 'danger-guard', event: 'tool.pre', match: '^(bash|pwsh)$', run: 'node "D:/AI/dsh-bundles/dsh-hooks/examples/guard-danger.mjs"', timeoutMs: 4000, onError: 'deny' },
    { name: 'fs-guard', event: 'tool.pre', match: '^(write|edit)$', run: 'node "D:/x/guard-fs.mjs"', timeoutMs: 2000, onError: 'deny' },
    { name: 'code-guard', event: 'tool.pre', match: '^run_code$', run: 'node "D:/x/guard-code.mjs"', timeoutMs: 2000, onError: 'deny' },
    { name: 'cred-guard', event: 'tool.pre', match: '^(read|grep|glob)$', run: 'node "D:/x/guard-cred.mjs"', timeoutMs: 2000, onError: 'deny' },
    { name: 'self-guard', event: 'tool.pre', match: '^(bash|pwsh)$', run: 'node "D:/AI/dsh-bundles/dsh-hooks/examples/guard-self.mjs"', timeoutMs: 2000, onError: 'deny' },
    { name: 'gui-guard', event: 'tool.pre', match: '^cua_driver_native__launch_app$', run: 'node "D:/x/guard-gui.mjs"', timeoutMs: 2000, onError: 'deny' },
    { name: 'net-guard', event: 'tool.pre', match: '^web_fetch$', run: 'node "D:/x/net-guard.mjs"', timeoutMs: 1500, onError: 'deny' },
  ],
}
const reset = () => writeFileSync(cfg, JSON.stringify(ORIGINAL, null, 2) + '\n', 'utf8')
const readCfg = () => JSON.parse(readFileSync(cfg, 'utf8'))

try {
  // ---- 1) mergeHooks 纯函数：两条 → 一条，位置与其余条目不变 ----
  const pure = mergeHooks(ORIGINAL.hooks)
  if (!pure.changed) bad('mergeHooks 生效', 'changed=false')
  else if (pure.hooks.length !== 6) bad('mergeHooks 条数', '期望 6 实际 ' + pure.hooks.length)
  else if (pure.hooks[0].name !== MERGE_NAME) bad('mergeHooks 插入位置', '第一条应是 ' + MERGE_NAME + '，实际 ' + pure.hooks[0].name)
  else if (pure.hooks.filter((h) => h.name === 'fs-guard').length !== 1) bad('mergeHooks 保留其余', 'fs-guard 丢了')
  else ok('mergeHooks：7 条 → 6 条，插在原 danger-guard 位置，其余原样')
  const half = mergeHooks(ORIGINAL.hooks.filter((h) => h.name !== 'self-guard'))
  if (half.changed || half.missing.length !== 1) bad('mergeHooks 缺一条拒绝', 'missing=' + JSON.stringify(half.missing))
  else ok('mergeHooks：只找到一条时拒绝（missing 报出缺的那条）')

  // ---- 2) dry-run 必须一个字节都不改 ----
  reset()
  const beforeText = readFileSync(cfg, 'utf8')
  const dry = applyMerge({ file: cfg, backupDir, dryRun: true })
  if (dry.wrote) bad('dry-run 不写', 'wrote=true')
  else if (readFileSync(cfg, 'utf8') !== beforeText) bad('dry-run 文件不变', '内容被改了')
  else if (dry.beforeCount !== 7 || dry.afterCount !== 6) bad('dry-run 条数预告', dry.beforeCount + '→' + dry.afterCount)
  else if (dry.issues.length !== 0) bad('dry-run 无阻塞', dry.issues.join('；'))
  else ok('dry-run：报告 7→6、无阻塞、文件字节不变、不产生备份')
  if (existsSync(backupDir) && readdirSync(backupDir).length > 0) bad('dry-run 不备份', '备份目录里出现了文件')

  // ---- 3) --apply 真写：备份 + 结构校验 ----
  reset()
  const applied = applyMerge({ file: cfg, backupDir, dryRun: false })
  if (!applied.wrote) bad('apply 写入', applied.issues.join('；') || 'wrote=false')
  else if (!existsSync(applied.backup)) bad('apply 留备份', applied.backup)
  else if (validate(readCfg()).length !== 0) bad('apply 后配置合法', validate(readCfg()).join('；'))
  else ok('--apply：写入成功、留备份、写后复检 0 问题（备份：' + path.basename(applied.backup) + '）')
  const after = readCfg()
  if (after.hooks.length !== 6) bad('apply 后条数', String(after.hooks.length))
  else if (JSON.stringify(after.hooks.filter((h) => !['danger-guard', 'self-guard'].includes(h.name)).map((h) => h.name))
    !== JSON.stringify([MERGE_NAME, 'fs-guard', 'code-guard', 'cred-guard', 'gui-guard', 'net-guard'])) bad('apply 保留其余 hook 顺序', JSON.stringify(after.hooks.map((h) => h.name)))
  else ok('apply 后：其余 5 条 hook 原样保留、顺序不变')
  const mergedHook = after.hooks.find((h) => h.name === MERGE_NAME)
  if (!mergedHook || !String(mergedHook.run).includes(MERGED_SCRIPT)) bad('合并条目指向合并脚本', JSON.stringify(mergedHook))
  else ok('合并条目 run 指向 guards-bash-pwsh.mjs，onError=deny / timeoutMs=4000')
  if (mergedHook && (mergedHook.onError !== 'deny' || mergedHook.timeoutMs !== 4000)) bad('合并条目护栏参数', JSON.stringify(mergedHook))

  // 备份内容必须等于合并前原文
  const backupText = readFileSync(applied.backup, 'utf8')
  if (JSON.stringify(JSON.parse(backupText)) !== JSON.stringify(ORIGINAL)) bad('备份内容 = 合并前原文', '不一致')
  else ok('备份内容与合并前原文逐字段一致')
  const backupSnapshot = backupText

  // ---- 4) 回滚：恢复备份，且留 .pre-revert 快照 ----
  const reverted = revertMerge({ file: cfg, backupDir })
  if (!reverted.wrote) bad('revert 写入', reverted.issues.join('；'))
  else if (JSON.stringify(readCfg()) !== JSON.stringify(JSON.parse(backupSnapshot))) bad('revert 内容一致', '回滚后与备份不一致')
  else if (!reverted.preRevert || !existsSync(reverted.preRevert)) bad('revert 留快照', String(reverted.preRevert))
  else ok('revert：内容回到合并前，并留下 .pre-revert 快照（回滚也可回滚）')

  // ---- 5) 拒绝路径：缺脚本 / 坏 JSON / 已是合并态 ----
  reset()
  const missingScript = applyMerge({ file: cfg, backupDir, dryRun: false, mergedScript: path.join(tmp, 'no-such-merged.mjs') })
  if (missingScript.wrote || !missingScript.issues.some((i) => i.includes('不存在'))) bad('缺合并脚本时拒绝', JSON.stringify(missingScript.issues))
  else if (readFileSync(cfg, 'utf8') !== JSON.stringify(ORIGINAL, null, 2) + '\n') bad('缺脚本时文件不变', '文件被改了')
  else ok('拒绝：合并脚本不存在 → 不写、报「不存在」')

  writeFileSync(cfg, '{ not json', 'utf8')
  const broken = applyMerge({ file: cfg, backupDir, dryRun: false })
  if (broken.wrote || !broken.issues.some((i) => i.includes('JSON'))) bad('坏 JSON 拒绝', JSON.stringify(broken.issues))
  else ok('拒绝：配置不是合法 JSON → 不写')

  reset()
  applyMerge({ file: cfg, backupDir, dryRun: false })
  const again = applyMerge({ file: cfg, backupDir, dryRun: false })
  if (again.wrote || !again.issues.some((i) => i.includes('找不到要合并的 hook'))) bad('已是合并态再跑无副作用', JSON.stringify(again.issues))
  else ok('幂等：已是合并态再跑 → 不写、明确报告「找不到要合并的 hook」')

  // ---- 6) CLI：没有 TTY 时 --apply 必须退 2（agent 到不了写入分支） ----
  reset()
  const cliApply = spawnSync(NODE, [APPLY_CLI, '--apply', '--file', cfg, '--backup-dir', backupDir], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
  if (cliApply.status !== 2) bad('CLI 非 TTY 拒绝 --apply', '退出码 ' + cliApply.status)
  else if (readFileSync(cfg, 'utf8') !== JSON.stringify(ORIGINAL, null, 2) + '\n') bad('CLI 拒绝后文件不变', '文件被改了')
  else ok('CLI：无 TTY 的 --apply 退出 2，配置文件一个字节没动')
  const cliDry = spawnSync(NODE, [APPLY_CLI, '--file', cfg, '--backup-dir', backupDir], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (cliDry.status !== 0) bad('CLI 预演可跑', '退出码 ' + cliDry.status)
  else if (!String(cliDry.stdout).includes('预演')) bad('CLI 预演输出', String(cliDry.stdout).slice(0, 120))
  else ok('CLI：不带 --apply 时是预演，退出 0，提示人工 --apply')

  // ---- 7) 默认配置路径能解析到 .dsh 下的 json（只读检查，不写） ----
  if (!DEFAULT_FILE.endsWith('.json') || !DEFAULT_FILE.includes('.dsh')) bad('默认配置路径', DEFAULT_FILE)
  else ok('默认配置路径 = ' + DEFAULT_FILE)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}


console.log('\nhooks-merge-apply: ' + pass + ' 项通过，失败 ' + failures.length)
if (failures.length > 0) process.exit(1)
