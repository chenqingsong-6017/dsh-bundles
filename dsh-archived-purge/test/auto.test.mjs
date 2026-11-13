import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  mergeConfig,
  readAutoState,
  readConfig,
  runOnce,
  startScheduler,
  summary,
} from '../lib/auto.js';
import { configFile, exists, listEntries, quarantineEntry, readLog } from '../lib/quarantine.js';

const DAY = 24 * 60 * 60 * 1000;

async function makeHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'apa-test-'));
}

async function writeConfig(home, patch) {
  await fsp.mkdir(path.dirname(configFile(home)), { recursive: true });
  await fsp.writeFile(configFile(home), JSON.stringify(patch));
}

async function makeSessionLog(home, id, bytes = 128) {
  const dir = path.join(home, 'sessions', '--C-tmp-proj--', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl'), Buffer.alloc(bytes, 2));
  return dir;
}

function row(id, logDirs, overrides = {}) {
  return {
    id,
    title: id,
    workspaceId: 'w1',
    workspaceTitle: 'demo',
    logDirs,
    cacheFile: logDirs.length > 0 ? path.join(path.dirname(logDirs[0]), `${id}.json`) : null,
    bytes: 128,
    lastActivity: Date.now() - 5 * DAY,
    resident: false,
    scheduleCount: 0,
    ...overrides,
  };
}

async function fixture(rows, options = {}) {
  const home = options.home ?? (await makeHome());
  const calls = { discarded: [], activities: [] };
  const deps = {
    home,
    logger: { info() {}, warn() {} },
    notify: options.notify,
    archivedView: async () => rows,
    activityOf: async (id) => {
      calls.activities.push(id);
      if (options.activityThrows) throw new Error('waterfall unavailable');
      return options.activity ?? [];
    },
    artifactsOf: async () => options.artifacts ?? [],
    discard: async (id) => {
      calls.discarded.push(id);
      return { detached: true, unarchived: true };
    },
    // Default: the Session is still archived, so reconciliation leaves it held.
    isArchived: async () => options.archived ?? true,
  };
  return { home, deps, calls };
}

test('the first read writes the default configuration where a human can edit it', async () => {
  const home = await makeHome();
  const { config, created } = await readConfig(home);
  assert.equal(created, true);
  assert.deepEqual(config, { ...DEFAULT_CONFIG });
  assert.ok((await fsp.stat(configFile(home))).isFile());
  const again = await readConfig(home);
  assert.equal(again.created, false);
});

test('mergeConfig clamps what a hand-edited file may contain', () => {
  const config = mergeConfig({ enabled: false, intervalHours: 10_000, graceDays: 'abc', retainDays: 0, maxPerRun: -3 });
  assert.equal(config.enabled, false);
  assert.equal(config.intervalHours, 168);
  assert.equal(config.graceDays, DEFAULT_CONFIG.graceDays);
  assert.equal(config.retainDays, 1);
  assert.equal(config.maxPerRun, 1);
});

test('a disabled sweep does nothing at all', async () => {
  const home = await makeHome();
  await writeConfig(home, { enabled: false });
  const logDir = await makeSessionLog(home, 'sess-off');
  const { deps } = await fixture([row('sess-off', [logDir])], { home });
  const result = await runOnce(deps);
  assert.equal(result.disabled, true);
  assert.equal(result.held.length, 0);
  assert.ok((await fsp.stat(logDir)).isDirectory());
  assert.deepEqual(await readLog(home), []);
});

test('a dry run reports the same decision without moving a byte', async () => {
  const home = await makeHome();
  await writeConfig(home, { graceDays: 1 });
  const logDir = await makeSessionLog(home, 'sess-dry');
  const { deps } = await fixture([row('sess-dry', [logDir])], { home });
  const result = await runOnce(deps, { dryRun: true });
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].dryRun, true);
  assert.ok((await fsp.stat(logDir)).isDirectory());
  assert.deepEqual(await readLog(home), []);
  assert.deepEqual(await readAutoState(home), {});
});

