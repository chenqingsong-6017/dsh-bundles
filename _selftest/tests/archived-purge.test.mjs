// 映射测试：dsh-archived-purge（2026-11-11 升级到上游 1.3.0）
// 上游 5 个测试文件原样纳入验证门（相对 import 以本文件为基准解析到插件目录），
// 另加本仓补丁的 3 条断言：删除后补播 api-session/removed、announce 补播、
// 以及事件总线故障不影响删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../dsh-archived-purge/test/host.test.mjs';
import '../../dsh-archived-purge/test/http.test.mjs';
import '../../dsh-archived-purge/test/clean.test.mjs';
import '../../dsh-archived-purge/test/leftovers.test.mjs';
import '../../dsh-archived-purge/test/client.test.mjs';

import { createHandlers } from '../../dsh-archived-purge/index.js';

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archived-purge-mapped-'));
  const project = path.join(home, 'sessions', '--C-tmp-proj--');
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(cache, { recursive: true });
  return { home, project, cache };
}

async function makeSession(project, id, bytes = 256) {
  const dir = path.join(project, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7));
  return dir;
}

async function makeCache(cache, id, title) {
  await fsp.writeFile(path.join(cache, `${id}.json`), JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 4 }, rows: { title: { ver: 1, seq: 3, val: title } } },
  }));
}

async function writeRegistry(home, archived, sessionIds) {
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: archived, pinnedSessionIds: [] },
    tables: {
      workspaces: {
        w1: {
          path: 'C:\\tmp\\proj',
          title: 'demo-workspace',
          sessionIds,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    },
  }, null, 2));
}

function makeRegistry(sessionIds) {
  return {
    registry: {
      list: () => [{
        id: 'w1',
        title: 'demo-workspace',
        sessionIds: [...sessionIds],
        detachSession: async () => {},
      }],
      unarchiveSession: async () => {},
    },
  };
}

async function prepare(home, ids) {
  const { project, cache } = { project: path.join(home, 'sessions', '--C-tmp-proj--'), cache: path.join(home, 'storages', 'session_projcache', 'sessions') };
  for (const id of ids) {
    await makeSession(project, id);
    await makeCache(cache, id, id);
  }
  await writeRegistry(home, ids, ids);
}

test('remove announces api-session/removed for both id spellings（本仓补丁）', async () => {
  const { home } = await makeHome();
  await prepare(home, ['session-alpha']);
  const events = [];
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: makeRegistry(['session-alpha']).registry,
    sessionPersistence: undefined,
    emit: (event, payload) => events.push([event, payload]),
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  const removed = events.filter(([event]) => event === 'api-session/removed').map(([, id]) => id);
  assert.ok(removed.includes('session-alpha'), 'canonical spelling announced');
  assert.ok(removed.includes('alpha'), 'raw-uuid spelling announced');
});

test('announce replays stale client removals and skips malformed ids（本仓补丁）', async () => {
  const { home } = await makeHome();
  const events = [];
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: makeRegistry([]).registry,
    sessionPersistence: undefined,
    emit: (event, payload) => events.push([event, payload]),
  });
  const result = handlers.announce(['session-stale', 'bad/id']);
  assert.equal(result.ok, true);
  assert.equal(result.announced, 2, 'one valid id announces both spellings; malformed ids are skipped');
  assert.deepEqual(events.map(([, id]) => id).sort(), ['session-stale', 'stale'].sort());
});

test('a throwing event bus never fails the deletion（本仓补丁）', async () => {
  const { home } = await makeHome();
  await prepare(home, ['session-alpha']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: makeRegistry(['session-alpha']).registry,
    sessionPersistence: undefined,
    emit: () => { throw new Error('event bus down'); },
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
});
