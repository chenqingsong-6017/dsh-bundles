/**
 * Host-bound view of archived Sessions.
 *
 * `createHandlers` (and the structure gate that freezes it) is the reason this
 * lives in its own module: the manual scan and the automatic sweep both need
 * the same per-Session facts, and neither should grow the entry file. Every
 * factory below takes explicit dependencies, so the pieces stay testable.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { scanSessionArtifacts } from './clean.js';
import {
  dirStats,
  readArchivedState,
  readCacheDoc,
  scanSessionDirs,
  titleOfCache,
  workspaceOf,
} from './store.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_ARTIFACTS = 200;

/** Whether the store still holds the Session in memory (informational only). */
function createResidency(sessions) {
  return function isResident(id) {
    try {
      return Boolean(sessions && typeof sessions.get === 'function' && sessions.get(id));
    } catch {
      return false;
    }
  };
}

/** Session id → the directory that Session could write into. */
function createCwdMap({ home, sessionPersistence }) {
  return async function cwdBySession() {
    const map = new Map();
    if (sessionPersistence && typeof sessionPersistence.list === 'function') {
      try {
        for (const snapshot of await sessionPersistence.list()) {
          const id = snapshot?.header?.id;
          const cwd = snapshot?.header?.cwd;
          if (typeof id === 'string' && typeof cwd === 'string') map.set(id, cwd);
        }
      } catch {
        /* fall back to the workspace records below */
      }
    }
    const { workspaces } = await readArchivedState(home);
    for (const record of Object.values(workspaces)) {
      if (!record || !Array.isArray(record.sessionIds) || typeof record.path !== 'string') continue;
      for (const id of record.sessionIds) if (!map.has(id)) map.set(id, record.path);
    }
    return map;
  };
}

/** Workspace files the given Sessions explicitly wrote or presented. */
function createArtifactScan({ home, sessionPersistence, cwdBySession }) {
  return {
    cwdBySession,
    artifactScan: async (ids) => {
      const cwds = await cwdBySession();
      const scanned = await scanSessionArtifacts({
        sessionPersistence,
        sessionIds: ids,
        home,
        workspacesBySession: cwds,
      });
      return { ...scanned, cwds };
    },
  };
}

/** One row of the archive view: sizes, last activity, residency, task count. */
function createRowReader({ cacheRoot, isResident }) {
  return async function viewRow(id, sessionDirs, workspaces, scheduleCounts) {
    const cacheDoc = await readCacheDoc(cacheRoot, id);
    const cacheFile = path.join(cacheRoot, `${id}.json`);
    let bytes = 0;
    let lastActivity = 0;
    for (const dir of sessionDirs) {
      const stats = await dirStats(dir);
      bytes += stats.bytes;
      if (stats.newest > lastActivity) lastActivity = stats.newest;
    }
    try {
      const cacheStat = await fsp.stat(cacheFile);
      if (cacheStat.mtimeMs > lastActivity) lastActivity = cacheStat.mtimeMs;
    } catch {
      /* no cache row: the session still owns its log */
    }
    const owner = workspaceOf(workspaces, id);
    return {
      id,
      title: titleOfCache(cacheDoc),
      workspaceId: owner?.workspaceId ?? null,
      workspaceTitle: typeof owner?.record?.title === 'string' ? owner.record.title : '',
      logDirs: sessionDirs,
      cacheFile,
      bytes,
      lastActivity: lastActivity || null,
      resident: isResident(id),
      scheduleCount: scheduleCounts.get(id) ?? 0,
    };
  };
}

/** Scheduled tasks per Session id; an absent Schedule service means none. */
function createScheduleCounter(getSchedule) {
  return async function scheduleCountsOf(ids) {
    const counts = new Map();
    let service;
    try {
      service = typeof getSchedule === 'function' ? getSchedule() : undefined;
    } catch {
      service = undefined;
    }
    if (!service || typeof service.catalog !== 'function') return counts;
    let all;
    try {
      all = await service.catalog();
    } catch {
      return counts;
    }
    const wanted = new Set(ids);
    for (const task of Array.isArray(all) ? all : []) {
      const target = task?.target;
      if (!target || target.kind === 'new' || typeof target.sessionId !== 'string') continue;
      if (wanted.has(target.sessionId)) counts.set(target.sessionId, (counts.get(target.sessionId) ?? 0) + 1);
    }
    return counts;
  };
}