test('an idle Session past the grace window is held and the decision is logged', async () => {
  const home = await makeHome();
  await writeConfig(home, { graceDays: 1, retainDays: 7 });
  const logDir = await makeSessionLog(home, 'sess-hold');
  const { deps } = await fixture([row('sess-hold', [logDir])], { home });
  const result = await runOnce(deps);
  assert.equal(result.held.length, 1);
  assert.equal(await exists(logDir), false);
  const { entries } = await listEntries(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 'sess-hold');
  const log = await readLog(home);
  assert.equal(log.length, 1);
  assert.equal(log[0].event, 'auto-run');
  const state = await readAutoState(home);
  assert.equal(state.lastResult.held, 1);
  assert.ok(state.lastRunAt > 0);
});

test('every refusal reason is distinct, so the log answers "why not mine"', async () => {
  const home = await makeHome();
  await writeConfig(home, { graceDays: 1 });
  const fresh = await makeSessionLog(home, 'sess-fresh');
  const resident = await makeSessionLog(home, 'sess-resident');
  const scheduled = await makeSessionLog(home, 'sess-scheduled');
  const unknowns = await makeSessionLog(home, 'sess-unknown');
  const active = await makeSessionLog(home, 'sess-active');
  const noLog = path.join(home, 'sessions', '--C-tmp-proj--', 'sess-nolog');
  const rows = [
    row('sess-fresh', [fresh], { lastActivity: Date.now() - 1000 }),
    row('sess-resident', [resident], { resident: true }),
    row('sess-scheduled', [scheduled], { scheduleCount: 2 }),
    row('sess-unknown', [unknowns], { lastActivity: null }),
    row('sess-active', [active]),
    row('sess-nolog', []),
  ];
  const activeDeps = await fixture(rows, { home, activity: ['turn'] });
  const result = await runOnce(activeDeps.deps);
  const reasons = Object.fromEntries(result.skipped.map((item) => [item.id, item.reason]));
  assert.equal(reasons['sess-fresh'], 'within-grace');
  assert.equal(reasons['sess-resident'], 'resident');
  assert.equal(reasons['sess-scheduled'], 'has-schedules');
  assert.equal(reasons['sess-unknown'], 'unknown-age');
  assert.equal(reasons['sess-active'], 'session-active');
  assert.equal(reasons['sess-nolog'], 'no-log');
  assert.equal(result.held.length, 0);

  const throwing = await fixture(rows, { home, activityThrows: true });
  const refused = await runOnce(throwing.deps);
  const unknown = refused.skipped.find((item) => item.id === 'sess-active');
  assert.equal(unknown.reason, 'activity-unknown');
});

test('the per-run count cap and the byte budget both hold', async () => {
  const home = await makeHome();
  await writeConfig(home, { graceDays: 1, maxPerRun: 1, maxBytesPerRun: 1024 });
  const a = await makeSessionLog(home, 'sess-cap-a');
  const b = await makeSessionLog(home, 'sess-cap-b');
  const big = await makeSessionLog(home, 'sess-big', 4096);
  const bigBytes = 2 * 1024 * 1024;
  const { deps } = await fixture([
    row('sess-big', [big], { bytes: bigBytes }),
    row('sess-cap-a', [a]),
    row('sess-cap-b', [b]),
  ], { home });
  const result = await runOnce(deps);
  assert.equal(result.held.length, 1);
  const reasons = Object.fromEntries(result.skipped.map((item) => [item.id, item.reason]));
  assert.equal(reasons['sess-cap-b'], 'run-cap');
  assert.equal(reasons['sess-big'], 'bytes-budget');
});

test('the expiry sweep removes held bytes and clears the bookkeeping', async () => {
  const home = await makeHome();
  const logDir = await makeSessionLog(home, 'sess-expire');
  const manifest = await quarantineEntry(home, {
    sessionId: 'sess-expire',
    logDirs: [logDir],
    capturedAt: Date.now() - 10 * DAY,
    retainDays: 1,
  });
  const { deps, calls } = await fixture([], { home });
  const result = await runOnce(deps, { onlyExpired: true, force: true });
  assert.equal(result.purged.length, 1);
  assert.deepEqual(calls.discarded, ['sess-expire']);
  const { entries } = await listEntries(home);
  assert.equal(entries.length, 0);
  assert.equal(entries.some((entry) => entry.entryId === manifest.entryId), false);
});

