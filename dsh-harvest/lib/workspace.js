/**
 * dsh-harvest 工作区审计 v0.2.0
 *
 * 为什么有它：DSH 的工作区/会话是有账本的（.dsh/storages/workspace.json：workspaces 表 +
 * archivedSessionIds），删除会话/工作区必须走 DSH 的 API（session/delete、workspace/delete、
 * archiveSession），不能直接删磁盘目录——否则账本与磁盘对不上。
 *
 * 这个模块只读：读账本 + 磁盘 + harvest 状态，报「引用缺失 / 未登记会话 / 是否已榨过」。
 * 不做任何删除。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_STORE, defaultSessionsRoot, loadState, walkSessionFiles } from './core.js'

export function defaultWorkspaceStore() {
  const home = process.env.DSH_HOME || 'C:\\Users\\cqs6017\\.dsh'
  return path.join(home, 'storages', 'workspace.json')
}

export function readWorkspaceStore(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

export function workspaceStatus(options) {
  const opts = options || {}
  const storeFile = opts.workspaceFile || defaultWorkspaceStore()
  const storeDir = opts.storeDir || DEFAULT_STORE
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot()
  const result = {
    ready: false,
    unavailableReason: '',
    workspaceFile: storeFile,
    workspaces: [],
    drift: { missingTotal: 0, missingByWorkspace: {}, orphanSessions: [] },
    totals: {},
    lastError: '',
  }
  const store = readWorkspaceStore(storeFile)
  if (!store) {
    result.unavailableReason = 'workspace.json 不存在或不可解析: ' + storeFile
    return result
  }
  const tables = store.tables && store.tables.workspaces ? store.tables.workspaces : {}
  const onDisk = new Map()
  for (const file of walkSessionFiles(sessionsRoot)) {
    const parts = file.split(/[\\/]/)
    const sessionId = parts.length >= 2 ? parts[parts.length - 2] : ''
    if (sessionId !== '') onDisk.set(sessionId, file)
  }
  let harvestState = { sessions: {} }
  try { harvestState = loadState(storeDir) } catch (error) { /* 审计要 fail-safe */ }
  const archived = new Set((store.global && Array.isArray(store.global.archivedSessionIds)) ? store.global.archivedSessionIds : [])
  const referenced = new Set()
  let missingTotal = 0
  for (const [id, workspace] of Object.entries(tables)) {
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const present = ids.filter((sessionId) => onDisk.has(sessionId))
    const missing = ids.filter((sessionId) => !onDisk.has(sessionId))
    let bytes = 0
    for (const sessionId of present) {
      try { bytes += statSync(onDisk.get(sessionId)).size } catch (error) { /* 文件刚被删就跳过 */ }
    }
    const harvested = present.filter((sessionId) => harvestState.sessions && harvestState.sessions[sessionId]).length
    for (const sessionId of ids) referenced.add(sessionId)
    if (missing.length > 0) {
      missingTotal = missingTotal + missing.length
      result.drift.missingByWorkspace[workspace.title || id] = missing
    }
    result.workspaces.push({
      id: id,
      title: String(workspace.title || ''),
      path: String(workspace.path || ''),
      sessions: ids.length,
      present: present.length,
      missing: missing.length,
      harvested: harvested,
      archived: ids.filter((sessionId) => archived.has(sessionId)).length,
      bytes: bytes,
    })
  }
  const orphans = []
  for (const sessionId of onDisk.keys()) if (!referenced.has(sessionId)) orphans.push(sessionId)
  result.drift.missingTotal = missingTotal
  result.drift.orphanSessions = orphans
  result.totals = {
    workspaces: result.workspaces.length,
    onDisk: onDisk.size,
    referenced: referenced.size,
    missing: missingTotal,
    orphans: orphans.length,
    archived: archived.size,
  }
  result.ready = true
  return result
}
