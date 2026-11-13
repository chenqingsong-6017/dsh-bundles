/**
 * Quarantine store for dsh-archived-purge.
 *
 * Deleting an archived Session is irreversible, which is why the automatic
 * path never deletes: it moves the Session's materials into a holding area on
 * the same volume (rename, not copy) and only the expiry sweep removes them
 * for good. Every moved path is recorded so a restore puts the bytes back
 * exactly where they came from.
 *
 * Layout under the DSH home:
 *   storages/archived-purge/quarantine/<stamp>-<session-id>/manifest.json
 *   storages/archived-purge/quarantine/<stamp>-<session-id>/data/...
 *
 * Registry bookkeeping (workspace slot + archive marker) is deliberately NOT
 * touched here: an archived Session is already hidden, so it can stay in the
 * marker while its files are held. The permanent phase clears the marker, and
 * that ordering is what makes "undo" complete instead of cosmetic.
 *
 * The store lives next to the sessions it holds on purpose. Same volume means
 * `rename` is atomic and instant; a copy to another drive could be interrupted
 * by a crash and leave both halves half-written.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const STORE = 'archived-purge';
const MANIFEST = 'manifest.json';
const DATA = 'data';

/** Root of everything this plugin keeps beside the host's own stores. */
export function storeRoot(home) {
  return path.join(home, 'storages', STORE);
}

export function quarantineRoot(home) {
  return path.join(storeRoot(home), 'quarantine');
}

/** Append-only audit trail; one JSON object per line. */
export function logFile(home) {
  return path.join(storeRoot(home), 'purge-log.jsonl');
}

/** User-editable defaults, so behaviour is configuration, not code. */
export function configFile(home) {
  return path.join(storeRoot(home), 'config.json');
}

export function autoStateFile(home) {
  return path.join(storeRoot(home), 'auto-state.json');
}

/** Directory spelling of a capture time: sortable, path-safe, keeps milliseconds. */
export function entryIdOf(capturedAt, sessionId) {
  const iso = new Date(capturedAt).toISOString();
  return `${iso.replace(/[-:]/g, '')}-${sessionId}`;
}

export function entryDir(home, entryId) {
  return path.join(quarantineRoot(home), entryId);
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text);
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    return Boolean(error) && error.code !== 'ENOENT';
  }
}

/** Bytes below one file or directory, without following symlinks. */
export async function sizeOf(target) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    total += await sizeOf(path.join(target, entry.name));
  }
  return total;
}

/**
 * Move one path. A rename keeps the volume atomic; EXDEV means the target
 * lives on another drive, where a recursive copy is the only option and the
 * source is removed only after the copy finished.
 */
export async function movePath(from, to) {
  if (!(await exists(from))) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return true;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }
  await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
  await fsp.rm(from, { recursive: true, force: true });
  return true;
}

async function sourcesOf(input) {
  const candidates = [];
  for (const dir of input.logDirs ?? []) {
    candidates.push({ kind: 'log', from: dir });
  }
  if (input.cacheFile) candidates.push({ kind: 'cache', from: input.cacheFile });
  for (const file of input.artifacts ?? []) {
    candidates.push({ kind: 'artifact', from: file });
  }
  const sources = [];
  for (const candidate of candidates) {
    // A path the caller only assumed exists (a missing projection-cache row, a
    // produced file the user already deleted) must not become a manifest entry:
    // restore would then try to move back something that was never moved.
    if (await exists(candidate.from)) sources.push(candidate);
  }
  return sources;
}

function dataTarget(entryDirPath, source, index) {
  const base = path.basename(source.from);
  if (source.kind === 'log') return path.join(entryDirPath, DATA, 'logs', `${index}-${base}`);
  if (source.kind === 'cache') return path.join(entryDirPath, DATA, 'cache', base);
  return path.join(entryDirPath, DATA, 'artifacts', `${index}-${base}`);
}

/**
 * Move a Session's materials into the quarantine.
 *
 * The manifest is written before the first move: a crash mid-way then leaves a
 * readable record of every path the entry owns, which is exactly what restore
 * needs to put back what did move and ignore what did not.
 */
