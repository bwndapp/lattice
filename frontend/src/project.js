import { parse } from 'acorn'
import { defaultData, demoGraph, graphCode, normalizeGraph } from './graph.js'

/**
 * A project is what the UI edits: a library of patterns (instruments with steps or notes,
 * plus their sound settings) and a node graph that routes patterns and other sources
 * through transforms and effects to an output (see graph.js).
 * It lives as JSON on one header line of the track's code, and everything below that line
 * is generated from it, so saving, sharing and remixing keep working and the code still
 * runs as Strudel. Nobody has to read the code; it's how a track travels.
 *
 *   // @project {"v":3,...}
 *   setcpm(120/4)
 *   const p_beat = stack(s("bd ~ ~ ~ …").bank("RolandTR909").room(0.2), …)
 *   const n_filter = p_bass.lpf(1200).lpq(8)
 *   out_in0: n_filter
 */

export const PROJECT_MARK = '// @project '

export const DRUM_SOUNDS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
export const SYNTH_SOUNDS = ['sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'piano']
export const BANKS = ['', 'RolandTR909', 'RolandTR808', 'RolandTR707', 'RolandTR606', 'LinnDrum', 'AkaiLinn', 'BossDR110', 'KorgMinipops', 'CasioRZ1', 'EmuDrumulator']

/**
 * Sound settings every instrument gets as knobs. `kinds` limits a knob to drum or synth
 * channels. Values equal to `def` are left out of the code.
 */
export const PARAMS = [
  { key: 'gain', label: 'vol', min: 0, max: 1.5, def: 1 },
  { key: 'pan', label: 'pan', min: 0, max: 1, def: 0.5 },
  { key: 'lpf', label: 'cutoff', min: 60, max: 20000, def: 20000, log: true, unit: 'hz' },
  { key: 'lpq', label: 'reso', min: 0, max: 25, def: 0 },
  { key: 'hpf', label: 'low cut', min: 20, max: 8000, def: 20, log: true, unit: 'hz' },
  { key: 'room', label: 'reverb', min: 0, max: 1, def: 0 },
  { key: 'delay', label: 'delay', min: 0, max: 0.9, def: 0 },
  { key: 'speed', label: 'pitch', min: 0.25, max: 4, def: 1, log: true, kinds: ['drum'], unit: 'x' },
  { key: 'attack', label: 'attack', min: 0, max: 2, def: 0, kinds: ['synth'], unit: 's' },
  { key: 'release', label: 'release', min: 0, max: 4, def: 0, kinds: ['synth'], unit: 's' },
  { key: 'shape', label: 'drive', min: 0, max: 0.9, def: 0 },
  { key: 'crush', label: 'crush', min: 0, max: 1, def: 0 },
]
const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]))
export const paramsFor = (kind) => PARAMS.filter((p) => !p.kinds || p.kinds.includes(kind))

let counter = 0
export const newId = () => `${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
export function noteToMidi(note) {
  const m = /^([a-g])([#b]?)(-?\d)$/i.exec(String(note).trim())
  if (!m) return 48
  const base = NOTE_NAMES.indexOf(m[1].toLowerCase())
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (Number(m[3]) + 1) * 12 + base + acc
}
export function midiToNote(midi) {
  const n = Math.max(0, Math.min(127, Math.round(midi)))
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`
}
export const isBlackKey = (midi) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)

