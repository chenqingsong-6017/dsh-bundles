import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';
import { configFile, exists, listEntries, logFile } from '../lib/quarantine.js';

/**
 * Drives the real `apply()` so the automatic-sweep routes and the three tools
 * are pinned at their wire contract: a default run never moves bytes, an
 * explicit confirm does, and restore puts them back.
 */

const DAY = 24 * 60 * 60 * 1000;

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archived-purge-auto-'));
  const project = path.join(home, 'sessions', '--C-tmp-proj--');
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  await fsp.mkdir(cache, { recursive: true });
  const makeSession = async (id, title, ageDays) => {
    const dir = path.join(project, id);
    await fsp.mkdir(dir, { recursive: true });
    const log = path.join(dir, 'session.v4.jsonl.zstd');
    await fsp.writeFile(log, Buffer.alloc(2048, 9));
    const stamp = new Date(Date.now() - ageDays * DAY);
    await fsp.utimes(log, stamp, stamp);
    const cacheFile = path.join(cache, `${id}.json`);
    await fsp.writeFile(cacheFile, JSON.stringify({
      record: { rows: { title: { val: title } } },
    }));
    // `lastActivity` is the newest of log and projection cache: age both.
    await fsp.utimes(cacheFile, stamp, stamp);
    return dir;
  };
  const idle = await makeSession('session-idle', 'Idle one', 10);
  const fresh = await makeSession('session-fresh', 'Fresh one', 0);
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: ['session-idle', 'session-fresh'], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        w1: { path: 'C:\\tmp\\proj', title: 'demo', sessionIds: ['session-idle', 'session-fresh'] },
      },
    },
  }));
  return { home, idle, fresh };
}

