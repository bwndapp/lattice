import { parse } from 'acorn'
import { noteToMidi } from '@strudel/core'

/**
 * Lanes are the labeled statements at the top of a Strudel program:
 *
 *   bass: note("c2 eb2").s("sawtooth")     → lane "bass"
 *   $: s("bd*4")                           → anonymous lane, numbered in order
 *   _hats: s("hh*8")                       → muted (leading or trailing _)
 *   Sbass: …                               → soloed (leading S)
 *
 * Mute and solo follow @strudel/core repl.mjs (Pattern.prototype.p and the S-solo loop).
 * Each lane's `slot` ("bass#0") survives mute/solo renames, and matches capturePatterns().
 * Returns null when the code doesn't parse, so callers can keep the last good lanes.
 */
export function parseLanes(code) {
  let ast
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch {
    return null
  }
  const lanes = []
  const seen = new Map()
  for (const node of ast.body) {
    if (node.type !== 'LabeledStatement') continue
    const name = node.label.name
    const muted = name.startsWith('_') || name.endsWith('_')
    const soloed = !muted && name.length > 1 && name.startsWith('S')
    const base = laneBase(name)
    const nth = seen.get(base) ?? 0
    seen.set(base, nth + 1)
    lanes.push({
      name,
      slot: `${base}#${nth}`,
      muted,
      soloed,
      title: base === '$' ? null : base, // anonymous lanes get a number in the UI
      labelFrom: node.label.start,
      labelTo: node.label.end,
      source: code.slice(node.body.start, node.body.end).replace(/\s+/g, ' ').trim(),
    })
  }
  return lanes
}

const stripMute = (name) => name.replace(/^_+|_+$/g, '')

/** A label without its mute/solo decoration: "_Sbass" → "bass". */
export function laneBase(name) {
  const base = stripMute(String(name))
  return base.length > 1 && base.startsWith('S') ? base.slice(1) : base
}

/**
 * Record every labeled pattern while the repl evaluates, muted ones included. The repl
 * stacks them into one pattern and keeps no per-label handle, so wrap the `.p()` it
 * installs before each evaluation (call this from beforeEval). Returns the live Map.
 */
export function capturePatterns(Pattern) {
  const captured = new Map()
  const seen = new Map()
  const register = Pattern.prototype.p
  Pattern.prototype.p = function (id) {
    const base = laneBase(id)
    const nth = seen.get(base) ?? 0
    seen.set(base, nth + 1)
    captured.set(`${base}#${nth}`, this)
    return register.call(this, id)
  }
  return captured
}

/** The label a lane should have after toggling mute. */
export function toggledMute(lane) {
  return lane.muted ? stripMute(lane.name) : `_${lane.name}`
}

/** The label a lane should have after toggling solo (soloing also unmutes). */
export function toggledSolo(lane) {
  return lane.soloed ? lane.name.slice(1) : `S${stripMute(lane.name)}`
}

/** Haps that start inside [begin, end), plus ones already sounding at `begin`. */
export function queryWindow(pattern, begin, end, cps) {
  let haps
  try {
    haps = pattern.queryArc(begin, end, { _cps: cps })
  } catch {
    return []
  }
  return haps.filter((h) => h.whole && (h.hasOnset() || Number(h.part.begin) === begin))
}

export function hapValue(hap) {
  return hap.value !== null && typeof hap.value === 'object' ? hap.value : { value: hap.value }
}

/** MIDI pitch for pitched events, or null for sample hits. */
export function pitchOf(v) {
  if (typeof v.note === 'number') return v.note
  if (typeof v.note === 'string') {
    try { return noteToMidi(v.note) } catch { return null }
  }
  if (typeof v.freq === 'number' && v.freq > 0) return 69 + 12 * Math.log2(v.freq / 440)
  return null
}

/** Row label for an unpitched event, e.g. "bd" or "hh:2". */
export function soundOf(v) {
  const s = v.s ?? v.sound ?? (typeof v.value !== 'object' ? v.value : undefined)
  if (s === undefined) return '·'
  return v.n !== undefined && typeof v.n !== 'object' ? `${s}:${v.n}` : String(s)
}

const TEMPO_CALLS = { setcpm: 'cpm', setCpm: 'cpm', setcps: 'cps', setCps: 'cps' }

/**
 * The code change that sets the tempo to `bpm` with `beats` per cycle (Strudel's usual
 * `setcpm(bpm/4)`): rewrites the arguments of the first top-level setcpm/setcps call,
 * or inserts `setcpm(bpm/beats)` at the top. Returns null when the code doesn't parse.
 */
export function tempoChange(code, bpm, beats = 4) {
  let ast
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch {
    return null
  }
  for (const node of ast.body) {
    const call = node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' ? node.expression : null
    const kind = call?.callee.type === 'Identifier' ? TEMPO_CALLS[call.callee.name] : null
    if (!kind) continue
    const insert = kind === 'cpm' ? `${bpm}/${beats}` : `${bpm}/60/${beats}`
    const from = call.arguments.length ? call.arguments[0].start : call.end - 1
    const to = call.arguments.length ? call.arguments[call.arguments.length - 1].end : call.end - 1
    return { from, to, insert }
  }
  return { from: 0, to: 0, insert: `setcpm(${bpm}/${beats})\n` }
}

/** Code to append for a new lane, with a label that isn't taken yet. */
export function newLaneCode(code, lanes) {
  const taken = new Set(lanes.map((l) => laneBase(l.name)))
  let n = lanes.length + 1
  while (taken.has(`lane${n}`)) n++
  const sep = code.length === 0 || code.endsWith('\n\n') ? '' : code.endsWith('\n') ? '\n' : '\n\n'
  return { from: code.length, to: code.length, insert: `${sep}lane${n}: s("hh*8").gain(.6)\n`, label: `lane${n}` }
}