// keep user text from breaking out of the strings, identifiers and comments it lands in
const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '') || 'bd'
const noteToken = (s) => (/^[a-g][#b]?-?\d$/i.test(String(s)) ? String(s).toLowerCase() : 'c3')
const commentText = (s) => String(s ?? '').replace(/\*\/|[\r\n]/g, ' ').slice(0, 40)
const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const tidy = (v) => String(Math.round(v * 1000) / 1000)

export function stepCount(pattern) {
  return pattern.bars * pattern.stepsPerBar
}

export function makeChannel(kind = 'drum', patch = {}) {
  const base = { id: newId(), kind, name: kind === 'code' ? 'code' : kind === 'synth' ? 'synth' : 'kick', mute: false, params: {}, fx: '' }
  if (kind === 'drum') Object.assign(base, { sound: 'bd', bank: 'RolandTR909', steps: [] })
  if (kind === 'synth') Object.assign(base, { sound: 'sawtooth', note: 'c3', notes: [] })
  if (kind === 'code') Object.assign(base, { code: 's("hh*8").gain(.5)' })
  const { params, ...rest } = patch
  return { ...base, ...rest, params: { ...(params ?? {}) } }
}

export function makePattern(name = 'pattern', patch = {}) {
  return { id: newId(), name, bars: 1, stepsPerBar: 16, channels: [], ...patch }
}

/** A channel's value for a knob (its default when unset). */
export function paramValue(ch, key) {
  return ch.params?.[key] ?? PARAM_BY_KEY[key].def
}

/** Fill in defaults and drop anything malformed, so a hand-edited header can't crash the UI. */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null
  const project = {
    v: 3,
    bpm: num(raw.bpm, 120, 10, 400),
    beats: Math.round(num(raw.beats, 4, 2, 8)),
    patterns: [],
  }
  for (const p of Array.isArray(raw.patterns) ? raw.patterns : []) {
    if (!p || typeof p.id !== 'string') continue
    const pattern = {
      id: p.id.replace(/\W/g, '') || newId(),
      name: String(p.name ?? 'pattern').slice(0, 40),
      bars: Math.round(num(p.bars, 1, 1, 16)),
      stepsPerBar: [4, 8, 12, 16, 24, 32].includes(p.stepsPerBar) ? p.stepsPerBar : 16,
      channels: [],
    }
    const n = stepCount(pattern)
    for (const c of Array.isArray(p.channels) ? p.channels : []) {
      if (!c || !['drum', 'synth', 'code'].includes(c.kind)) continue
      const rawParams = { ...(c.params ?? {}) }
      if (c.gain !== undefined && rawParams.gain === undefined) rawParams.gain = c.gain // v1 kept gain at the top
      const params = {}
      for (const def of PARAMS) {
        if (rawParams[def.key] === undefined) continue
        const v = num(rawParams[def.key], def.def, def.min, def.max)
        if (v !== def.def) params[def.key] = v
      }
      const ch = makeChannel(c.kind, {
        id: typeof c.id === 'string' ? c.id.replace(/\W/g, '') || newId() : newId(),
        name: String(c.name ?? c.kind).slice(0, 40),
        mute: !!c.mute,
        params,
        fx: typeof c.fx === 'string' ? c.fx.slice(0, 300) : '',
      })
      if (c.kind === 'code') ch.code = typeof c.code === 'string' ? c.code.slice(0, 2000) : ''
      else {
        ch.sound = soundToken(c.sound)
        if (c.kind === 'drum') {
          ch.bank = /^\w{0,40}$/.test(c.bank ?? '') ? c.bank ?? '' : ''
          const steps = Array.isArray(c.steps) ? c.steps : []
          ch.steps = Array.from({ length: n }, (_, i) => (steps[i] ? 1 : 0))
        }
        if (c.kind === 'synth') {
          ch.note = noteToken(c.note)
          // v1 synths had one note name per step; v2 has notes with a start, length and pitch
          const source = Array.isArray(c.notes)
            ? c.notes
            : (Array.isArray(c.steps) ? c.steps : []).map((v, i) => (v ? { s: i, l: 1, n: noteToMidi(v) } : null))
          const seen = new Set()
          ch.notes = source
            .filter((x) => x && Number.isFinite(Number(x.s)) && Number.isFinite(Number(x.n)) && Number(x.s) < n)
            .map((x) => {
              const s = Math.round(num(x.s, 0, 0, n - 1))
              return { s, l: Math.round(num(x.l, 1, 1, n - s)), n: Math.round(num(x.n, 48, 0, 127)) }
            })
            .filter((x) => { const k = `${x.s}:${x.n}`; if (seen.has(k)) return false; seen.add(k); return true })
            .sort((a, b) => a.s - b.s || a.n - b.n)
        }
      }
      pattern.channels.push(ch)
    }
    project.patterns.push(pattern)
  }
  const patternIds = new Set(project.patterns.map((p) => p.id))
  let graph = raw
  if (!Array.isArray(raw.nodes) && Array.isArray(raw.tracks)) graph = graphFromTracks(raw.tracks, patternIds)
  const { nodes, edges } = normalizeGraph(graph, patternIds)
  project.nodes = nodes
  project.edges = edges
  if (typeof raw.prelude === 'string' && raw.prelude.trim()) project.prelude = raw.prelude.slice(0, 20000)
  if (!nodes.some((n) => n.type === 'output')) project.nodes.push({ id: 'out', type: 'output', x: 700, y: 200, data: { muted: {}, solo: null } })
  return project
}

/** The project in a code string, or null when the code isn't a project. */
export function parseProject(code) {
  const line = String(code).split('\n', 1)[0]
  if (!line.startsWith(PROJECT_MARK)) return null
  try {
    return normalizeProject(JSON.parse(line.slice(PROJECT_MARK.length)))
  } catch {
    return null
  }
}

/** Split notes into voices that never overlap, so each voice is one mini-notation sequence. */
export function noteVoices(notes) {
  const voices = []
  for (const note of [...notes].sort((a, b) => a.s - b.s || a.n - b.n)) {
    const voice = voices.find((v) => v.end <= note.s)
    if (voice) { voice.notes.push(note); voice.end = note.s + note.l } else voices.push({ notes: [note], end: note.s + note.l })
  }
  return voices.map((v) => v.notes)
}

const rest = (len) => (len === 1 ? '~' : `~@${len}`)

function sequenceOf(notes, total) {
  const tokens = []
  let cursor = 0
  for (const note of notes) {
    if (note.s > cursor) tokens.push(rest(note.s - cursor))
    tokens.push(note.l > 1 ? `${midiToNote(note.n)}@${note.l}` : midiToNote(note.n))
    cursor = note.s + note.l
  }
  if (cursor < total) tokens.push(rest(total - cursor))
  return tokens.join(' ')
}

function paramCode(ch) {
  let out = ''
  for (const def of paramsFor(ch.kind)) {
    const v = paramValue(ch, def.key)
    if (v === def.def) continue
    if (def.key === 'crush') out += `.crush(${Math.round(16 - v * 14)})` // amount → bits: more crush, fewer bits
    else if (def.key === 'delay') out += `.delay(${tidy(v)}).delaytime(.1875).delayfeedback(.35)`
    else out += `.${def.key}(${def.log && v > 10 ? Math.round(v) : tidy(v)})`
  }
  return out
}

function channelCode(ch, pattern) {
  const total = stepCount(pattern)
  let expr
  if (ch.kind === 'code') {
    expr = ch.code?.trim() || 'silence'
  } else if (ch.kind === 'synth') {
    if (!ch.notes?.length) return `/* ${commentText(ch.name)} */ silence`
    const seq = noteVoices(ch.notes).map((voice) => sequenceOf(voice, total)).join(', ')
    expr = `note("${seq}").s("${soundToken(ch.sound)}")${pattern.bars > 1 ? `.slow(${pattern.bars})` : ''}`
  } else {
    const tokens = Array.from({ length: total }, (_, i) => (ch.steps?.[i] ? soundToken(ch.sound) : '~'))
    // group steps by bar so the generated code is readable
    const bars = []
    for (let b = 0; b < pattern.bars; b++) bars.push(tokens.slice(b * pattern.stepsPerBar, (b + 1) * pattern.stepsPerBar).join(' '))
    const seq = pattern.bars > 1 ? `<${bars.map((b) => `[${b}]`).join(' ')}>` : bars[0]
    expr = `s("${seq}")${ch.bank ? `.bank("${String(ch.bank).replace(/\W/g, '')}")` : ''}`
  }
  expr += paramCode(ch)
  if (ch.fx?.trim()) expr += ch.fx.trim().startsWith('.') ? ch.fx.trim() : `.${ch.fx.trim()}`
  return `/* ${commentText(ch.name)} */ ${expr}`
}

export const patternVar = (id) => `p_${id}`

/**
 * The Strudel code for a project: every pattern as a const, then the graph. `solo` (a
 * node id) plays just that node, for auditioning part of the patch.
 */
export function generateCode(project, { solo = null } = {}) {
  const lines = [
    `${PROJECT_MARK}${JSON.stringify(project)}`,
    '// generated by the strudel studio: open the track there to edit it',
    `setcpm(${project.bpm}/${project.beats})`,
    '',
  ]
  if (project.prelude) lines.push('// setup, kept from the original code', project.prelude, '')
  for (const pattern of project.patterns) {
    const live = pattern.channels.filter((c) => !c.mute)
    lines.push(`// pattern: ${commentText(pattern.name)} (${pattern.bars} bar${pattern.bars === 1 ? '' : 's'})`)
    lines.push(live.length
      ? `const ${patternVar(pattern.id)} = stack(\n${live.map((c) => `  ${channelCode(c, pattern)},`).join('\n')}\n)`
      : `const ${patternVar(pattern.id)} = silence`)
  }
  const patternSolo = typeof solo === 'string' && solo.startsWith('pattern:') && project.patterns.some((p) => `pattern:${p.id}` === solo)
  const graph = graphCode(project, { solo: patternSolo ? null : solo })
  lines.push('', ...graph.lines.map((l) => (l.startsWith('// ') ? `// ${commentText(l.slice(3))}` : l)))
  if (patternSolo) lines.push('', '// auditioning one pattern', ...graph.lanes.map((l) => `_${l.replace(/^_/, '')}`), `solo: ${patternVar(solo.slice(8))}`)
  else lines.push('', solo ? '// auditioning one node' : '// output', ...(graph.lanes.length ? graph.lanes : ['$: silence']))
  return `${lines.join('\n')}\n`
}

/** v2 projects arranged patterns on tracks; bring each pattern they used into the graph. */
function graphFromTracks(tracks, patternIds) {
  const nodes = [{ id: 'out', type: 'output', x: 520, y: 40, data: { muted: {}, solo: null } }]
  const edges = []
  const seen = new Set()
  let slot = 0
  for (const track of tracks) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (!patternIds.has(clip?.pattern) || seen.has(clip.pattern)) continue
      seen.add(clip.pattern)
      const id = `pat${slot}`
      nodes.push({ id, type: 'pattern', x: 40, y: 40 + slot * 190, data: { patternId: clip.pattern } })
      edges.push({ source: id, target: 'out', targetHandle: `in-${slot}` })
      if (track.mute) nodes[0].data.muted[`in-${slot}`] = true
      slot++
    }
  }
  return { nodes, edges }
}