test('a held entry that is not due yet survives an expiry sweep', async () => {
  const home = await makeHome();
  const logDir = await makeSessionLog(home, 'sess-keep');
  await quarantineEntry(home, { sessionId: 'sess-keep', logDirs: [logDir], capturedAt: Date.now() });
  const { deps } = await fixture([], { home });
  const result = await runOnce(deps, { onlyExpired: true, force: true });
  assert.equal(result.purged.length, 0);
  assert.equal((await listEntries(home)).entries.length, 1);
});

test('summary answers what is held, what is due and when the next round is', async () => {
  const home = await makeHome();
  await writeConfig(home, { intervalHours: 5 });
  const logDir = await makeSessionLog(home, 'sess-sum');
  await quarantineEntry(home, { sessionId: 'sess-sum', logDirs: [logDir], capturedAt: Date.now(), retainDays: 7 });
  const { deps } = await fixture([], { home });
  await runOnce(deps, { onlyExpired: true, force: true });
  const payload = await summary(deps);
  assert.equal(payload.held.length, 1);
  assert.equal(payload.held[0].sessionId, 'sess-sum');
  assert.ok(payload.held[0].expiresInMs > 6 * DAY);
  assert.ok(payload.lastRunAt > 0);
  assert.equal(payload.nextRunAt, payload.lastRunAt + 5 * 60 * 60 * 1000);
  assert.equal(payload.enabled, true);
});

test('the scheduler can be disposed and leaves nothing running behind', async () => {
  const home = await makeHome();
  await writeConfig(home, { enabled: false });
  const { deps } = await fixture([], { home });
  const stop = startScheduler(deps);
  assert.equal(typeof stop, 'function');
  stop();
  stop();
});

test('a held Session the user un-archived is restored instead of purged later', async () => {
  const home = await makeHome();
  const logDir = await makeSessionLog(home, 'sess-back');
  await quarantineEntry(home, { sessionId: 'sess-back', logDirs: [logDir], capturedAt: Date.now() });
  const { deps } = await fixture([], { home, archived: false });
  const result = await runOnce(deps, { onlyExpired: true, force: true });
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].sessionId, 'sess-back');
  assert.ok((await fsp.stat(logDir)).isDirectory());
  assert.equal((await listEntries(home)).entries.length, 0);
});

test('the expiry sweep re-asks liveness and defers an active Session', async () => {
  const home = await makeHome();
  const logDir = await makeSessionLog(home, 'sess-busy');
  await quarantineEntry(home, {
    sessionId: 'sess-busy',
    logDirs: [logDir],
    capturedAt: Date.now() - 10 * DAY,
    retainDays: 1,
  });
  const { deps, calls } = await fixture([], { home, activity: ['turn'] });
  const result = await runOnce(deps, { onlyExpired: true, force: true });
  assert.equal(result.purged.length, 0);
  assert.equal(result.skipped[0].reason, 'active-at-expiry');
  assert.deepEqual(calls.discarded, []);
  assert.equal((await listEntries(home)).entries.length, 1);
});

test('purgeOnExpiry:false holds past the retention window instead of deleting', async () => {
  const home = await makeHome();
  await writeConfig(home, { purgeOnExpiry: false });
  const logDir = await makeSessionLog(home, 'sess-keep-forever');
  await quarantineEntry(home, {
    sessionId: 'sess-keep-forever',
    logDirs: [logDir],
    capturedAt: Date.now() - 10 * DAY,
    retainDays: 1,
  });
  const { deps } = await fixture([], { home });
  const result = await runOnce(deps, { onlyExpired: true, force: true });
  assert.equal(result.purged.length, 0);
  assert.equal((await listEntries(home)).entries.length, 1);
});
