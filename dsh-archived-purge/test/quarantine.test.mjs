import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendLog,
  entryDir,
  entryIdOf,
  expiredEntries,
  exists,
  listEntries,
  purgeEntry,
  quarantineEntry,
  quarantineRoot,
  readEntry,
  readLog,
  restoreEntry,
} from '../lib/quarantine.js';

async function makeHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'apq-test-'));
}

async function makeLog(home, id, bytes = 64) {
  const dir = path.join(home, 'sessions', '--C-tmp-proj--', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl'), Buffer.alloc(bytes, 1));
  return dir;
}

async function makeCache(home, id) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await fsp.writeFile(file, JSON.stringify({ version: 7, record: { rows: {} } }));
  return file;
}

test('quarantineEntry moves the log, cache and produced files into the holding area', async () => {
  const home = await makeHome();
  const id = 'sess-a';
  const logDir = await makeLog(home, id);
  const cacheFile = await makeCache(home, id);
  const artifact = path.join(home, 'produced', 'report.md');
  await fsp.mkdir(path.dirname(artifact), { recursive: true });
  await fsp.writeFile(artifact, 'hello');

  const manifest = await quarantineEntry(home, {
    sessionId: id,
    logDirs: [logDir],
    cacheFile,
    artifacts: [artifact],
    capturedAt: 1000,
    retainDays: 3,
  });

  assert.equal(manifest.status, 'quarantined');
  assert.equal(manifest.items.length, 3);
  assert.equal(await exists(logDir), false);
  assert.equal(await exists(cacheFile), false);
  assert.equal(await exists(artifact), false);
  assert.ok(manifest.bytes > 0);
  assert.equal(manifest.expiresAt, 1000 + 3 * 24 * 60 * 60 * 1000);
  const held = path.join(entryDir(home, manifest.entryId), 'data', 'logs', `0-${id}`);
  assert.ok((await fsp.stat(held)).isDirectory());
});

test('restoreEntry puts every byte back and drops the entry', async () => {
  const home = await makeHome();
  const id = 'sess-b';
  const logDir = await makeLog(home, id);
  const cacheFile = await makeCache(home, id);
  const manifest = await quarantineEntry(home, { sessionId: id, logDirs: [logDir], cacheFile, capturedAt: 2000 });

  const outcome = await restoreEntry(home, manifest.entryId);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped.length, 0);
  assert.ok((await fsp.stat(logDir)).isDirectory());
  assert.ok((await fsp.stat(cacheFile)).isFile());
  assert.equal(await exists(entryDir(home, manifest.entryId)), false);
});

test('restoreEntry refuses to overwrite a path that came back and keeps the entry', async () => {
  const home = await makeHome();
  const id = 'sess-c';
  const logDir = await makeLog(home, id);
  const manifest = await quarantineEntry(home, { sessionId: id, logDirs: [logDir], capturedAt: 3000 });
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(path.join(logDir, 'someone-else.txt'), 'keep me');

  const outcome = await restoreEntry(home, manifest.entryId);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.skipped[0].reason, 'target-exists');
  assert.equal(await readEntry(home, manifest.entryId) !== null, true);
  assert.equal(await fsp.readFile(path.join(logDir, 'someone-else.txt'), 'utf8'), 'keep me');
});

test('restoreEntry reports a missing entry instead of inventing one', async () => {
  const home = await makeHome();
  const outcome = await restoreEntry(home, '20260101T000000000Z-sess-x');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'entry-missing');
});

test('purgeEntry refuses a path outside the quarantine root', async () => {
  const home = await makeHome();
  await fsp.mkdir(quarantineRoot(home), { recursive: true });
  const outside = path.join(home, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  const outcome = await purgeEntry(home, '../outside');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'outside-quarantine');
  assert.ok((await fsp.stat(outside)).isDirectory());
});

test('purgeEntry removes a held entry for good', async () => {
  const home = await makeHome();
  const id = 'sess-d';
  const logDir = await makeLog(home, id);
  const manifest = await quarantineEntry(home, { sessionId: id, logDirs: [logDir], capturedAt: 4000 });
  const outcome = await purgeEntry(home, manifest.entryId);
  assert.equal(outcome.ok, true);
  assert.equal(await exists(entryDir(home, manifest.entryId)), false);
  const listed = await listEntries(home);
  assert.equal(listed.entries.length, 0);
});

test('quarantineEntry refuses when nothing it was told about exists', async () => {
  const home = await makeHome();
  await assert.rejects(
    () => quarantineEntry(home, { sessionId: 'sess-e', logDirs: [path.join(home, 'gone')], capturedAt: 5000 }),
    (error) => error.code === 'nothing-to-quarantine',
  );
});

test('a second capture of the same Session at the same instant is refused', async () => {
  const home = await makeHome();
  const id = 'sess-f';
  const logDir = await makeLog(home, id);
  await quarantineEntry(home, { sessionId: id, logDirs: [logDir], capturedAt: 6000 });
  const again = await makeLog(home, id);
  await assert.rejects(
    () => quarantineEntry(home, { sessionId: id, logDirs: [again], capturedAt: 6000 }),
    (error) => error.code === 'entry-exists',
  );
});

test('expiredEntries honours the retention window and ignores half-written entries', () => {
  const now = 10_000;
  const entries = [
    { entryId: 'a', status: 'quarantined', expiresAt: now - 1 },
    { entryId: 'b', status: 'quarantined', expiresAt: now + 1 },
    { entryId: 'c', status: 'moving', expiresAt: now - 1 },
  ];
  assert.deepEqual(expiredEntries(entries, now).map((entry) => entry.entryId), ['a']);
});

test('entryIdOf is sortable and path-safe', () => {
  const id = entryIdOf(Date.UTC(2026, 10, 13, 4, 5, 6), 'session-abc');
  assert.equal(id, '20261113T040506.000Z-session-abc');
  assert.equal(/[\\/:*?"<>|]/.test(id), false);
});

test('the audit log appends one JSON line per decision and stays readable', async () => {
  const home = await makeHome();
  await appendLog(home, { at: 't1', event: 'auto-run', held: [] });
  await appendLog(home, { at: 't2', event: 'auto-run', held: [{ sessionId: 'x' }] });
  const log = await readLog(home, 10);
  assert.equal(log.length, 2);
  assert.equal(log[1].held[0].sessionId, 'x');
  assert.deepEqual(await readLog(home, 1), [{ at: 't2', event: 'auto-run', held: [{ sessionId: 'x' }] }]);
});
