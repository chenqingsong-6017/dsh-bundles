/**
 * Delta journal codec for the per-record JSON backend (dsh-projcache-delta).
 *
 * The official per-record layout rewrites one whole document per record on every
 * write, so a checkpoint whose state grows with the session costs O(n) bytes and
 * one atomic replace per turn. This module turns that document into a
 * newline-delimited journal: a full baseline line followed by delta lines, each
 * expressible as a small list of set/delete operations. Reading folds the file
 * back into the same whole value the old format held, so every consumer (and the
 * storage domain above it) keeps its synchronous whole-value semantics.
 *
 * Format (one line per write):
 *
 *   {"version":8,"record":{...}}                       baseline (whole value)
 *   {"version":8,"delta":{"set":[["rows.title",{...}]]}}
 *   {"version":8,"delta":{"set":[...],"del":[["rows.gone"]]}}
 *
 * A delta line is only appended when the previous value is known (the storage
 * domain passes its authoritative in-memory value) and the change is losslessly
 * expressible; anything else falls back to a fresh baseline. A torn final line
 * (crash during append) is ignored: the journal is a cache, and the reader must
 * never fail because the tail is incomplete.
 *
 * @module @local/dsh-projcache-delta/src/delta
 */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/** Defaults; a storage-domain spec may tighten them per domain. */
export const DEFAULT_DELTA_DEPTH = 2
export const DEFAULT_DELTA_MAX_LINES = 20
export const DEFAULT_DELTA_COMPACT_BYTES = 32768

/** Whether a value is a plain JSON object (the only shape this codec descends into). */
export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Structural equality over plain JSON values. */
export function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (typeof left !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) if (!deepEqual(left[index], right[index])) return false
    return true
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!hasOwn(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

/**
 * The whole-value change between two records, or undefined when the codec cannot
 * express it. Paths are arrays of object keys. The depth limit decides
 * granularity: depth 2 turns {identity, rows} into one operation per changed
 * row (the projection checkpoint shape), and appends to an array become
 * per-element operations instead of a whole-array rewrite.
 */
export function mergeDelta(previous, next, depth = DEFAULT_DELTA_DEPTH) {
  if (previous === undefined || next === undefined) return undefined
  const limit = Number.isInteger(depth) && depth > 0 ? depth : DEFAULT_DELTA_DEPTH
  const operations = { set: [], del: [] }
  collectDelta(previous, next, [], 0, limit, operations)
  return operations
}

function collectDelta(previous, next, path, currentDepth, limit, operations) {
  if (Array.isArray(previous) && Array.isArray(next)) {
    if (isAppendOnly(previous, next)) {
      for (let index = previous.length; index < next.length; index += 1) operations.set.push([[...path, index], next[index]])
    } else if (!deepEqual(previous, next)) operations.set.push([path, next])
    return
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    for (const key of Object.keys(next)) {
      const childPath = [...path, key]
      if (!hasOwn(previous, key)) {
        operations.set.push([childPath, next[key]])
        continue
      }
      if (currentDepth < limit) {
        collectDelta(previous[key], next[key], childPath, currentDepth + 1, limit, operations)
        continue
      }
      collectLeafDelta(previous[key], next[key], childPath, operations)
    }
    for (const key of Object.keys(previous)) if (!hasOwn(next, key)) operations.del.push([...path, key])
    return
  }
  if (!deepEqual(previous, next)) operations.set.push([path, next])
}

/** Diff one level below the object descent limit; appended array elements stay per-element. */
function collectLeafDelta(previous, next, path, operations) {
  if (Array.isArray(previous) && Array.isArray(next) && isAppendOnly(previous, next)) {
    for (let index = previous.length; index < next.length; index += 1) operations.set.push([[...path, index], next[index]])
    return
  }
  if (!deepEqual(previous, next)) operations.set.push([path, next])
}

/** Whether next is previous with elements appended (the per-turn outline case). */
function isAppendOnly(previous, next) {
  if (next.length < previous.length) return false
  for (let index = 0; index < previous.length; index += 1) if (!deepEqual(previous[index], next[index])) return false
  return true
}

/** Whether a delta would leave the stored value unchanged. */
export function isEmptyDelta(delta) {
  return delta.set.length === 0 && delta.del.length === 0
}

/** Apply one delta to a whole value. Throws when the delta does not fit the value. */
export function applyDelta(value, delta) {
  let root = value
  if (delta.set !== undefined) {
    if (!Array.isArray(delta.set)) throw new Error('delta set is not an array')
    for (const entry of delta.set) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[0])) throw new Error('delta set entry is malformed')
      root = assignAt(root, entry[0], entry[1])
    }
  }
  if (delta.del !== undefined) {
    if (!Array.isArray(delta.del)) throw new Error('delta del is not an array')
    for (const path of delta.del) {
      if (!Array.isArray(path)) throw new Error('delta del entry is malformed')
      root = removeAt(root, path)
    }
  }
  return root
}

