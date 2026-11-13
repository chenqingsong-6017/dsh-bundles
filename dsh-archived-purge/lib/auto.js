/**
 * Automatic sweep for dsh-archived-purge.
 *
 * The manual page answers "clean these now". This module answers "clean what
 * nobody came back for": on a fixed beat it takes archived Sessions that have
 * been idle past a grace window, moves their materials into the quarantine,
 * and only the expiry sweep removes them for good. Nothing here deletes on the
 * first pass — that is the whole safety story.
 *
 * Prior art for the guards below is recorded as upstream-ledger id
 * `session-lifecycle-prior-art` (Hermes Agent: archive-only lifecycle;
 * claude-mem: activity pre-check before permanent removal, tombstone).
 *
 * Two guards were taken from authoritative prior art rather than invented:
 *   - the expiry sweep re-asks liveness instead of trusting the capture-time
 *     answer (claude-mem's activity pre-check before permanent removal), and
 *   - a held Session that the user un-archives is restored automatically
 *     (Hermes archives, it never deletes; un-archiving means "I want this").
 *
 * Every decision is appended to `purge-log.jsonl`; no memory entry is written,
 * because the log is the audit trail and the memory store is not a log.
 *
 * The runner is dependency-injected on purpose: the Host owns liveness
 * (`workspace/session-activity`), the registry and the derivation of what a
 * Session produced, so this file stays testable with plain fakes.
 */
import {
  appendLog,
  autoStateFile,
  configFile,
  entryDir,
  expiredEntries,
  listEntries,
  logFile,
  purgeEntry,
  quarantineEntry,
  readJson,
  restoreEntry,
  writeJson,
} from './quarantine.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const DEFAULT_CONFIG = Object.freeze({
  schema: 1,
  enabled: true,
  intervalHours: 6,
  startupDelaySeconds: 90,
  graceDays: 30,
  retainDays: 7,
  maxPerRun: 20,
  maxBytesPerRun: 2 * 1024 * 1024 * 1024,
  minArchiveAgeMinutes: 30,
  skipWithSchedules: true,
  purgeOnExpiry: true,
  notify: true,
});

function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Fill every key from defaults so a half-written config file cannot change behaviour silently. */
export function mergeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: 1,
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled !== false,
    intervalHours: num(source.intervalHours, DEFAULT_CONFIG.intervalHours, 0.1, 168),
    startupDelaySeconds: num(source.startupDelaySeconds, DEFAULT_CONFIG.startupDelaySeconds, 0, 3600),
    graceDays: num(source.graceDays, DEFAULT_CONFIG.graceDays, 1, 3650),
    retainDays: num(source.retainDays, DEFAULT_CONFIG.retainDays, 1, 365),
    maxPerRun: num(source.maxPerRun, DEFAULT_CONFIG.maxPerRun, 1, 200),
    maxBytesPerRun: num(source.maxBytesPerRun, DEFAULT_CONFIG.maxBytesPerRun, 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    minArchiveAgeMinutes: num(source.minArchiveAgeMinutes, DEFAULT_CONFIG.minArchiveAgeMinutes, 0, 10080),
    skipWithSchedules: source.skipWithSchedules === undefined ? DEFAULT_CONFIG.skipWithSchedules : source.skipWithSchedules !== false,
    purgeOnExpiry: source.purgeOnExpiry === undefined ? DEFAULT_CONFIG.purgeOnExpiry : source.purgeOnExpiry !== false,
    notify: source.notify === undefined ? DEFAULT_CONFIG.notify : source.notify !== false,
  };
}