/** A starter project: a beat and a bassline, patched through a few effects. */
export function demoProject() {
  const on = (n, every, offset = 0) => Array.from({ length: n }, (_, i) => ((i - offset) % every === 0 && i >= offset ? 1 : 0))
  const notes = (list) => list.map(([s, l, n]) => ({ s, l, n: noteToMidi(n) }))
  const beat = makePattern('beat', {
    channels: [
      makeChannel('drum', { name: 'kick', sound: 'bd', steps: on(16, 4) }),
      makeChannel('drum', { name: 'clap', sound: 'cp', steps: on(16, 8, 4), params: { room: 0.2, gain: 0.8 } }),
      makeChannel('drum', { name: 'open hat', sound: 'oh', steps: on(16, 4, 2), params: { gain: 0.45, pan: 0.4 } }),
    ],
  })
  const bass = makePattern('bassline', {
    channels: [makeChannel('synth', {
      name: 'bass',
      sound: 'sawtooth',
      note: 'c2',
      notes: notes([[0, 2, 'c2'], [3, 1, 'c2'], [6, 2, 'eb2'], [8, 2, 'c2'], [11, 2, 'g1'], [14, 2, 'bb1']]),
      params: { lpf: 900, lpq: 6, release: 0.1 },
      fx: '.decay(.2).sustain(0)',
    })],
  })
  // four bars of chords: Cm, Ab, Eb, Bb, one per bar
  const chord = (bar, names) => names.map((n) => [bar * 16, 16, n])
  const chords = makePattern('chords', {
    bars: 4,
    channels: [makeChannel('synth', {
      name: 'pad',
      sound: 'sawtooth',
      note: 'c4',
      notes: notes([...chord(0, ['c4', 'eb4', 'g4']), ...chord(1, ['ab3', 'c4', 'eb4']), ...chord(2, ['eb4', 'g4', 'bb4']), ...chord(3, ['bb3', 'd4', 'f4'])]),
      params: { lpf: 1800, gain: 0.35, attack: 0.08, release: 0.4 },
    })],
  })
  return normalizeProject({ v: 3, bpm: 124, beats: 4, patterns: [beat, bass, chords], ...demoGraph(beat.id, bass.id, chords.id) })
}

