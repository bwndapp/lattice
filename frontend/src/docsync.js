/**
 * Turning one edit of the project into the smallest set of changes that describe it, so
 * two people can work on the same track at once.
 *
 *   diffOps(before, after)   → [{ op, path, ... }]  what changed
 *   applyOps(doc, ops)       → the same changes, on someone else's copy
 *   docHash(doc)             → a short string both sides can compare to know they agree
 *
 * The rules are deliberately boring, because a DAW's document is mostly small values in
 * a deep tree and the interesting conflicts are rare:
 *
 *   · an object is compared key by key, so two people turning different knobs both win
 *   · an array whose items all carry an `id` is compared by id, so a clip moving and a
 *     clip being deleted don't fight over an index (nodes, edges, clips, patterns, …)
 *   · any other array is one value: last writer wins for the whole list
 *
 * That last rule is what keeps this honest. A channel's notes have no ids, so two people
 * editing the same channel's notes at the same moment resolve to whoever stopped typing
 * last — not a silent merge of half of each. Different channels, patterns or nodes never
 * collide at all, which is what working together actually looks like.
 *
 * A path is a list of steps: a key ('song'), an index into a plain array, or `{ id }` for
 * an item in a keyed array. Ops are plain JSON, so the server can apply them without
 * knowing anything about patterns or patches.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** An array we can address by id: every item is an object with its own unique id. */
export function keyed(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false
  const ids = new Set()
  for (const item of arr) {
    if (!isObj(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return false
    ids.add(item.id)
  }
  return true
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** What has to happen to `before` to make it `after`. */
export function diffOps(before, after, path = [], out = []) {
  if (same(before, after)) return out
  if (Array.isArray(before) && Array.isArray(after) && keyed(before) && keyed(after)) {
    diffKeyed(before, after, path, out)
    return out
  }
  if (isObj(before) && isObj(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) out.push({ op: 'del', path: [...path, key] })
    }
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) out.push({ op: 'set', path: [...path, key], value })
      else diffOps(before[key], value, [...path, key], out)
    }
    return out
  }
  out.push({ op: 'set', path, value: after })
  return out
}

function diffKeyed(before, after, path, out) {
  const was = new Map(before.map((x) => [x.id, x]))
  const now = new Map(after.map((x) => [x.id, x]))
  for (const item of before) {
    if (!now.has(item.id)) out.push({ op: 'del', path: [...path, { id: item.id }] })
  }
  for (const [i, item] of after.entries()) {
    const old = was.get(item.id)
    if (!old) out.push({ op: 'ins', path, at: i, value: item })
    else diffOps(old, item, [...path, { id: item.id }], out)
  }
  // the order of what's left, when it isn't simply what it was (a reordered rack, say)
  const kept = before.filter((x) => now.has(x.id)).map((x) => x.id)
  const wanted = after.filter((x) => was.has(x.id)).map((x) => x.id)
  if (kept.join() !== wanted.join()) out.push({ op: 'ord', path, ids: after.map((x) => x.id) })
}

const index = (list, step) => {
  if (isObj(step)) return list.findIndex((x) => isObj(x) && x.id === step.id)
  const i = Number(step)
  return Number.isInteger(i) && i >= 0 && i < list.length ? i : -1
}

/** Walk to the container a path points into, or null when it isn't there any more. */
function walk(doc, path) {
  let at = doc
  for (const step of path) {
    if (Array.isArray(at)) {
      const i = index(at, step)
      if (i < 0) return null
      at = at[i]
    } else if (isObj(at)) {
      if (isObj(step)) return null
      at = at[step]
    } else return null
    if (at === undefined) return null
  }
  return at
}

/**
 * Apply changes to a document, in place. Anything that no longer makes sense is skipped
 * rather than thrown: an op can arrive for a clip someone else has just deleted, and that
 * is a normal Tuesday, not an error. Returns how many ops actually landed.
 */
export function applyOps(doc, ops) {
  let done = 0
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || !Array.isArray(op.path)) continue
    const parentPath = op.path.slice(0, -1)
    const last = op.path.at(-1)
    if (op.op === 'ord') {
      const list = walk(doc, op.path)
      if (!Array.isArray(list) || !Array.isArray(op.ids)) continue
      const by = new Map(list.map((x) => [x?.id, x]))
      const sorted = op.ids.map((id) => by.get(id)).filter((x) => x !== undefined)
      for (const item of list) if (!op.ids.includes(item?.id)) sorted.push(item) // whatever the sender hadn't seen yet
      list.length = 0
      list.push(...sorted)
      done++
      continue
    }
    if (op.op === 'ins') {
      const list = walk(doc, op.path)
      if (!Array.isArray(list) || !isObj(op.value)) continue
      if (list.some((x) => isObj(x) && x.id === op.value.id)) continue // already here
      const at = Number.isInteger(op.at) ? Math.min(Math.max(op.at, 0), list.length) : list.length
      list.splice(at, 0, op.value)
      done++
      continue
    }
    const parent = parentPath.length ? walk(doc, parentPath) : doc
    if (parent == null || typeof parent !== 'object') continue
    if (op.op === 'set') {
      if (op.path.length === 0) continue // the whole document is never replaced by an op
      if (Array.isArray(parent)) {
        const i = index(parent, last)
        if (i < 0) continue
        parent[i] = op.value
      } else {
        if (isObj(last)) continue
        parent[last] = op.value
      }
      done++
    } else if (op.op === 'del') {
      if (Array.isArray(parent)) {
        const i = index(parent, last)
        if (i < 0) continue
        parent.splice(i, 1)
      } else {
        if (isObj(last) || !(last in parent)) continue
        delete parent[last]
      }
      done++
    }
  }
  return done
}

/**
 * A short fingerprint of a document. Two people whose hashes match are looking at the
 * same track; when they don't, the one who is behind asks for the whole thing again
 * rather than trying to work out which op it missed.
 */
export function docHash(doc) {
  const text = stable(doc)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(12, '0')
}

/** JSON with object keys in a fixed order, so the hash doesn't depend on insertion order. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