export async function quarantineEntry(home, input) {
  const capturedAt = input.capturedAt ?? Date.now();
  const entryId = entryIdOf(capturedAt, input.sessionId);
  const dir = entryDir(home, entryId);
  if (await exists(dir)) {
    throw Object.assign(new Error(`隔离条目已存在：${entryId}`), { code: 'entry-exists' });
  }
  const sources = await sourcesOf(input);
  if (sources.length === 0) {
    throw Object.assign(new Error('没有可搬移的材料'), { code: 'nothing-to-quarantine' });
  }
  const items = sources.map((source, index) => ({
    kind: source.kind,
    from: path.resolve(source.from),
    to: dataTarget(dir, source, index),
  }));
  const manifest = {
    schema: 1,
    status: 'moving',
    entryId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    workspaceTitle: input.workspaceTitle ?? null,
    title: input.title ?? null,
    reason: input.reason ?? 'auto',
    capturedAt,
    expiresAt: capturedAt + Math.max(1, Number(input.retainDays) || 7) * 24 * 60 * 60 * 1000,
    bytes: 0,
    items,
  };
  await writeJson(path.join(dir, MANIFEST), manifest);
  let bytes = 0;
  for (const item of items) {
    bytes += await sizeOf(item.from);
    try {
      await movePath(item.from, item.to);
    } catch (error) {
      manifest.status = 'partial';
      manifest.error = String(error && error.message ? error.message : error);
      manifest.bytes = bytes;
      await writeJson(path.join(dir, MANIFEST), manifest);
      throw error;
    }
  }
  manifest.status = 'quarantined';
  manifest.bytes = bytes;
  await writeJson(path.join(dir, MANIFEST), manifest);
  return manifest;
}

export async function readEntry(home, entryId) {
  const file = path.join(entryDir(home, entryId), MANIFEST);
  try {
    const manifest = await readJson(file);
    return manifest && typeof manifest === 'object' ? manifest : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Every readable entry, newest first. Broken entries are reported, not hidden. */
export async function listEntries(home) {
  const root = quarantineRoot(home);
  let names;
  try {
    names = await fsp.readdir(root);
  } catch {
    return { entries: [], broken: [] };
  }
  const entries = [];
  const broken = [];
  for (const name of names) {
    try {
      const manifest = await readEntry(home, name);
      if (manifest) entries.push(manifest);
      else broken.push({ entryId: name, reason: 'manifest-missing' });
    } catch (error) {
      broken.push({ entryId: name, reason: String(error && error.message ? error.message : error) });
    }
  }
  entries.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  return { entries, broken };
}

/** Put one entry's bytes back. Returns what moved and what had to be skipped. */
export async function restoreEntry(home, entryId) {
  const manifest = await readEntry(home, entryId);
  if (!manifest) {
    return { ok: false, code: 'entry-missing', message: `隔离条目不存在：${entryId}`, restored: [], skipped: [] };
  }
  const restored = [];
  const skipped = [];
  for (const item of manifest.items ?? []) {
    if (!isInside(quarantineRoot(home), item.to)) {
      skipped.push({ from: item.to, reason: 'outside-quarantine' });
      continue;
    }
    if (!(await exists(item.to))) {
      skipped.push({ from: item.from, reason: 'not-quarantined' });
      continue;
    }
    if (await exists(item.from)) {
      skipped.push({ from: item.from, reason: 'target-exists' });
      continue;
    }
    try {
      await movePath(item.to, item.from);
      restored.push(item.from);
    } catch (error) {
      skipped.push({ from: item.from, reason: String(error && error.message ? error.message : error) });
    }
  }
  if (skipped.length === 0) await fsp.rm(entryDir(home, entryId), { recursive: true, force: true });
  return { ok: skipped.length === 0, entryId, restored, skipped };
}

/** Permanent removal of one held entry. The caller decides when it is due. */
export async function purgeEntry(home, entryId) {
  if (!isInside(quarantineRoot(home), entryDir(home, entryId))) {
    return { ok: false, code: 'outside-quarantine', message: '条目路径越界' };
  }
  await fsp.rm(entryDir(home, entryId), { recursive: true, force: true });
  return { ok: true, entryId };
}

/** Entries whose retention window has passed. */
export function expiredEntries(entries, now = Date.now()) {
  return entries.filter((entry) => entry.status !== 'moving' && Number(entry.expiresAt) > 0 && Number(entry.expiresAt) <= now);
}

/** One JSON line per decision; a log is the only audit trail this plugin keeps. */
export async function appendLog(home, record) {
  const file = logFile(home);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readLog(home, limit = 50) {
  let text;
  try {
    text = await fsp.readFile(logFile(home), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { broken: line.slice(0, 200) };
      }
    });
}