const TEMPO = { setcpm: 'cpm', setCpm: 'cpm', setcps: 'cps', setCps: 'cps' }

/**
 * Turn any Strudel code into a patch. Named parts (`drums: …`, `$: …`) become one code
 * node each; code without names becomes one code node for its final pattern. Everything
 * else (samples(), consts, helpers) is kept as setup that runs first, and the tempo is
 * read from setcpm / setcps. Returns { project, parts } or { error } naming a line.
 */
export function projectFromCode(code, { bpm: fallbackBpm = 120, beats = 4 } = {}) {
  const src = String(code ?? '')
  let ast
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch (e) {
    return { error: `The code has a mistake on line ${e.loc?.line ?? '?'}. Fix it in the code view, then try again.` }
  }
  const text = (node) => src.slice(node.start, node.end)
  let bpm = fallbackBpm
  const parts = []
  const setup = []
  const statements = ast.body
  const lastExpr = [...statements].reverse().find((n) => n.type === 'ExpressionStatement')
  const hasLabels = statements.some((n) => n.type === 'LabeledStatement')
  for (const node of statements) {
    if (node.type === 'LabeledStatement') {
      const name = node.label.name
      const muted = name.startsWith('_') || name.endsWith('_')
      const base = name.replace(/^_+|_+$/g, '').replace(/^S(?=.)/, '')
      parts.push({ title: base === '$' ? null : base, source: text(node.body).replace(/;\s*$/, ''), muted })
      continue
    }
    const call = node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' ? node.expression : null
    const kind = call?.callee.type === 'Identifier' ? TEMPO[call.callee.name] : null
    if (kind) {
      const arg = call.arguments[0] ? text(call.arguments[0]) : ''
      if (/^[\d\s.+\-*/()]+$/.test(arg)) {
        try {
          const value = Function(`"use strict"; return (${arg})`)()
          if (Number.isFinite(value) && value > 0) bpm = Math.round((kind === 'cpm' ? value * beats : value * 60 * beats) * 10) / 10
          continue
        } catch { /* not plain arithmetic: keep it as setup */ }
      }
      setup.push(text(node)) // tempo that isn't a plain number stays in the code
      continue
    }
    if (!hasLabels && node === lastExpr) { parts.push({ title: 'code', source: text(node.expression), muted: false }); continue }
    setup.push(text(node))
  }
  const nodes = [{ id: 'out', type: 'output', x: 600, y: 40, data: { muted: {}, solo: null } }]
  const edges = []
  parts.forEach((part, i) => {
    const id = `code${i}`
    nodes.push({ id, type: 'code', x: 40, y: 40 + i * 190, data: { ...defaultData('code'), code: part.source, name: part.title ?? `part ${i + 1}` } })
    edges.push({ source: id, target: 'out', targetHandle: `in-${i}` })
    if (part.muted) nodes[0].data.muted[`in-${i}`] = true
  })
  const project = normalizeProject({ v: 3, bpm, beats, patterns: [], nodes, edges, prelude: setup.join('\n') })
  return { project, parts: parts.length }
}