function makeCtx(home, options = {}) {
  const routes = new Map();
  const tools = new Map();
  const ctx = {
    sessions: { get: (id) => (options.resident?.includes(id) ? { id } : undefined) },
    workspaceRegistry: {
      list: () => [{
        id: 'w1',
        sessionIds: ['session-idle', 'session-fresh'],
        detachSession: async () => {},
      }],
      unarchiveSession: async () => {},
    },
    sessionPersistence: undefined,
    waterfall: async (name, payload, next) => {
      assert.equal(name, 'workspace/session-activity');
      return options.activity ? options.activity(payload.sessionId) : [];
    },
    effect(fn) {
      fn();
    },
    logger: { info() {}, warn() {} },
    tools: {
      register(spec) {
        tools.set(spec.name, spec);
        return () => tools.delete(spec.name);
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes, tools };
}

function makeReq(method, body, extra = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:10094',
    ...extra,
  };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

async function call(routes, routePath, method, body, extra) {
  const res = makeRes();
  await routes.get(routePath).handler(makeReq(method, body, extra), res);
  return { status: res.status, payload: res.body ? JSON.parse(res.body) : undefined };
}

async function writeConfig(home, patch) {
  await fsp.mkdir(path.dirname(configFile(home)), { recursive: true });
  await fsp.writeFile(configFile(home), JSON.stringify({
    graceDays: 1,
    retainDays: 7,
    intervalHours: 168,
    // Keep the automatic beat out of the test window: `apply()` arms it.
    startupDelaySeconds: 3600,
    notify: false,
    ...patch,
  }));
}

async function setup(options = {}) {
  const { home, idle, fresh } = await makeHome();
  // The config must exist before `apply()`: the scheduler's first read creates
  // the default file when it is missing, and that write would race the test's.
  await writeConfig(home, options.config);
  // `apply()` resolves the DSH home from the environment, exactly like the Host.
  process.env.DSH_HOME = home;
  const { ctx, routes, tools } = makeCtx(home, options);
  apply(ctx);
  return { home, idle, fresh, routes, tools };
}

const AUTO = '/plugins/archived-purge/auto';
const RUN = `${AUTO}/run`;
const RESTORE = `${AUTO}/restore`;
const PURGE = `${AUTO}/purge-expired`;

test('status route reports the configuration, the last run and what is held', async () => {
  const { routes } = await setup();
  const { status, payload } = await call(routes, AUTO, 'GET');
  assert.equal(status, 200);
  assert.equal(payload.enabled, true);
  assert.equal(payload.config.graceDays, 1);
  assert.equal(payload.config.retainDays, 7);
  assert.deepEqual(payload.held, []);
});

test('a default run is a dry run: it reports the decision and moves no byte', async () => {
  const { home, idle, routes } = await setup();
  const { status, payload } = await call(routes, RUN, 'POST', {});
  assert.equal(status, 200);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.scanned, 2);
  assert.equal(payload.held.length, 1);
  assert.equal(payload.held[0].sessionId, 'session-idle');
  assert.ok((await fsp.stat(idle)).isDirectory());
  assert.deepEqual(await listEntries(home), { entries: [], broken: [] });
  await assert.rejects(() => fsp.stat(logFile(home)), (error) => error.code === 'ENOENT');
});

test('apply:true holds the idle Session, and restore brings it back', async () => {
  const { home, idle, routes } = await setup();
  const applied = await call(routes, RUN, 'POST', { apply: true });
  assert.equal(applied.status, 200);
  assert.equal(applied.payload.dryRun, false);
  assert.equal(applied.payload.held.length, 1);
  assert.equal(await exists(idle), false);
  const entryId = applied.payload.held[0].entryId;
  const { entries } = await listEntries(home);
  assert.equal(entries.length, 1);
  assert.equal((await fsp.stat(logFile(home))).isFile(), true);

  const held = await call(routes, AUTO, 'GET');
  assert.equal(held.payload.held.length, 1);
  assert.equal(held.payload.held[0].entryId, entryId);

  const restored = await call(routes, RESTORE, 'POST', { entryId });
  assert.equal(restored.status, 200);
  assert.equal(restored.payload.ok, true);
  assert.ok((await fsp.stat(idle)).isDirectory());
  const after = await call(routes, AUTO, 'GET');
  assert.equal(after.payload.held.length, 0);
});

test('restore refuses a path-shaped entry id instead of touching the store', async () => {
  const { routes } = await setup();
  const evil = await call(routes, RESTORE, 'POST', { entryId: '../escape' });
  assert.equal(evil.status, 400);
  assert.equal(evil.payload.code, 'invalid-entry');
});

test('the expiry route runs the permanent phase only and leaves a fresh hold alone', async () => {
  const { home, routes } = await setup();
  await call(routes, RUN, 'POST', { apply: true });
  const { status, payload } = await call(routes, PURGE, 'POST', {});
  assert.equal(status, 200);
  assert.equal(payload.purged.length, 0);
  assert.equal((await listEntries(home)).entries.length, 1);
});

test('a resident Session is skipped instead of held, even when idle enough', async () => {
  const { home, routes } = await setup({ resident: ['session-idle'] });
  const { payload } = await call(routes, RUN, 'POST', { apply: true });
  assert.equal(payload.held.length, 0);
  const reason = payload.skipped.find((item) => item.id === 'session-idle')?.reason;
  assert.equal(reason, 'resident');
  assert.equal((await listEntries(home)).entries.length, 0);
});

test('a running Session is skipped, and an unreadable waterfall skips everything', async () => {
  const running = await setup({ activity: () => ['turn'] });
  const first = await call(running.routes, RUN, 'POST', {});
  const runningSkip = first.payload.skipped.find((item) => item.id === 'session-idle')?.reason;
  assert.equal(runningSkip, 'session-active');

  const throwing = await setup({ activity: () => { throw new Error('waterfall unavailable'); } });
  const second = await call(throwing.routes, RUN, 'POST', {});
  const unknownSkip = second.payload.skipped.find((item) => item.id === 'session-idle')?.reason;
  assert.equal(unknownSkip, 'activity-unknown');
});

test('the status tool renders a human conclusion first and keeps details in the payload', async () => {
  const { tools } = await setup();
  const spec = tools.get('archived_purge_status');
  assert.ok(spec, 'status tool registered');
  const value = await spec.execute({ plan: true }, {});
  const rendered = spec.output.render({}, value);
  assert.equal(Array.isArray(rendered), true);
  const line = rendered[0].text.split('\n')[0];
  assert.match(line, /自动清理开着/);
  assert.match(line, /每 168 小时/);
  assert.match(rendered[0].text, /本轮查看 2 条归档会话/);
  assert.match(rendered[0].text, /还没到宽限期 1 条/);
  assert.equal(value.plan.held.length, 1);
});

test('the run tool is dry unless confirm:true, and the restore tool undoes a hold', async () => {
  const { home, idle, tools } = await setup();
  const run = tools.get('archived_purge_run');
  const restore = tools.get('archived_purge_restore');
  assert.ok(run && restore);

  const dry = await run.execute({}, {});
  assert.equal(dry.dryRun, true);
  assert.equal(await exists(idle), true);

  const applied = await run.execute({ confirm: true }, {});
  assert.equal(applied.dryRun, false);
  assert.equal(applied.held.length, 1);
  const entryId = applied.held[0].entryId;

  const restored = await restore.execute({ entryId }, {});
  assert.equal(restored.ok, true);
  assert.equal(await exists(idle), true);
  assert.equal((await listEntries(home)).entries.length, 0);
});

test('the restore tool rejects a missing or path-shaped entry id', async () => {
  const { tools } = await setup();
  const restore = tools.get('archived_purge_restore');
  const bad = await restore.execute({ entryId: '../x' }, {});
  assert.equal(bad.ok, false);
  const missing = await restore.execute({ entryId: '20260101T000000.000Z-session-x' }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'entry-missing');
});
