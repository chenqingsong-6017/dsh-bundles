/**
 * DSH storage helpers shared by the host half and its views.
 *
 * These read the shipped layout directly (dsh-base cordis.patch.yml):
 *   <DSH_HOME>/sessions/--<normalized-cwd>--/<session-id>/session.vN.jsonl*
 *   <DSH_HOME>/storages/workspace.json
 *   <DSH_HOME>/storages/session_projcache/sessions/<session-id>.json
 *
 * Extracted from `index.js` so `lib/session-view.js` can use them without
 * importing the entry file back (a cycle), and so the structure gate sees a
 * smaller entry.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && path.isAbsolute(env)) return env;
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir && path.isAbsolute(profileDir)) return path.resolve(profileDir, '..', '..');
  return path.join(os.homedir(), '.dsh');
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text);
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function readArchivedState(home) {
  const workspaceFile = path.join(home, 'storages', 'workspace.json');
  let doc;
  try {
    doc = await readJson(workspaceFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { archived: [], workspaces: {}, workspaceFile, missing: true };
    }
    throw error;
  }
  const archived = Array.isArray(doc?.global?.archivedSessionIds)
    ? doc.global.archivedSessionIds.filter((id) => typeof id === 'string')
    : [];
  const workspaces = doc?.tables?.workspaces && typeof doc.tables.workspaces === 'object'
    ? doc.tables.workspaces
    : {};
  return { archived, workspaces, workspaceFile, missing: false };
}

export async function scanSessionDirs(root) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('--')) continue;
    const projectDir = path.join(root, entry.name);
    let children;
    try {
      children = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const dir = path.join(projectDir, child.name);
      const list = map.get(child.name);
      if (list) list.push(dir);
      else map.set(child.name, [dir]);
    }
  }
  return map;
}

export async function dirStats(dir) {
  let bytes = 0;
  let newest = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.stat(full);
        bytes += stat.size;
        files += 1;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* an unreadable file does not make the row fail */
      }
    }
  }
  return { bytes, newest, files };
}

export async function removeTree(dir) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function workspaceIndex(workspaces) {
  const byId = new Map();
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || typeof record !== 'object') continue;
    byId.set(workspaceId, record);
  }
  return byId;
}

export function workspaceOf(workspaces, sessionId) {
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || !Array.isArray(record.sessionIds)) continue;
    if (record.sessionIds.includes(sessionId)) return { workspaceId, record };
  }
  return undefined;
}

export function titleOfCache(doc) {
  const value = doc?.record?.rows?.title?.val;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function readCacheDoc(cacheDir, sessionId) {
  try {
    return await readJson(path.join(cacheDir, `${sessionId}.json`));
  } catch {
    return undefined;
  }
}
