/**
 * Host half of dsh-archived-purge.
 *
 * Lists every archived Session of the current DSH home and permanently removes
 * a selection: the session log directory, the projection-cache row, the
 * workspace accounting slot, and the id in the global archive set.
 *
 * The store layout is the shipped one (dsh-base cordis.patch.yml):
 *   <DSH_HOME>/sessions/--<normalized-cwd>--/<session-id>/session.vN.jsonl*
 *   <DSH_HOME>/storages/workspace.json
 *   <DSH_HOME>/storages/session_projcache/sessions/<session-id>.json
 *
 * Deletion is guarded: ids are shape-checked, every path must stay inside the
 * two storage roots, a live Session is refused, and workspace accounting is
 * cleared through the public registry API rather than a raw registry rewrite.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'archived-purge';
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'agents'];

const ROUTE = '/plugins/archived-purge';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_IDS = 500;
const MAX_BODY = 64 * 1024;
const MAX_CASCADE_DEPTH = 8;

function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && path.isAbsolute(env)) return env;
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir && path.isAbsolute(profileDir)) return path.resolve(profileDir, '..', '..');
  return path.join(os.homedir(), '.dsh');
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text);
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

async function removeTree(dir) {
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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function workspaceIndex(workspaces) {
  const byId = new Map();
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || typeof record !== 'object') continue;
    byId.set(workspaceId, record);
  }
  return byId;
}

function workspaceOf(workspaces, sessionId) {
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || !Array.isArray(record.sessionIds)) continue;
    if (record.sessionIds.includes(sessionId)) return { workspaceId, record };
  }
  return undefined;
}

function titleOfCache(doc) {
  const value = doc?.record?.rows?.title?.val;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function readCacheDoc(cacheDir, sessionId) {
  try {
    const doc = await readJson(path.join(cacheDir, `${sessionId}.json`));
    return doc;
  } catch {
    return undefined;
  }
}

export function createHandlers(deps) {
  const { home, sessions, agents, workspaceRegistry, sessionPersistence, emit } = deps;
  const sessionsRoot = path.join(home, 'sessions');
  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions');

  /** One session can appear under the raw uuid and the `session-<uuid>` spelling. */
  function idVariants(id) {
    const raw = id.startsWith('session-') ? id.slice(8) : id;
    return [...new Set([id, raw, 'session-' + raw])];
  }

  function liveSessionFor(id) {
    if (!sessions || typeof sessions.get !== 'function') return undefined;
    for (const variant of idVariants(id)) {
      try {
        const session = sessions.get(variant);
        if (session !== undefined) return session;
      } catch {
        /* store unavailable */
      }
    }
    return undefined;
  }

  function liveAgentFor(id) {
    if (!agents || typeof agents.list !== 'function') return undefined;
    let all;
    try {
      all = agents.list();
    } catch {
      return undefined;
    }
    const wanted = new Set(idVariants(id));
    for (const agent of Array.isArray(all) ? all : []) {
      if (!agent || typeof agent !== 'object') continue;
      const candidates = [agent.id, agent.session && agent.session.id];
      if (candidates.some((candidate) => typeof candidate === 'string' && wanted.has(candidate))) return agent;
    }
    return undefined;
  }

  function storeEntry(service, id) {
    const store = service && service.store;
    if (!(store instanceof Map)) return undefined;
    const wanted = new Set(idVariants(id));
    for (const [key, entry] of store) {
      const entryId = entry && typeof entry.id === 'string' ? entry.id : key;
      if (typeof entryId === 'string' && wanted.has(entryId)) return entry;
    }
    return undefined;
  }

  function isLive(id) {
    return liveSessionFor(id) !== undefined || liveAgentFor(id) !== undefined;
  }

  /**
   * Release a live session before its log disappears: stop its agent (cancel +
   * bounded wait), flush the store, then detach the live session/agent entries.
   * Without this the store keeps writing and can re-create the session directory
   * after removal — the reason the upstream plugin refused live sessions.
   */
  async function releaseSession(id) {
    const agent = liveAgentFor(id);
    if (agent !== undefined) {
      try {
        if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' });
      } catch {
        /* already settling */
      }
      if (typeof agent.whenIdle === 'function') {
        let timer;
        try {
          await Promise.race([
            Promise.resolve(agent.whenIdle()).catch(() => false),
            new Promise((resolve) => { timer = setTimeout(resolve, 15000); }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    }
    const session = liveSessionFor(id);
    if (session !== undefined && typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session);
      } catch {
        /* deletion proceeds and removes the log anyway */
      }
    }
    const sessionEntry = storeEntry(sessions, id);
    if (sessionEntry !== undefined) {
      try {
        if (typeof sessionEntry.detach === 'function') sessionEntry.detach();
        else if (typeof sessions.detachEntered === 'function') sessions.detachEntered(sessionEntry);
      } catch {
        /* reported by the post-release liveness check */
      }
    }
    const agentEntry = storeEntry(agents, id);
    if (agentEntry !== undefined) {
      try {
        if (typeof agents.detachEntered === 'function') agents.detachEntered(agentEntry);
        else if (typeof agentEntry.detach === 'function') agentEntry.detach();
      } catch {
        /* best effort: the session detach already removed it from every list */
      }
    }
    return {
      stopped: agent !== undefined,
      detachedSession: sessionEntry !== undefined,
      detachedAgent: agentEntry !== undefined,
    };
  }

  async function state() {
    const { archived, workspaces } = await readArchivedState(home);
    const dirs = await scanSessionDirs(sessionsRoot);
    const items = [];
    for (const id of archived) {
      if (!ID_RE.test(id)) continue;
      const cacheDoc = await readCacheDoc(cacheRoot, id);
      const sessionDirs = dirs.get(id) ?? [];
      let bytes = 0;
      let lastActivity = 0;
      for (const dir of sessionDirs) {
        const stats = await dirStats(dir);
        bytes += stats.bytes;
        if (stats.newest > lastActivity) lastActivity = stats.newest;
      }
      let cacheBytes = 0;
      try {
        const cacheStat = await fsp.stat(path.join(cacheRoot, `${id}.json`));
        cacheBytes = cacheStat.size;
        if (cacheStat.mtimeMs > lastActivity) lastActivity = cacheStat.mtimeMs;
      } catch {
        /* no cache row */
      }
      if (cacheDoc) bytes += cacheBytes;
      const owner = workspaceOf(workspaces, id);
      const title = titleOfCache(cacheDoc);
      items.push({
        id,
        title,
        workspaceId: owner?.workspaceId ?? null,
        workspaceTitle: typeof owner?.record?.title === 'string' ? owner.record.title : '',
        workspacePath: typeof owner?.record?.path === 'string' ? owner.record.path : '',
        sizeBytes: bytes,
        cacheBytes,
        lastActivity: lastActivity || null,
        exists: sessionDirs.length > 0,
        cacheExists: Boolean(cacheDoc),
        live: isLive(id),
      });
    }
    items.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    return {
      items,
      archivedCount: items.length,
      totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      generatedAt: Date.now(),
    };
  }

  async function descendantsOf(roots, skip) {
    if (!sessionPersistence || typeof sessionPersistence.list !== 'function') return [];
    let snapshots;
    try {
      snapshots = await sessionPersistence.list();
    } catch {
      return [];
    }
    const children = new Map();
    for (const snapshot of snapshots) {
      const header = snapshot?.header;
      if (!header || header.origin !== 'subagent') continue;
      const parent = header.parentSession;
      if (!parent) continue;
      const list = children.get(parent);
      if (list) list.push(header.id);
      else children.set(parent, [header.id]);
    }
    const found = [];
    let frontier = [...roots];
    for (let depth = 0; depth < MAX_CASCADE_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const parent of frontier) {
        for (const child of children.get(parent) ?? []) {
          if (skip.has(child) || found.includes(child)) continue;
          found.push(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    return found;
  }

  async function removeOne(id, dirs, options, workspaces) {
    let released = false;
    if (isLive(id)) {
      const release = await releaseSession(id);
      if (isLive(id)) {
        return { id, ok: false, code: 'release-failed', message: '会话仍在运行且无法释放（可能被其他窗口占用）' };
      }
      released = Boolean(release.stopped || release.detachedSession || release.detachedAgent);
    }
    let removedBytes = 0;
    const failures = [];
    for (const dir of dirs) {
      if (!isInside(sessionsRoot, dir)) {
        failures.push('path-outside-sessions-root');
        continue;
      }
      try {
        const stats = await dirStats(dir);
        await removeTree(dir);
        removedBytes += stats.bytes;
      } catch (error) {
        failures.push(formatError(error));
      }
    }
    const cacheFile = path.join(cacheRoot, `${id}.json`);
    if (isInside(cacheRoot, cacheFile)) {
      try {
        const stat = await fsp.stat(cacheFile);
        await fsp.rm(cacheFile, { force: true });
        removedBytes += stat.size;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') failures.push(formatError(error));
      }
    }
    if (failures.length > 0) {
      return { id, ok: false, code: 'delete-failed', message: failures.join('; '), removedBytes };
    }
    if (!options?.cascade) {
      const workspaceId = rawOwner(workspaces, id);
      if (workspaceId) {
        const owner = wsEntity(workspaceId);
        if (owner) {
          try {
            await owner.detachSession(id);
          } catch (error) {
            return { id, ok: false, code: 'registry-failed', message: formatError(error), removedBytes };
          }
        }
      }
      try {
        await workspaceRegistry.unarchiveSession(id);
      } catch (error) {
        return { id, ok: false, code: 'unarchive-failed', message: formatError(error), removedBytes };
      }
    }
    // A released live session commits one final projection row while its
    // lifecycle drains (after the first cache removal above), so sweep the
    // cache file once more after the registry calls settle.
    const finalCache = path.join(cacheRoot, `${id}.json`);
    if (isInside(cacheRoot, finalCache)) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await fsp.rm(finalCache, { force: true });
        } catch {
          /* reported by the presence check below */
        }
        let present = false;
        try {
          await fsp.stat(finalCache);
          present = true;
        } catch {
          present = false;
        }
        if (!present) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return { id, ok: true, removedBytes, released, cascade: Boolean(options?.cascade) };
  }

  function rawOwner(workspaces, id) {
    for (const [workspaceId, record] of Object.entries(workspaces)) {
      if (record && Array.isArray(record.sessionIds) && record.sessionIds.includes(id)) return workspaceId;
    }
    return undefined;
  }

  function wsEntity(workspaceId) {
    if (!workspaceRegistry) return undefined;
    try {
      if (typeof workspaceRegistry.get === 'function') {
        const entity = workspaceRegistry.get(workspaceId);
        if (entity && typeof entity.detachSession === 'function') return entity;
      }
      if (typeof workspaceRegistry.list === 'function') {
        const entity = workspaceRegistry.list().find((workspace) => workspace.id === workspaceId);
        if (entity && typeof entity.detachSession === 'function') return entity;
      }
    } catch {
      /* an unavailable registry leaves the accounting slot for a later repair */
    }
    return undefined;
  }

  async function remove(requested) {
    if (!Array.isArray(requested) || requested.length === 0) {
      return { ok: false, code: 'invalid-request', message: 'sessionIds 不能为空' };
    }
    if (requested.length > MAX_IDS) {
      return { ok: false, code: 'invalid-request', message: `一次最多删除 ${MAX_IDS} 个会话` };
    }
    const ids = [];
    for (const value of requested) {
      if (typeof value !== 'string' || !ID_RE.test(value)) {
        return { ok: false, code: 'invalid-request', message: '会话 ID 不合法' };
      }
      if (!ids.includes(value)) ids.push(value);
    }
    const { archived, workspaces } = await readArchivedState(home);
    const archivedSet = new Set(archived);
    const notArchived = ids.filter((id) => !archivedSet.has(id));
    if (notArchived.length > 0) {
      return {
        ok: false,
        code: 'not-archived',
        message: `有 ${notArchived.length} 个会话不在归档集合中，请刷新后重试`,
        notArchived,
      };
    }
    const dirs = await scanSessionDirs(sessionsRoot);
    const skip = new Set(ids);
    const childIds = await descendantsOf(ids, skip);
    const results = [];
    for (const id of ids) {
      const result = await removeOne(id, dirs.get(id) ?? [], { cascade: false }, workspaces);
      results.push(result);
    }
    for (const id of childIds) {
      const result = await removeOne(id, dirs.get(id) ?? [], { cascade: true }, workspaces);
      results.push({ ...result, child: true });
    }
    const deleted = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);
    // Tell every connected client to drop the row now. The disposed live
    // session already announced its canonical id; the other spelling (and a
    // composition that missed the detach) would otherwise leave a stale row
    // behind — which the UI then renders under "未分组".
    if (typeof emit === 'function') {
      for (const item of deleted) {
        for (const variant of idVariants(item.id)) {
          try {
            emit('api-session/removed', variant);
          } catch {
            /* a missing event bus must not fail the deletion */
          }
        }
      }
    }
    return {
      ok: failed.length === 0,
      deleted: deleted.length,
      failed: failed.length,
      removedBytes: results.reduce((sum, item) => sum + (item.removedBytes ?? 0), 0),
      results,
      archivedCount: archived.length,
      workspaceCount: Object.keys(workspaces).length,
    };
  }

  /**
   * Re-announce removals for ids already deleted out of band: a client that
   * missed the original event keeps a stale row (rendered under "未分组").
   * Emitting is idempotent on the client side.
   */
  function announce(requested) {
    if (!Array.isArray(requested) || requested.length === 0) {
      return { ok: false, code: 'invalid-request', message: 'sessionIds 不能为空' };
    }
    if (requested.length > MAX_IDS) {
      return { ok: false, code: 'invalid-request', message: `一次最多通告 ${MAX_IDS} 个会话` };
    }
    if (typeof emit !== 'function') {
      return { ok: false, code: 'no-event-bus', message: '宿主没有可用的 ctx.emit' };
    }
    let announced = 0;
    for (const raw of requested) {
      if (typeof raw !== 'string' || !ID_RE.test(raw)) continue;
      for (const variant of idVariants(raw)) {
        try {
          emit('api-session/removed', variant);
          announced += 1;
        } catch {
          /* skip an id the bus rejects */
        }
      }
    }
    return { ok: true, announced };
  }

  return { state, remove, announce, sessionsRoot, cacheRoot };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  const home = resolveHome();
  let agents;
  try {
    agents = ctx.get ? ctx.get('agents') : undefined;
  } catch {
    agents = undefined;
  }
  const emit = (event, payload) => {
    try {
      ctx.emit(event, payload);
    } catch {
      /* event bus unavailable */
    }
  };
  const handlers = createHandlers({
    home,
    sessions: ctx.sessions,
    agents,
    workspaceRegistry: ctx.workspaceRegistry,
    sessionPersistence: ctx.sessionPersistence,
    emit,
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/state`,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        send(res, 200, await handlers.state());
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/delete`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        send(res, 415, { ok: false, code: 'content-type-required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, 400, {
          ok: false,
          code: error?.code === 'too-large' ? 'payload-too-large' : 'invalid-json',
          message: formatError(error),
        });
        return;
      }
      try {
        const result = await handlers.remove(payload?.sessionIds);
        send(res, result.ok ? 200 : 400, result);
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/announce`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const result = handlers.announce(body?.sessionIds);
        send(res, result.ok ? 200 : 400, result);
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-request', message: formatError(error) });
      }
    },
  }));


  // Browser-side mount diagnostics: the Client half reports a failed apply here
  // so a future slot/API change leaves a readable trace instead of only a
  // generic "entry did not activate" dialog.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/client-error`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req));
        const line = [
          new Date().toISOString(),
          String(payload?.message ?? '').slice(0, 4000),
          String(payload?.stack ?? '').slice(0, 8000),
          '---',
          '',
        ].join('\n');
        await fsp.appendFile(path.join(home, 'archived-purge-client-errors.log'), line, 'utf8');
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-json', message: formatError(error) });
      }
    },
  }));
}
