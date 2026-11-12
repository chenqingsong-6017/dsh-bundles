/**
 * FORK of @deepseek-ai/dsh-storage-json 0.2.2-rc.1 (MIT, deepseek-ai/deepseek-harness).
 *
 * DEVIATIONS from upstream, all gated by a per-unit descriptor flag so every
 * existing domain keeps byte-identical behavior:
 *   1. A delta-enabled per-record table (descriptor.delta === true) stores the
 *      record as a newline-delimited journal: one whole-value baseline line
 *      followed by delta lines (see ./delta.js). Reading folds it back into the
 *      same whole value, so callers see no difference.
 *   2. putRecord accepts the caller's previous authoritative value and appends
 *      only the delta, falling back to a fresh atomic baseline when the delta is
 *      unavailable, too large, or the journal reached its compaction policy.
 *   3. Legacy whole-document records are read as-is and upgraded to the journal
 *      form on the first real write; a torn final journal line is ignored.
 *
 * Everything else (atomic publish protocol, legacy bootstrap, delete/backup
 * staging, version stamps) is upstream code, unchanged.
 */
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { parseDocument, planJournalWrite } from "./delta.js";
import z from "@deepseek-ai/schemastery";
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
//#region lib/types/atomic.js
/**
* Atomic whole-file replacement for the JSON backend.
*
* Publish protocol: write a same-directory temp file, fsync it, then
* `rename()` over the target. Rename is an atomic replace on POSIX and on
* Windows (libuv maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`),
* and replacement is the intended semantic here — unlike the session-log
* backend's link()+unlink() no-clobber protocol, a unit file has exactly one
* writer per process and last-write-wins is correct. After the rename the
* parent directory is fsynced on POSIX so the new entry is crash-durable.
* @module @deepseek-ai/dsh-storage-json/src/atomic
*/
/**
* Durably replace `path` with `data`.
* @param path - Absolute target file path.
* @param data - Full new file content.
* @returns resolution after the replacement is crash-durable.
*/
async function writeAtomic(path, data) {
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(tmp, "wx", 384);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
		await fsyncDirectory(dirname(path));
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Persist directory-entry changes on POSIX; skip this unsupported operation on Windows.
* @param path - Absolute directory path.
* @returns resolution after the directory is synced, or immediately on Windows.
*/
/* v8 ignore start -- Windows rejects O_RDONLY directory opens; POSIX coverage exercises this. */
async function fsyncDirectory(path) {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
/* v8 ignore stop */
//#endregion
//#region lib/types/format.js
/**
* On-disk JSON unit format: the file is always the current net state, kept
* human-readable (pretty-printed, stable key order from insertion) — that
* legibility is this backend's reason to exist. `single`-layout units are
* one document with a unit header; `per-record`-layout units are a directory
* with one version-stamped document per record (`<table>/<key>.json`) plus a
* `global.json` for the global slot, so a write rewrites one record instead
* of the whole unit.
* @module @deepseek-ai/dsh-storage-json/src/format
*/
/**
* Serialize a unit state to file content.
* @param name - Unit name, stamped into the header.
* @param state - Authoritative in-memory state.
* @returns pretty-printed JSON document with a trailing newline.
*/
function serialize(name, state) {
	const tables = {};
	for (const [table, records] of state.tables) tables[table] = Object.fromEntries(records);
	const document = {
		unit: {
			name,
			version: state.version
		},
		global: state.global,
		tables
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}
/**
* Parse file content into unit state, validating shape and version.
* @param text - Raw file content.
* @param descriptor - Expected identity and accepted current or compatible versions.
* @returns the parsed state.
*/
function parse(text, descriptor) {
	let document;
	try {
		document = JSON.parse(text);
	} catch (error) {
		throw new StorageError("malformed-medium", `unit '${descriptor.name}': file is not valid JSON`, { cause: error });
	}
	if (typeof document !== "object" || document === null) throw new StorageError("malformed-medium", `unit '${descriptor.name}': file is not a JSON object`);
	const { unit, global: globalValue, tables } = document;
	if (typeof unit !== "object" || unit === null || unit["name"] !== descriptor.name || typeof unit["version"] !== "number") throw new StorageError("malformed-medium", `unit '${descriptor.name}': missing or foreign unit header`);
	const version = unit["version"];
	if (version !== descriptor.version && !descriptor.compatibleVersions?.includes(version)) throw new StorageError("version-mismatch", `unit '${descriptor.name}': stored version ${version} is not accepted by version ${descriptor.version}`);
	if (typeof tables !== "object" || tables === null || Array.isArray(tables)) throw new StorageError("malformed-medium", `unit '${descriptor.name}': tables is not an object`);
	const state = {
		version,
		global: globalValue ?? null,
		tables: /* @__PURE__ */ new Map()
	};
	for (const table of descriptor.tables) {
		const records = tables[table];
		if (records === void 0) {
			state.tables.set(table, /* @__PURE__ */ new Map());
			continue;
		}
		if (typeof records !== "object" || records === null || Array.isArray(records)) throw new StorageError("malformed-medium", `unit '${descriptor.name}': table '${table}' is not an object`);
		state.tables.set(table, new Map(Object.entries(records)));
	}
	return state;
}
/**
* Serialize one per-record document: the unit's version stamp plus the
* record value, pretty-printed like the whole-unit document.
* @param version - Unit format version, stamped into the header.
* @param value - The record value (or the global singleton value).
* @returns pretty-printed JSON document with a trailing newline.
*/
function serializeRecord(version, value) {
	return `${JSON.stringify({
		version,
		record: value
	}, null, 2)}\n`;
}
/**
* Parse one per-record document, validating its version stamp. A document
* that is malformed or stamped with an unaccepted version is FOREIGN and
* reads as absent — the per-record contract: one bad or stale record file
* must not brick the whole unit, and an unaccepted version stamp discards the
* record instead of migrating it (the whole-unit format rejects instead,
* because there is exactly one document).
* @param text - Raw per-record document content.
* @param versions - Accepted unit versions (the current one plus the
* descriptor's compatibleVersions); any other stamp discards the
* document.
* @returns the record value, or `undefined` for a foreign document.
*/
function parseRecord(text, versions) {
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof document !== "object" || document === null) return void 0;
	const { version: stamped, record } = document;
	if (typeof stamped !== "number" || !versions.includes(stamped)) return void 0;
	return record;
}
//#endregion
//#region lib/types/single-unit.js
/**
* One opened JSON unit in `single` layout: the whole unit is one document at
* `<root>/<name>.json`. The in-memory state is authoritative; every write
* primitive mutates it and republishes the whole file atomically, including a
* batch delete, which changes several records but publishes once. Writes are
* NOT queued here — per the backend contract, write ordering belongs to the
* caller (the domain layer's write chain); this unit only guarantees that
* each single call publishes a complete, durable file. The `per-record`
* layout is a separate unit class in `per-record-unit.ts`.
* @module @deepseek-ai/dsh-storage-json/src/single-unit
*/
/**
* Open (load or lazily create) one `single`-layout unit under `root`: the
* unit file is `<root>/<name>.json`.
* @param descriptor - Static identity and shape of the unit.
* @param root - Absolute backend root directory.
* @param onClose - Backend callback releasing the unit's open-slot.
* @returns the opened unit.
*/
async function openSingleUnit(descriptor, root, onClose) {
	const path = join(root, `${descriptor.name}.json`);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const state = text === void 0 ? {
		version: descriptor.version,
		global: null,
		tables: new Map(descriptor.tables.map((table) => [table, /* @__PURE__ */ new Map()]))
	} : parse(text, descriptor);
	state.version = descriptor.version;
	return new SingleJsonUnit(descriptor, path, state, onClose);
}
var SingleJsonUnit = class {
	descriptor;
	path;
	state;
	onClose;
	closed = false;
	/** In-flight publishes; close() drains them before releasing the unit. */
	inFlight = /* @__PURE__ */ new Set();
	constructor(descriptor, path, state, onClose) {
		this.descriptor = descriptor;
		this.path = path;
		this.state = state;
		this.onClose = onClose;
	}
	async loadAll() {
		this.assertOpen();
		const tables = {};
		for (const [table, records] of this.state.tables) tables[table] = Object.fromEntries(records);
		return {
			tables,
			global: this.state.global
		};
	}
	async putRecord(table, key, value) {
		this.assertOpen();
		const records = this.records(table);
		const hadKey = records.has(key);
		const previous = records.get(key);
		records.set(key, value);
		await this.publish().catch((error) => {
			if (hadKey) records.set(key, previous);
			else records.delete(key);
			throw error;
		});
	}
	deleteRecord(table, key) {
		return this.deleteRecords(table, [key]);
	}
	async deleteRecords(table, keys) {
		this.assertOpen();
		const records = this.records(table);
		const removed = /* @__PURE__ */ new Map();
		for (const key of new Set(keys)) {
			if (!records.has(key)) continue;
			removed.set(key, records.get(key));
			records.delete(key);
		}
		if (removed.size === 0) return;
		await this.publish().catch((error) => {
			for (const [key, value] of removed) records.set(key, value);
			throw error;
		});
	}
	async setGlobal(value) {
		this.assertOpen();
		if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`);
		const previous = this.state.global;
		this.state.global = value;
		await this.publish().catch((error) => {
			this.state.global = previous;
			throw error;
		});
	}
	async close() {
		if (this.closed) {
			await Promise.allSettled(this.inFlight);
			return;
		}
		this.closed = true;
		await Promise.allSettled(this.inFlight);
		this.onClose();
	}
	assertOpen() {
		if (this.closed) throw new StorageError("closed", `unit '${this.descriptor.name}' is closed`);
	}
	records(table) {
		const records = this.state.tables.get(table);
		if (!records) throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`);
		return records;
	}
	async publish() {
		const write = writeAtomic(this.path, serialize(this.descriptor.name, this.state));
		this.inFlight.add(write);
		write.catch(() => {}).finally(() => this.inFlight.delete(write));
		return write;
	}
};
//#endregion
//#region lib/types/per-record-unit.js
/**
* One opened JSON unit in `per-record` layout: the unit is a directory at
* `dir`, holding one document per record under `<dir>/<table>/<key>.json`
* plus `global.json` for the global slot. The directory is the state — this
* unit holds NO in-memory state of its own: `loadAll` re-reads the tree, each
* put or delete touches one durable document, and a batch delete renames its
* documents out of the readable set before unlinking them. The domain layer owns the live
* in-memory tables (seeded by the open-time `loadAll`) and serializes writes
* through its write chain. A rejected write leaves domain memory unchanged;
* a failed deletion restores its staged documents or quarantines the unit
* with `unknown-state` when restoration cannot be established.
*
* Per-record contract: a record document that is malformed or stamped with a
* version outside the accepted set (the descriptor's current version plus
* its `compatibleVersions`) reads as an absent record — one bad or stale
* file never bricks the whole unit, and an unaccepted version stamp discards
* the record instead of migrating it. Record keys become path segments, so
* they must be path-safe (`[a-zA-Z0-9_-]+`); an unsafe key rejects at write.
*
* Legacy bootstrap: when the new tree has no declared table directory or
* global document, a whole-unit file `<root>/<name>.json` seeds
* per-record documents, provided its stored unit version is in the accepted
* set — a legacy file stamped with any other version is left alone and reads
* as the empty unit. An existing declared table directory, even when empty,
* or a declared global document suppresses the bootstrap for the whole unit.
* The legacy file is never changed or deleted.
* @module @deepseek-ai/dsh-storage-json/src/per-record-unit
*/
/** Keys become path segments in this layout; this set is path-safe on every OS. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;
/** Delta journal defaults; a domain spec may tighten them per table. */
const DEFAULT_DELTA_DEPTH = 2;
const DEFAULT_DELTA_MAX_LINES = 20;
const DEFAULT_DELTA_COMPACT_BYTES = 32768;
/**
* Open one `per-record`-layout unit under `root`: the unit directory is
* `<root>/<name>/`. Loads lazily on the first `loadAll` — this unit holds no
* state, so opening touches nothing on the medium.
* @param descriptor - Static identity and shape of the unit.
* @param root - Absolute backend root directory.
* @param onClose - Backend callback releasing the unit's open-slot.
* @returns the opened unit.
*/
async function openPerRecordUnit(descriptor, root, onClose) {
	return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose);
}
/**
* Read every record document under the unit directory: each declared table's
* `<key>.json` files plus `global.json`. A missing directory is the empty
* unit (materialization defers to the first write); a foreign document
* (missing, malformed, or stamped with an unaccepted version) reads as an absent
* record, per the per-record contract.
* @param descriptor - Static identity and shape of the unit.
* @param dir - Absolute unit directory path.
* @returns the authoritative state reconstructed from the tree.
*/
async function loadPerRecordState(descriptor, dir) {
	const versions = acceptedStamps(descriptor);
	const state = {
		version: descriptor.version,
		global: null,
		tables: new Map(descriptor.tables.map((table) => [table, new Map()]))
	};
	const meta = new Map();
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (!(entries === void 0 ? false : (await Promise.all(entries.map(async (entry) => {
		if (entry.isDirectory()) {
			const records = state.tables.get(entry.name);
			if (records !== void 0) {
				await loadTableRecords(records, meta, versions, join(dir, entry.name), descriptor.delta === true);
				return true;
			}
		}
		if (entry.name === "global.json" && descriptor.hasGlobal) {
			const global = await readRecord(join(dir, entry.name), versions);
			if (global !== void 0) state.global = global;
			return true;
		}
		return false;
	}))).some(Boolean))) await bootstrapLegacyUnit(descriptor, dir, state);
	return {
		state,
		meta
	};
}
/** The version stamps this unit reads as its own: current plus declared compatible versions. */
function acceptedStamps(descriptor) {
	return [descriptor.version, ...descriptor.compatibleVersions ?? []];
}
/**
* Bootstrap an unmaterialized per-record tree from a legacy whole-unit file
* (`<root>/<name>.json`, the pre-per-record layout). Every declared-table
* record is copied into a current-version document, while the legacy file is
* retained unchanged. A missing, foreign (another unit's name), malformed,
* or non-unit legacy file is left alone, and so is one whose stored unit
* version is outside the accepted set — migrating records the owner never
* vouched for would stamp them with the current version and turn a
* discardable stale cache into schema failures at the domain layer. Other
* read failures propagate.
* @param descriptor - Static identity and shape of the unit.
* @param dir - The per-record unit directory (`<root>/<name>`).
* @param state - The empty tree state; bootstrapped records are added.
*/
async function bootstrapLegacyUnit(descriptor, dir, state) {
	const legacyPath = join(dirname(dir), `${descriptor.name}.json`);
	let text;
	try {
		text = await readFile(legacyPath, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return;
	}
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return;
	}
	if (document.unit?.name !== descriptor.name) return;
	const stamped = document.unit.version;
	if (typeof stamped !== "number" || !acceptedStamps(descriptor).includes(stamped)) return;
	const tables = document.tables;
	if (typeof tables !== "object" || tables === null) return;
	const recordsByTable = tables;
	for (const [table, records] of Object.entries(recordsByTable)) {
		const target = state.tables.get(table);
		if (target === void 0) continue;
		for (const [key, value] of Object.entries(records)) {
			const path = join(dir, table, `${key}.json`);
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await writeAtomic(path, serializeRecord(descriptor.version, value));
			target.set(key, value);
		}
	}
}
/**
* Read one declared table's record documents into `records`.
*/
async function loadTableRecords(records, meta, versions, dir, delta) {
	const files = await readdir(dir, { withFileTypes: true });
	const loaded = await Promise.all(files.map(async (file) => {
		if (!file.name.endsWith(".json")) return;
		const key = file.name.slice(0, -5);
		if (!SAFE_KEY_RE.test(key)) return;
		const path = join(dir, file.name);
		if (!delta) {
			const record = await readRecord(path, versions);
			if (record !== void 0) return [key, record];
			return;
		}
		const parsed = await readDeltaRecord(path, versions);
		if (parsed === void 0) return;
		meta.set(key, parsed.stats);
		return [key, parsed.value];
	}));
	for (const record of loaded) if (record !== void 0) records.set(...record);
}
/**
* Read one delta-journal record document. Both the legacy whole-document form
* and the journal form are accepted; a foreign or corrupt one reads as absent,
* exactly like the per-record contract's version-stamp rule.
* @param path - Absolute record document path.
* @param versions - Accepted unit version stamps.
* @returns the whole record value plus journal stats, or undefined when foreign.
*/
async function readDeltaRecord(path, versions) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return void 0;
	}
	const parsed = parseDocument(text, versions);
	if (parsed === void 0) return void 0;
	return {
		value: parsed.value,
		stats: {
			format: parsed.format,
			baselineBytes: parsed.baselineBytes,
			deltaLines: parsed.deltaLines,
			deltaBytes: parsed.deltaBytes
		}
	};
}
/** Read one record document; a foreign (unreadable or stale) one reads as absent. */
async function readRecord(path, versions) {
	try {
		return parseRecord(await readFile(path, "utf8"), versions);
	} catch {
		return;
	}
}
/**
* One opened `per-record`-layout unit. Stateless by design: the directory is
* the medium and the domain layer owns the live memory. Replacements publish
* one document; deletions stage and sync their documents before cleanup.
* Write ordering belongs to the caller (the domain layer's write chain).
*/
var PerRecordJsonUnit = class {
	descriptor;
	dir;
	onClose;
	closed = false;
	/** Set when a failed batch could not restore its staged documents. */
	unusable;
	/** Delta journal bookkeeping per record key: format and byte counters (advisory, never authoritative). */
	deltaStats = /* @__PURE__ */ new Map();
	/** In-flight durable writes; close() drains them before releasing the unit. */
	inFlight = /* @__PURE__ */ new Set();
	constructor(descriptor, dir, onClose) {
		this.descriptor = descriptor;
		this.dir = dir;
		this.onClose = onClose;
	}
	/** Re-read the tree: the directory is the authoritative state. */
	async loadAll() {
		this.assertOpen();
		const loaded = await loadPerRecordState(this.descriptor, this.dir);
		this.deltaStats = loaded.meta;
		const tables = {};
		for (const [table, records] of loaded.state.tables) tables[table] = Object.fromEntries(records);
		return {
			tables,
			global: loaded.state.global
		};
	}
	/**
	* Durably replace one record.
	*
	* In the default (whole-document) mode this is the upstream behavior: one
	* atomic document replace. In delta mode the caller supplies its previous
	* authoritative value, so only the changed part is appended; the journal
	* compacts itself back into a baseline when the policy says so.
	* @param table - Declared table name.
	* @param key - Record key.
	* @param value - The new authoritative value.
	* @param previous - The caller's previous authoritative value, when known.
	*/
	async putRecord(table, key, value, previous) {
		this.assertOpen();
		assertSafeKey(this.descriptor.name, key);
		const path = join(this.tableDir(table), key + ".json");
		if (this.descriptor.delta !== true) {
			await this.tracked(this.writeDocument(path, value));
			return;
		}
		await this.tracked(this.writeDeltaRecord(path, key, value, previous));
	}
	/**
	* Write one delta-journal record document. The journal is a cache-side
	* optimization, so every uncertain case (no previous value, a foreign file
	* form, an inexpressible change, a compaction trigger) falls back to a fresh
	* atomic baseline; an unchanged value writes nothing at all. The decision
	* itself lives in the codec (planJournalWrite) so it can be tested without I/O.
	*/
	async writeDeltaRecord(path, key, value, previous) {
		const plan = planJournalWrite(this.deltaStats.get(key), this.descriptor, previous, value, this.descriptor.version);
		if (plan.kind === "none") return;
		if (plan.kind === "append") await this.appendDocument(path, plan.text);
		else await this.writeRawDocument(path, plan.text);
		this.deltaStats.set(key, plan.stats);
	}
	/** Append one journal line and fsync it; the file is the durable record. */
	async appendDocument(path, text) {
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		const handle = await open(path, "a");
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	/** Atomically publish one complete document (baseline or legacy form). */
	async writeRawDocument(path, text) {
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		await writeAtomic(path, text);
	}
	/** Durably delete one record. Idempotent: a missing key is a no-op. */
	deleteRecord(table, key) {
		return this.deleteRecords(table, [key]);
	}
	/**
	* Durably delete many records as one batch. Documents are renamed out of the
	* readable set first; only after the whole batch is staged are the staged
	* copies unlinked. A failure while staging restores the documents it moved,
	* so a rejection normally leaves the batch unapplied. If that restoration
	* itself fails, the readable or durable state is unknown: the unit rejects with
	* `unknown-state` and every later operation on it rejects, while `close`
	* still releases it. Staged directory changes are synced before cleanup on
	* POSIX, so a resolved deletion remains absent after a crash. Cleanup residue
	* is not readable (`open` reads `*.json` documents only).
	*/
	async deleteRecords(table, keys) {
		this.assertOpen();
		const dir = this.tableDir(table);
		const unique = [...new Set(keys)];
		for (const key of unique) assertSafeKey(this.descriptor.name, key);
		await this.tracked(this.removeDocuments(dir, unique));
		for (const key of unique) this.deltaStats.delete(key);
	}
	/**
	* Remove one batch's documents under a single tracked promise.
	* @param dir - Declared table directory.
	* @param keys - Validated, de-duplicated record keys.
	*/
	async removeDocuments(dir, keys) {
		const staged = [];
		try {
			for (const key of keys) {
				const from = join(dir, `${key}.json`);
				const to = `${from}.deleting`;
				try {
					await rename(from, to);
				} catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}
				staged.push({
					from,
					to
				});
			}
			if (staged.length > 0) await fsyncDirectory(dir);
		} catch (error) {
			const restoreFailures = [];
			for (const { from, to } of staged) try {
				await rename(to, from);
			} catch (restoreError) {
				restoreFailures.push(restoreError);
			}
			if (staged.length > 0) try {
				await fsyncDirectory(dir);
			} catch (restoreError) {
				restoreFailures.push(restoreError);
			}
			if (restoreFailures.length === 0) throw error;
			this.unusable = new StorageError("unknown-state", `unit '${this.descriptor.name}' could not restore a failed batch delete; its state is unknown`, { cause: new AggregateError([error, ...restoreFailures], "batch delete failed and restoration failed") });
			throw this.unusable;
		}
		await Promise.allSettled(staged.map(({ to }) => rm(to, { force: true })));
	}
	/**
	* Move one record's document aside as `<key>.json.bak.<YYYYMMDDHHmm>`. The
	* moved file no longer ends in `.json`, so every later read ignores it; the
	* bytes stay on disk for inspection. A same-minute backup of the same
	* key overwrites the previous backup (the newer bytes are the ones worth
	* keeping).
	*/
	async backupRecord(table, key) {
		this.assertOpen();
		assertSafeKey(this.descriptor.name, key);
		const path = join(this.tableDir(table), key + ".json");
		const moved = path + ".bak." + backupStamp(/* @__PURE__ */ new Date());
		await this.tracked(rename(path, moved));
		this.deltaStats.delete(key);
		return moved;
	}
	/** Durably replace the global singleton. Only valid when declared. */
	async setGlobal(value) {
		this.assertOpen();
		if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`);
		await this.tracked(this.writeDocument(join(this.dir, "global.json"), value));
	}
	/** Drain in-flight writes and release the unit. Idempotent. */
	async close() {
		if (this.closed) {
			await Promise.allSettled(this.inFlight);
			return;
		}
		this.closed = true;
		await Promise.allSettled(this.inFlight);
		this.onClose();
	}
	assertOpen() {
		if (this.closed) throw new StorageError("closed", `unit '${this.descriptor.name}' is closed`);
		if (this.unusable !== void 0) throw this.unusable;
	}
	/** Resolve a declared table's directory; an undeclared table is a caller bug and throws. */
	tableDir(table) {
		if (!this.descriptor.tables.includes(table)) throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`);
		return join(this.dir, table);
	}
	/** Durably replace one document, creating its parent directory. */
	async writeDocument(path, value) {
		const text = serializeRecord(this.descriptor.version, value);
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		await writeAtomic(path, text);
	}
	/** Track one durable write so close() drains it. */
	tracked(write) {
		this.inFlight.add(write);
		write.catch(() => {}).finally(() => this.inFlight.delete(write));
		return write;
	}
};
/** Local-time `YYYYMMDDHHmm` suffix for backed-up documents. */
function backupStamp(now) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}
/** Reject a record key that would be unsafe as a path segment. */
function assertSafeKey(unit, key) {
	if (!SAFE_KEY_RE.test(key)) throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`);
}
//#endregion
//#region lib/types/index.js
/**
* JSON storage backend: one human-readable document per unit under a
* configured root — a whole-unit file (`single` layout) or one document per
* record (`per-record` layout), published by atomic rewrite. Registers as
* backend `json` on the storage hub.
* @module @deepseek-ai/dsh-storage-json
*/
/** Cordis plugin name. */
const name = "storage-json";
/** The hub must exist before the backend can register. */
const inject = ["storage"];
/** Config schema. */
const Config = z.object({ root: z.string().required() });
/** JSON backend: owns the file-tree root and serves the `kv` facet. */
var JsonStorageBackend = class {
	root;
	open = /* @__PURE__ */ new Map();
	opening = /* @__PURE__ */ new Map();
	closed = false;
	constructor(root) {
		this.root = root;
	}
	kv = { open: async (descriptor) => {
		if (this.closed) throw new StorageError("closed", "json backend is closed");
		validateDescriptor(descriptor);
		if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`);
		const opening = this.openUnit(descriptor);
		this.opening.set(descriptor.name, opening);
		return opening.finally(() => this.opening.delete(descriptor.name));
	} };
	async openUnit(descriptor) {
		await mkdir(this.root, {
			recursive: true,
			mode: 448
		});
		const onClose = () => this.open.delete(descriptor.name);
		const unit = descriptor.layout === "per-record" ? await openPerRecordUnit(descriptor, this.root, onClose) : await openSingleUnit(descriptor, this.root, onClose);
		if (this.closed) {
			await unit.close();
			throw new StorageError("closed", "json backend is closed");
		}
		this.open.set(descriptor.name, unit);
		return unit;
	}
	async close() {
		if (!this.closed) this.closed = true;
		await Promise.allSettled([...this.opening.values()]);
		for (const unit of [...this.open.values()]) await unit.close();
	}
};
function validateDescriptor(descriptor) {
	if (!UNIT_NAME_RE.test(descriptor.name)) throw new StorageError("malformed-medium", `invalid unit name '${descriptor.name}'`);
	for (const table of descriptor.tables) if (!UNIT_NAME_RE.test(table)) throw new StorageError("malformed-medium", `invalid table name '${table}' in unit '${descriptor.name}'`);
}
/**
* Register the `json` backend on the storage hub.
* @param ctx - Plugin context.
* @param config - Validated configuration.
*/
function apply(ctx, config) {
	const backend = new JsonStorageBackend(config.root);
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register("json", backend);
		return async () => {
			unregister();
			await backend.close();
		};
	});
	ctx.provide(storageBackendServiceKey("json"), backend);
}
//#endregion
export { Config, JsonStorageBackend, apply, inject, name };