export async function readConfig(home) {
  const file = configFile(home);
  let raw = null;
  let created = false;
  try {
    raw = await readJson(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    created = true;
  }
  const config = mergeConfig(raw);
  if (created) await writeJson(file, config);
  return { config, created };
}

export async function readAutoState(home) {
  try {
    const state = await readJson(autoStateFile(home));
    return state && typeof state === 'object' ? state : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveAutoState(home, state) {
  await writeJson(autoStateFile(home), { schema: 1, ...state });
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

/**
 * Decide one Session from the Host's own view. Returns `{ skip: reason }` or
 * `{ candidate }`. A Session whose age cannot be proven is skipped, never
 * treated as ancient.
 */
async function judge(deps, config, now, item) {
  if (!Array.isArray(item.logDirs) || item.logDirs.length === 0) return { skip: 'no-log' };
  if (item.resident === true) return { skip: 'resident' };
  const lastActivity = Number(item.lastActivity ?? 0);
  if (!Number.isFinite(lastActivity) || lastActivity <= 0) return { skip: 'unknown-age' };
  if (now - lastActivity < config.graceDays * DAY) return { skip: 'within-grace' };
  if (Number(item.scheduleCount ?? 0) > 0 && config.skipWithSchedules) return { skip: 'has-schedules' };
  let kinds;
  try {
    kinds = await deps.activityOf(item.id);
  } catch {
    // Without the waterfall this plugin cannot prove the Session is idle, and
    // guessing "idle" here would delete work in progress.
    return { skip: 'activity-unknown' };
  }
  if (Array.isArray(kinds) && kinds.length > 0) return { skip: 'session-active' };
  return {
    candidate: {
      id: item.id,
      title: item.title ?? null,
      workspaceId: item.workspaceId ?? null,
      workspaceTitle: item.workspaceTitle ?? null,
      logDirs: item.logDirs,
      cacheFile: item.cacheFile ?? null,
      bytes: Number(item.bytes ?? 0),
    },
  };
}

async function holdOne(deps, config, now, candidate) {
  if (candidate.bytes > config.maxBytesPerRun) return { skip: 'over-bytes-budget' };
  let artifacts = [];
  try {
    artifacts = await deps.artifactsOf(candidate.id);
  } catch (error) {
    // Produced files are part of the cleanup, but an unreadable log must not
    // cost the Session its logs: the log and cache still move.
    deps.logger?.warn?.(`archived-purge: artifact scan failed for ${candidate.id}: ${errorText(error)}`);
  }
  const manifest = await quarantineEntry(deps.home, {
    sessionId: candidate.id,
    workspaceId: candidate.workspaceId,
    workspaceTitle: candidate.workspaceTitle,
    title: candidate.title,
    logDirs: candidate.logDirs,
    cacheFile: candidate.cacheFile,
    artifacts,
    reason: 'auto',
    capturedAt: now,
    retainDays: config.retainDays,
  });
  return {
    held: {
      entryId: manifest.entryId,
      sessionId: candidate.id,
      title: candidate.title,
      bytes: manifest.bytes,
      expiresAt: manifest.expiresAt,
      files: (manifest.items ?? []).length,
    },
  };
}

/**
 * A held Session the user un-archived means "I want this back": put the bytes
 * back instead of deleting them a week later. A registry that cannot answer
 * leaves the entry alone — this is a reconciliation, not a gamble.
 */
async function reconcile(deps, entries, result) {
  for (const entry of entries) {
    if (entry.status === 'moving') continue;
    let archived;
    try {
      archived = await deps.isArchived(entry.sessionId);
    } catch {
      continue;
    }
    if (archived !== false) continue;
    try {
      const outcome = await restoreEntry(deps.home, entry.entryId);
      result.reconciled.push({
        entryId: entry.entryId,
        sessionId: entry.sessionId,
        restored: outcome.restored.length,
        skipped: outcome.skipped.length,
      });
    } catch (error) {
      result.errors.push({ stage: 'reconcile', entryId: entry.entryId, message: errorText(error) });
    }
  }
}

/**
 * Permanent phase. Liveness is re-asked: capture-time idleness says nothing
 * about the Session a week later, and the expiry sweep is the only step that
 * cannot be undone.
 */
async function expireOne(deps, entry, result) {
  let kinds;
  try {
    kinds = await deps.activityOf(entry.sessionId);
  } catch {
    result.skipped.push({ id: entry.sessionId, reason: 'activity-unknown-at-expiry' });
    return;
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    result.skipped.push({ id: entry.sessionId, reason: 'active-at-expiry' });
    return;
  }
  try {
    await purgeEntry(deps.home, entry.entryId);
  } catch (error) {
    result.errors.push({ entryId: entry.entryId, stage: 'purge', message: errorText(error) });
    return;
  }
  let bookkeeping = null;
  try {
    bookkeeping = await deps.discard(entry.sessionId);
  } catch (error) {
    result.errors.push({ entryId: entry.entryId, stage: 'bookkeeping', message: errorText(error) });
  }
  result.purged.push({
    entryId: entry.entryId,
    sessionId: entry.sessionId,
    title: entry.title ?? null,
    bytes: Number(entry.bytes ?? 0),
    bookkeeping,
  });
  result.bytes += Number(entry.bytes ?? 0);
}

async function sweepExpired(deps, config, now, entries, result) {
  if (config.purgeOnExpiry !== true) return;
  for (const entry of expiredEntries(entries, now)) {
    if (result.dryRun) {
      result.purged.push({ entryId: entry.entryId, sessionId: entry.sessionId, dryRun: true });
      continue;
    }
    await expireOne(deps, entry, result);
  }
}

async function holdCandidates(deps, config, now, entries, result) {
  const held = new Set(entries.filter((entry) => entry.status !== 'moving').map((entry) => entry.sessionId));
  let view = [];
  try {
    view = await deps.archivedView();
  } catch (error) {
    result.errors.push({ stage: 'list', message: errorText(error) });
  }
  result.scanned = view.length;
  let budget = config.maxBytesPerRun;
  for (const item of view) {
    const id = item.id;
    if (result.held.length >= config.maxPerRun) {
      result.skipped.push({ id, reason: 'run-cap' });
      continue;
    }
    if (held.has(id)) {
      result.skipped.push({ id, reason: 'already-held' });
      continue;
    }
    const decision = await judge(deps, config, now, item);
    if (decision.skip) {
      result.skipped.push({ id, reason: decision.skip });
      continue;
    }
    if (decision.candidate.bytes > budget) {
      result.skipped.push({ id, reason: 'bytes-budget' });
      continue;
    }
    if (result.dryRun) {
      result.held.push({ sessionId: id, title: decision.candidate.title, bytes: decision.candidate.bytes, dryRun: true });
      budget -= decision.candidate.bytes;
      continue;
    }
    try {
      const outcome = await holdOne(deps, config, now, decision.candidate);
      if (outcome.skip) {
        result.skipped.push({ id, reason: outcome.skip });
        continue;
      }
      result.held.push(outcome.held);
      result.bytes += outcome.held.bytes;
      budget -= outcome.held.bytes;
    } catch (error) {
      result.errors.push({ id, stage: 'quarantine', message: errorText(error) });
    }
  }
}

function tallySkipped(list) {
  const counts = {};
  for (const item of list) {
    const key = String(item.reason).split(':')[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function recordOf(result, now) {
  return {
    at: new Date(now).toISOString(),
    event: result.dryRun ? 'auto-dry-run' : 'auto-run',
    held: result.held.map((item) => ({ sessionId: item.sessionId, title: item.title ?? null, bytes: item.bytes })),
    purged: result.purged.map((item) => ({ entryId: item.entryId, sessionId: item.sessionId, bytes: item.bytes })),
    reconciled: result.reconciled,
    scanned: result.scanned ?? 0,
    skipped: tallySkipped(result.skipped),
    errors: result.errors,
    bytes: result.bytes,
  };
}

/**
 * One sweep: reconcile what the user un-archived, expire what is due, then
 * hold what qualifies. `dryRun` reports the same decisions without moving
 * anything.
 */
export async function runOnce(deps, options = {}) {
  const now = Number(options.now ?? Date.now());
  const { config } = await readConfig(deps.home);
  if (options.force !== true && !config.enabled) {
    return { ok: true, at: now, disabled: true, held: [], purged: [], reconciled: [], skipped: [], errors: [], bytes: 0 };
  }
  const result = {
    ok: true,
    at: now,
    dryRun: options.dryRun === true,
    held: [],
    purged: [],
    reconciled: [],
    scanned: 0,
    skipped: [],
    errors: [],
    bytes: 0,
  };
  const { entries } = await listEntries(deps.home);
  if (result.dryRun !== true) await reconcile(deps, entries, result);
  await sweepExpired(deps, config, now, entries, result);
  if (options.onlyExpired !== true) await holdCandidates(deps, config, now, entries, result);
  result.ok = result.errors.length === 0;
  if (result.dryRun) return result;
  await appendLog(deps.home, recordOf(result, now));
  await saveAutoState(deps.home, {
    lastRunAt: now,
    lastResult: {
      held: result.held.length,
      purged: result.purged.length,
      reconciled: result.reconciled.length,
      scanned: result.scanned ?? 0,
      skipped: result.skipped.length,
      errors: result.errors.length,
      bytes: result.bytes,
    },
  });
  maybeNotify(deps, config, result);
  return result;
}

function maybeNotify(deps, config, result) {
  if (config.notify !== true || typeof deps.notify !== 'function') return;
  if (result.held.length === 0 && result.purged.length === 0) return;
  const megabytes = (result.bytes / (1024 * 1024)).toFixed(1);
  const parts = [];
  if (result.held.length > 0) parts.push(`隔离 ${result.held.length} 条（${config.retainDays} 天内可还原）`);
  if (result.purged.length > 0) parts.push(`永久清除 ${result.purged.length} 条`);
  try {
    deps.notify(`归档清理自动跑完：${parts.join('，')}，共 ${megabytes} MB`);
  } catch {
    /* a toast is best-effort; the log already has the record */
  }
}

/** Status payload for the Host route: configuration, last outcome and what is held. */
export async function summary(deps) {
  const { config } = await readConfig(deps.home);
  const state = await readAutoState(deps.home);
  const { entries, broken } = await listEntries(deps.home);
  const now = Date.now();
  const held = entries.map((entry) => ({
    entryId: entry.entryId,
    sessionId: entry.sessionId,
    title: entry.title ?? null,
    workspaceTitle: entry.workspaceTitle ?? null,
    status: entry.status,
    bytes: Number(entry.bytes ?? 0),
    capturedAt: entry.capturedAt ?? null,
    expiresAt: entry.expiresAt ?? null,
    expiresInMs: Number(entry.expiresAt ?? 0) - now,
    restorePath: entryDir(deps.home, entry.entryId),
  }));
  const lastRunAt = Number(state.lastRunAt ?? 0) || null;
  return {
    ok: true,
    config,
    enabled: config.enabled,
    lastRunAt,
    lastResult: state.lastResult ?? null,
    nextRunAt: lastRunAt ? lastRunAt + config.intervalHours * HOUR : null,
    held,
    heldBytes: held.reduce((sum, item) => sum + item.bytes, 0),
    broken,
    configFile: configFile(deps.home),
    logFile: logFile(deps.home),
  };
}

/**
 * Arm one timer. The sweep is a single unref'd timeout: it can never keep the
 * process alive, and `ctx.effect` disposes it with the plugin.
 * @returns {() => void} disposer for that one timer.
 */
function armTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
/**
 * Start the beat. Re-reads the config file every round, so switching
 * `enabled` on or off takes effect without a restart.
 * @returns {() => void} disposer for `ctx.effect`.
 */
export function startScheduler(deps) {
  const disposers = [];
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(deps);
    } catch (error) {
      deps.logger?.warn?.(`archived-purge: auto sweep failed: ${errorText(error)}`);
    } finally {
      running = false;
    }
  };
  const arm = async () => {
    let config;
    try {
      config = (await readConfig(deps.home)).config;
    } catch {
      config = mergeConfig(null);
    }
    if (stopped) return;
    disposers.push(armTimer(() => void tick().then(() => void arm()), Math.max(1, config.intervalHours) * HOUR));
  };
  void readConfig(deps.home)
    .then(({ config }) => {
      if (stopped || !config.enabled) return;
      disposers.push(armTimer(() => void tick(), Math.max(0, config.startupDelaySeconds) * 1000));
      return arm();
    })
    .catch((error) => deps.logger?.warn?.(`archived-purge: auto scheduler failed to start: ${errorText(error)}`));
  return () => {
    stopped = true;
    for (const dispose of disposers.splice(0)) dispose();
  };
}
