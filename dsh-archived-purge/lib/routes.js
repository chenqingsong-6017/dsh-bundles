/**
 * HTTP surface of dsh-archived-purge.
 *
 * Split out of the entry file so `index.js` stays an assembly point: every
 * route here is a thin transport shell around a handler that the Host owns.
 * The guard order is uniform — method, origin, content type — so a route can
 * never be reached from another origin or with a body this plugin did not
 * expect to parse. Registrars are grouped by concern because the function
 * length gate is real: each one is one readable screen.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { runOnce, summary } from './auto.js';
import { restoreEntry } from './quarantine.js';

export const ROUTE = '/plugins/archived-purge';
const MAX_BODY = 64 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
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

/** Method + origin gate shared by every route. */
function guard(req, res, method) {
  const allowed = Array.isArray(method) ? method : [method];
  if (!allowed.includes(req.method)) {
    send(res, 405, { ok: false, code: 'method-not-allowed' });
    return false;
  }
  if (!sameOrigin(req)) {
    send(res, 403, { ok: false, code: 'foreign-origin' });
    return false;
  }
  return true;
}

function requireJson(req, res) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    send(res, 415, { ok: false, code: 'content-type-required' });
    return false;
  }
  return true;
}

async function readPayload(req, res) {
  try {
    return JSON.parse(await readBody(req));
  } catch (error) {
    send(res, 400, {
      ok: false,
      code: error?.code === 'too-large' ? 'payload-too-large' : 'invalid-json',
      message: formatError(error),
    });
    return undefined;
  }
}

/** Wrap a handler so an unexpected throw becomes a readable 500 instead of a hang. */
function respond(res, work) {
  return Promise.resolve()
    .then(work)
    .then((payload) => send(res, 200, payload))
    .catch((error) => send(res, 500, { ok: false, code: 'internal', message: formatError(error) }));
}

function mount(ctx, pathname, handler) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${ROUTE}/${pathname}`, handler }));
}

/** GET routes: the archived listing and the automatic-sweep status. */
function registerReadRoutes(ctx, { handlers, auto }) {
  mount(ctx, 'state', (req, res) => {
    if (!guard(req, res, ['GET', 'HEAD'])) return;
    return respond(res, () => handlers.state());
  });
  mount(ctx, 'auto', (req, res) => {
    if (!guard(req, res, ['GET', 'HEAD'])) return;
    return respond(res, () => summary(auto.deps));
  });
}

/** The manual delete and its read-only preview. */
function registerDeleteRoutes(ctx, { handlers }) {
  mount(ctx, 'delete', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      return respond(res, () => handlers.remove(payload?.sessionIds, {
        files: payload?.files,
        // One switch for the whole derived set; the Host still decides what is
        // eligible, so a crafted `everything` can never reach more.
        everything: payload?.everything === true,
        // Tri-state: omitted means "follow `everything`", false opts out.
        attachments: typeof payload?.attachments === 'boolean' ? payload.attachments : undefined,
        requestImages: payload?.requestImages === true,
      }));
    });
  });
  mount(ctx, 'scan', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      const ids = Array.isArray(payload?.sessionIds)
        ? payload.sessionIds.filter((id) => typeof id === 'string' && ID_RE.test(id))
        : [];
      return respond(res, () => handlers.scanAll(ids));
    });
  });
}

/** Derived-cache and leftover sweeps. */
function registerSweepRoutes(ctx, { handlers }) {
  mount(ctx, 'gc', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      // `dryRun` must be explicitly false to delete anything.
      return respond(res, () => handlers.collectGarbage({
        dryRun: payload?.dryRun !== false,
        requestImages: payload?.requestImages === true,
      }));
    });
  });
  mount(ctx, 'leftovers', (req, res) => {
    if (!guard(req, res, 'POST')) return;
    return respond(res, () => handlers.leftoverScan());
  });
  mount(ctx, 'purge-leftovers', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      return respond(res, () => handlers.purgeLeftovers({
        files: Array.isArray(payload?.files) ? payload.files : [],
        logs: payload?.logs === true,
        caches: payload?.caches === true,
        accounting: payload?.accounting === true,
        archived: payload?.archived === true,
        attachments: payload?.attachments === true,
        requestImages: payload?.requestImages === true,
      }));
    });
  });
}

/**
 * Automatic-sweep overrides. `run` is dry by default: only `apply: true` moves
 * anything, so a stray POST from a stale page can never start deleting.
 */
function registerAutoRoutes(ctx, { auto }) {
  mount(ctx, 'auto/run', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      return respond(res, () => runOnce(auto.deps, { dryRun: payload?.apply !== true, force: true }));
    });
  });
  mount(ctx, 'auto/restore', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      const entryId = typeof payload?.entryId === 'string' ? payload.entryId : '';
      if (entryId === '' || /[\\/]/.test(entryId)) {
        send(res, 400, { ok: false, code: 'invalid-entry', message: 'entryId 不合法' });
        return;
      }
      return respond(res, () => restoreEntry(auto.deps.home, entryId));
    });
  });
  mount(ctx, 'auto/purge-expired', (req, res) => {
    if (!guard(req, res, 'POST')) return;
    return respond(res, () => runOnce(auto.deps, { onlyExpired: true, force: true }));
  });
}

/** Re-announce removals the client may have missed, and browser-side diagnostics. */
function registerDiagnosticsRoutes(ctx, { handlers, home }) {
  mount(ctx, 'announce', (req, res) => {
    if (!guard(req, res, 'POST') || !requireJson(req, res)) return;
    return readPayload(req, res).then((payload) => {
      if (payload === undefined) return;
      return respond(res, () => handlers.announce(payload?.sessionIds));
    });
  });
  mount(ctx, 'client-error', (req, res) => {
    if (!guard(req, res, 'POST')) return;
    return respond(res, async () => {
      const payload = JSON.parse(await readBody(req));
      const line = [
        new Date().toISOString(),
        String(payload?.message ?? '').slice(0, 4000),
        String(payload?.stack ?? '').slice(0, 8000),
        '---',
        '',
      ].join('\n');
      await fsp.appendFile(path.join(home, 'archived-purge-client-errors.log'), line, 'utf8');
      return { ok: true };
    });
  });
}

export function registerRoutes(ctx, deps) {
  registerReadRoutes(ctx, deps);
  registerDeleteRoutes(ctx, deps);
  registerSweepRoutes(ctx, deps);
  registerAutoRoutes(ctx, deps);
  registerDiagnosticsRoutes(ctx, deps);
}