/** Instruments you can drag into a pattern. Drums and synths start empty. */
export const INSTRUMENTS = [
  { key: 'kick', label: 'kick', kind: 'drum', patch: { sound: 'bd' } },
  { key: 'snare', label: 'snare', kind: 'drum', patch: { sound: 'sd' } },
  { key: 'clap', label: 'clap', kind: 'drum', patch: { sound: 'cp' } },
  { key: 'hat', label: 'hat', kind: 'drum', patch: { sound: 'hh', params: { gain: 0.7 } } },
  { key: 'openhat', label: 'open hat', kind: 'drum', patch: { sound: 'oh', params: { gain: 0.7 } } },
  { key: 'rim', label: 'rim', kind: 'drum', patch: { sound: 'rim' } },
  { key: 'tom', label: 'tom', kind: 'drum', patch: { sound: 'lt' } },
  { key: 'crash', label: 'crash', kind: 'drum', patch: { sound: 'cr', params: { gain: 0.6 } } },
  { key: 'bass', label: 'bass', kind: 'synth', patch: { sound: 'sawtooth', note: 'c2', params: { lpf: 900, lpq: 6, release: 0.1 }, fx: '.decay(.2).sustain(0)' } },
  { key: 'lead', label: 'lead', kind: 'synth', patch: { sound: 'square', note: 'c4', params: { lpf: 2400, gain: 0.6, release: 0.2 } } },
  { key: 'pad', label: 'pad', kind: 'synth', patch: { sound: 'supersaw', note: 'c3', params: { attack: 0.2, release: 0.8, room: 0.5, gain: 0.5 } } },
  { key: 'pluck', label: 'pluck', kind: 'synth', patch: { sound: 'triangle', note: 'c4', params: { delay: 0.3 }, fx: '.decay(.12).sustain(0)' } },
  { key: 'piano', label: 'piano', kind: 'synth', patch: { sound: 'piano', note: 'c4' } },
  { key: 'code', label: 'code', kind: 'code', patch: {} },
]