/** Archived Sessions with the facts a hold decision needs, read once per sweep. */
function createArchivedView({ home, sessionRoot, viewRow, scheduleCountsOf }) {
  return async function archivedView() {
    const { archived, workspaces } = await readArchivedState(home);
    const dirs = await scanSessionDirs(sessionRoot);
    const scheduleCounts = await scheduleCountsOf(archived);
    const rows = [];
    for (const id of archived) {
      if (!ID_RE.test(id)) continue;
      const sessionDirs = dirs.get(id) ?? [];
      if (sessionDirs.length === 0) continue;
      rows.push(await viewRow(id, sessionDirs, workspaces, scheduleCounts));
    }
    return rows;
  };
}

function workspaceEntity(workspaceRegistry, workspaceId) {
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

function ownerOf(workspaces, id) {
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (record && Array.isArray(record.sessionIds) && record.sessionIds.includes(id)) return workspaceId;
  }
  return undefined;
}

/** Permanent-phase bookkeeping; a resident Session keeps its slot until restart. */
function createDiscard({ home, cacheRoot, workspaceRegistry, isResident }) {
  return async function discard(id) {
    if (isResident(id)) return { deferred: true };
    const { workspaces } = await readArchivedState(home);
    let detached = false;
    const workspaceId = ownerOf(workspaces, id);
    const entity = workspaceId ? workspaceEntity(workspaceRegistry, workspaceId) : undefined;
    if (entity) {
      try {
        await entity.detachSession(id);
        detached = true;
      } catch {
        /* retried by finalizePending on the next load */
      }
    }
    let unarchived = false;
    try {
      await workspaceRegistry.unarchiveSession(id);
      unarchived = true;
    } catch {
      /* retried by finalizePending on the next load */
    }
    try {
      await fsp.rm(path.join(cacheRoot, `${id}.json`), { force: true });
    } catch {
      /* a leftover cache row is disposable */
    }
    return { detached, unarchived };
  };
}
/**
 * Compose the view. `home` plus the Host services are the whole contract.
 * @param {object} deps - `home`, `sessions`, `workspaceRegistry`,
 *   `sessionPersistence`, the Host's `activityKinds` and `getSchedule`.
 */
export function createSessionView(deps) {
  const { home, sessions, workspaceRegistry, sessionPersistence, activityKinds, getSchedule } = deps;
  const sessionRoot = path.join(home, 'sessions');
  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions');
  const isResident = createResidency(sessions);
  const cwdBySession = createCwdMap({ home, sessionPersistence });
  const { artifactScan } = createArtifactScan({ home, sessionPersistence, cwdBySession });
  const viewRow = createRowReader({ cacheRoot, isResident });
  const scheduleCountsOf = createScheduleCounter(getSchedule);
  const archivedView = createArchivedView({ home, sessionRoot, viewRow, scheduleCountsOf });
  const discard = createDiscard({ home, cacheRoot, workspaceRegistry, isResident });

  /** Files a Session produced, as absolute paths. Capped: a sweep is not a dump. */
  async function artifactsOf(id) {
    const { files } = await artifactScan([id]);
    return files
      .filter((file) => typeof file.path === 'string' && path.isAbsolute(file.path))
      .slice(0, MAX_ARTIFACTS)
      .map((file) => file.path);
  }

  /** Whether the Session is still archived (un-archiving means "I want it"). */
  async function isArchived(id) {
    const { archived } = await readArchivedState(home);
    return archived.includes(id);
  }

  /** Everything the automatic sweep needs, bound to this Host's services. */
  function autoDeps(extras = {}) {
    return {
      home,
      archivedView,
      activityOf: (id) => activityKinds(id),
      artifactsOf,
      discard,
      isArchived,
      ...extras,
    };
  }

  return { archivedView, artifactsOf, artifactScan, autoDeps, discard, isResident, cwdBySession };
}
