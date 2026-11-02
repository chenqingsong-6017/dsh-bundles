#!/usr/bin/env node
/**
 * 回滚：把护栏配置换回最近一次备份（或 --backup 指定的一份）。
 * 逻辑全在 _ops/hooks-merge-apply.mjs 的 revertMerge / cli 里，这里只固定入口参数。
 *
 * 用法：
 *   node _ops/hooks-merge-revert.mjs                     回滚到最近一次备份（要求终端 TTY）
 *   node _ops/hooks-merge-revert.mjs --backup <文件名>    回滚到指定备份
 *   可选：--file <路径>  --backup-dir <目录>
 *
 * 恢复前会给当前配置存一份 .pre-revert-<时间戳> 快照，所以回滚本身也可回滚。
 */
import { cli } from './hooks-merge-apply.mjs'

process.exitCode = cli(['--revert', ...process.argv.slice(2)])