function assignAt(root, path, value) {
  if (path.length === 0) return value
  let node = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (Array.isArray(node)) {
      if (!Number.isInteger(key) || key < 0 || key >= node.length) throw new Error('delta set array path does not exist: ' + JSON.stringify(path))
      node = node[key]
      continue
    }
    if (!isPlainObject(node) || !hasOwn(node, key) || (!isPlainObject(node[key]) && !Array.isArray(node[key]))) throw new Error('delta set path does not exist: ' + JSON.stringify(path))
    node = node[key]
  }
  if (Array.isArray(node)) {
    const index = path[path.length - 1]
    if (!Number.isInteger(index) || index < 0 || index > node.length) throw new Error('delta set array index is invalid: ' + JSON.stringify(path))
    node[index] = value
    return root
  }
  if (!isPlainObject(node)) throw new Error('delta set parent is not an object: ' + JSON.stringify(path))
  node[path[path.length - 1]] = value
  return root
}

function removeAt(root, path) {
  if (path.length === 0) throw new Error('delta del cannot remove the root value')
  let node = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (!isPlainObject(node) || !hasOwn(node, key) || !isPlainObject(node[key])) throw new Error('delta del path does not exist: ' + JSON.stringify(path))
    node = node[key]
  }
  if (!isPlainObject(node) || !hasOwn(node, path[path.length - 1])) throw new Error('delta del key does not exist: ' + JSON.stringify(path))
  delete node[path[path.length - 1]]
  return root
}

/** Serialize a whole-value baseline line (compact, one line, trailing newline). */
export function serializeBaseline(version, value) {
  return JSON.stringify({ version, record: value }) + '\n'
}

/** Serialize one delta line (compact, one line, trailing newline). */
export function serializeDelta(version, delta) {
  return JSON.stringify({ version, delta }) + '\n'
}

/**
 * Decide how one write lands on the journal, without touching the filesystem so
 * the policy is unit-testable. Kinds: none (unchanged), append (delta line plus
 * updated stats), baseline (one whole-value line plus fresh stats).
 */
export function planJournalWrite(stats, descriptor, previous, value, version) {
  const depth = positiveInteger(descriptor.deltaDepth, DEFAULT_DELTA_DEPTH)
  const maxLines = positiveInteger(descriptor.deltaMaxLines, DEFAULT_DELTA_MAX_LINES)
  const compactBytes = positiveInteger(descriptor.deltaCompactBytes, DEFAULT_DELTA_COMPACT_BYTES)
  if (stats !== undefined && stats.format === 'log' && previous !== undefined) {
    let delta
    try {
      delta = mergeDelta(previous, value, depth)
    } catch (error) {
      delta = undefined
    }
    if (delta !== undefined && isEmptyDelta(delta)) return { kind: 'none' }
    if (delta !== undefined) {
      let line
      try {
        line = serializeDelta(version, delta)
      } catch (error) {
        line = undefined
      }
      if (line !== undefined) {
        const lineBytes = Buffer.byteLength(line, 'utf8')
        const byteLimit = Math.max(compactBytes, stats.baselineBytes)
        if (stats.deltaLines < maxLines && stats.deltaBytes + lineBytes <= byteLimit) {
          return {
            kind: 'append',
            text: line,
            stats: { format: 'log', baselineBytes: stats.baselineBytes, deltaLines: stats.deltaLines + 1, deltaBytes: stats.deltaBytes + lineBytes }
          }
        }
      }
    }
  }
  const text = serializeBaseline(version, value)
  return { kind: 'baseline', text, stats: { format: 'log', baselineBytes: Buffer.byteLength(text, 'utf8'), deltaLines: 0, deltaBytes: 0 } }
}

function positiveInteger(candidate, fallback) {
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback
}

/**
 * Parse one delta-aware record document. Returns undefined when the document is
 * foreign (unreadable, malformed in the middle, unaccepted version stamp, or a
 * delta without a baseline), so the caller treats it as an absent record. A torn
 * FINAL line is ignored: an interrupted append costs the last delta, never the
 * whole record.
 */
export function parseDocument(text, versions) {
  if (typeof text !== 'string') return undefined
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const whole = body.trim()
  if (whole === '') return undefined
  if (whole.startsWith('{')) {
    try {
      const document = JSON.parse(whole)
      if (isPlainObject(document) && hasOwn(document, 'record')) {
        if (typeof document.version !== 'number' || !versions.includes(document.version)) return undefined
        return { value: document.record, format: 'legacy', lines: 1, deltaLines: 0, baselineBytes: Buffer.byteLength(whole, 'utf8'), deltaBytes: 0 }
      }
    } catch (error) {
      // Not one whole document: this is the newline-delimited journal form.
    }
  }
  const lines = body.split('\n')
  let value
  let baselineBytes = 0
  let deltaLines = 0
  let deltaBytes = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let document
    try {
      document = JSON.parse(line)
    } catch (error) {
      let restEmpty = true
      for (let rest = index + 1; rest < lines.length; rest += 1) if (lines[rest].trim() !== '') { restEmpty = false; break }
      if (restEmpty) break
      return undefined
    }
    if (!isPlainObject(document) || typeof document.version !== 'number' || !versions.includes(document.version)) return undefined
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (hasOwn(document, 'record')) {
      value = document.record
      baselineBytes = lineBytes
      deltaLines = 0
      deltaBytes = 0
      continue
    }
    if (hasOwn(document, 'delta')) {
      if (value === undefined) return undefined
      try {
        value = applyDelta(value, document.delta)
      } catch (error) {
        return undefined
      }
      deltaLines += 1
      deltaBytes += lineBytes
      continue
    }
    return undefined
  }
  if (value === undefined) return undefined
  return { value, format: 'log', lines: 0, deltaLines, baselineBytes, deltaBytes }
}