export const INSTRUMENT_MIME = 'application/x-strudel-instrument'

/** A new channel for instrument `key`, named so it doesn't clash inside `pattern`. */
export function instrumentChannel(key, pattern) {
  const preset = INSTRUMENTS.find((i) => i.key === key) ?? INSTRUMENTS[0]
  const taken = new Set(pattern.channels.map((c) => c.name))
  let name = preset.label
  for (let n = 2; taken.has(name); n++) name = `${preset.label} ${n}`
  const ch = makeChannel(preset.kind, { ...JSON.parse(JSON.stringify(preset.patch)), name })
  if (ch.kind === 'drum') ch.steps = Array.from({ length: stepCount(pattern) }, () => 0)
  return ch
}

/** Resize a pattern (bars / steps per bar), keeping what's in it. Mutates `pat`. */
export function reshapePattern(pat, patch) {
  const from = { bars: pat.bars, stepsPerBar: pat.stepsPerBar }
  const to = { ...from, ...patch }
  const ratio = to.stepsPerBar / from.stepsPerBar
  const oldTotal = from.bars * from.stepsPerBar
  const newTotal = to.bars * to.stepsPerBar
  for (const c of pat.channels) {
    if (c.kind === 'drum') {
      const out = Array.from({ length: newTotal }, () => 0)
      for (let i = 0; i < newTotal; i++) {
        const src = i / ratio
        // new bars beyond the old length repeat the existing ones
        if (Number.isInteger(src)) out[i] = c.steps[src % Math.max(1, oldTotal)] ? 1 : 0
      }
      c.steps = out
    } else if (c.kind === 'synth') {
      const scaled = c.notes.map((x) => ({ ...x, s: Math.round(x.s * ratio), l: Math.max(1, Math.round(x.l * ratio)) }))
      const out = []
      const period = oldTotal * ratio
      for (let offset = 0; offset < newTotal; offset += period) {
        for (const x of scaled) if (x.s + offset < newTotal) out.push({ ...x, s: x.s + offset, l: Math.min(x.l, newTotal - x.s - offset) })
      }
      c.notes = out
    }
  }
  Object.assign(pat, patch)
}
