/**
 * A project is the FL-style structure the UI edits: patterns (a stack of channels, each a
 * step sequence) and tracks (clips of those patterns placed on bars). It lives as JSON on
 * one header line of the track's code, and everything below that line is generated from
 * it, so saving, sharing and remixing keep working and the code still runs as Strudel.
 *
 *   // @project {"v":1,...}
 *   setcpm(120/4)
 *   const p_beat = stack(s("bd ~ ~ ~ …").bank("RolandTR909"), …)
 *   t_main: stack(p_beat.late(0).mask("<1!8>"))
 */

export const PROJECT_MARK = '// @project '

export const DRUM_SOUNDS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
export const SYNTH_SOUNDS = ['sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'piano']
export const BANKS = ['', 'RolandTR909', 'RolandTR808', 'RolandTR707', 'RolandTR606', 'LinnDrum', 'AkaiLinn', 'BossDR110', 'KorgMinipops', 'CasioRZ1', 'EmuDrumulator']

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

// keep user text from breaking out of the strings, identifiers and comments it lands in
const soundToken = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '') || 'bd'
const noteToken = (s) => (/^[a-g][#b]?-?\d$/i.test(String(s)) ? String(s).toLowerCase() : 'c3')
const commentText = (s) => String(s ?? '').replace(/\*\/|[\r\n]/g, ' ').slice(0, 40)
const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)

export function stepCount(pattern) {
  return pattern.bars * pattern.stepsPerBar
}

export function makeChannel(kind = 'drum', patch = {}) {
  const base = { id: newId(), kind, name: kind === 'code' ? 'code' : kind === 'synth' ? 'synth' : 'kick', mute: false, gain: 1, fx: '' }
  if (kind === 'drum') Object.assign(base, { sound: 'bd', bank: 'RolandTR909', steps: [] })
  if (kind === 'synth') Object.assign(base, { sound: 'sawtooth', note: 'c3', steps: [] })
  if (kind === 'code') Object.assign(base, { code: 's("hh*8").gain(.5)' })
  return { ...base, ...patch }
}

export function makePattern(name = 'pattern', patch = {}) {
  return { id: newId(), name, bars: 1, stepsPerBar: 16, channels: [], ...patch }
}

export function makeTrack(name = 'track', patch = {}) {
  return { id: newId(), name, mute: false, solo: false, clips: [], ...patch }
}

/** Fill in defaults and drop anything malformed, so a hand-edited header can't crash the UI. */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null
  const project = {
    v: 1,
    bpm: num(raw.bpm, 120, 10, 400),
    beats: Math.round(num(raw.beats, 4, 2, 8)),
    patterns: [],
    tracks: [],
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
      const ch = makeChannel(c.kind, {
        id: typeof c.id === 'string' ? c.id.replace(/\W/g, '') : newId(),
        name: String(c.name ?? c.kind).slice(0, 40),
        mute: !!c.mute,
        gain: num(c.gain, 1, 0, 2),
        fx: typeof c.fx === 'string' ? c.fx.slice(0, 300) : '',
      })
      if (c.kind === 'code') ch.code = typeof c.code === 'string' ? c.code.slice(0, 2000) : ''
      else {
        ch.sound = soundToken(c.sound)
        if (c.kind === 'drum') ch.bank = BANKS.includes(c.bank) || /^\w{0,40}$/.test(c.bank ?? '') ? c.bank ?? '' : ''
        if (c.kind === 'synth') ch.note = noteToken(c.note)
        const steps = Array.isArray(c.steps) ? c.steps : []
        ch.steps = Array.from({ length: n }, (_, i) =>
          c.kind === 'synth' ? (steps[i] ? noteToken(steps[i]) : null) : steps[i] ? 1 : 0)
      }
      pattern.channels.push(ch)
    }
    project.patterns.push(pattern)
  }
  const patternIds = new Set(project.patterns.map((p) => p.id))
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (!t || typeof t.id !== 'string') continue
    const track = makeTrack(String(t.name ?? 'track').slice(0, 40), {
      id: t.id.replace(/\W/g, '') || newId(),
      mute: !!t.mute,
      solo: !!t.solo,
      clips: [],
    })
    for (const c of Array.isArray(t.clips) ? t.clips : []) {
      if (!c || !patternIds.has(c.pattern)) continue
      track.clips.push({ id: typeof c.id === 'string' ? c.id.replace(/\W/g, '') : newId(), pattern: c.pattern, bar: Math.round(num(c.bar, 0, 0, 4096)), bars: Math.round(num(c.bars, 1, 1, 512)) })
    }
    track.clips.sort((a, b) => a.bar - b.bar)
    project.tracks.push(track)
  }
  if (!project.tracks.length) project.tracks.push(makeTrack('track 1'))
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

/** Bars until the end of the last clip (at least one). The song loops there. */
export function songLength(project) {
  let end = 0
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.bar + c.bars)
  return Math.max(1, end)
}

function channelCode(ch, pattern) {
  let expr
  if (ch.kind === 'code') {
    expr = ch.code?.trim() || 'silence'
  } else {
    const tokens = Array.from({ length: stepCount(pattern) }, (_, i) => {
      const v = ch.steps?.[i]
      return !v ? '~' : ch.kind === 'synth' ? noteToken(v) : soundToken(ch.sound)
    })
    // group steps by bar so the generated code is readable
    const bars = []
    for (let b = 0; b < pattern.bars; b++) bars.push(tokens.slice(b * pattern.stepsPerBar, (b + 1) * pattern.stepsPerBar).join(' '))
    const seq = pattern.bars > 1 ? `<${bars.map((b) => `[${b}]`).join(' ')}>` : bars[0]
    expr = ch.kind === 'synth'
      ? `note("${seq}").s("${soundToken(ch.sound)}")`
      : `s("${seq}")${ch.bank ? `.bank("${String(ch.bank).replace(/\W/g, '')}")` : ''}`
  }
  if (ch.gain !== 1) expr += `.gain(${Math.round(ch.gain * 100) / 100})`
  if (ch.fx?.trim()) expr += ch.fx.trim().startsWith('.') ? ch.fx.trim() : `.${ch.fx.trim()}`
  return `/* ${commentText(ch.name)} */ ${expr}`
}

/**
 * Mini-notation that is 1 for bars [from, to) of a song and 0 elsewhere, one step per
 * cycle, run-length encoded: bars 2–8 of 8 → "<0!2 1!6>". It must be a string literal in
 * the code: Strudel only reads double-quoted literals as mini-notation.
 */
export function barMask(from, to, song) {
  const runs = [[0, Math.min(from, song)], [1, Math.max(0, Math.min(to, song) - from)], [0, Math.max(0, song - to)]]
  return `<${runs.filter(([, n]) => n > 0).map(([v, n]) => (n === 1 ? `${v}` : `${v}!${n}`)).join(' ')}>`
}

export const patternVar = (id) => `p_${id}`
export const trackLabel = (track) => (track.mute ? `_t_${track.id}` : track.solo ? `St_${track.id}` : `t_${track.id}`)

/**
 * The Strudel code for a project. `mode: 'pattern'` plays only `current` on a loop (the
 * song tracks are emitted muted), like FL's pattern/song switch.
 */
export function generateCode(project, { mode = 'song', current = null } = {}) {
  const song = songLength(project)
  const lines = [
    `${PROJECT_MARK}${JSON.stringify(project)}`,
    '// generated from the playlist and channel rack; edit there, or detach to edit as code',
    `setcpm(${project.bpm}/${project.beats})`,
    '',
    `// song: ${song} bar${song === 1 ? '' : 's'}, then it loops`,
    '',
  ]
  for (const pattern of project.patterns) {
    const live = pattern.channels.filter((c) => !c.mute)
    lines.push(`// pattern: ${commentText(pattern.name)} (${pattern.bars} bar${pattern.bars === 1 ? '' : 's'})`)
    lines.push(live.length
      ? `const ${patternVar(pattern.id)} = stack(\n${live.map((c) => `  ${channelCode(c, pattern)},`).join('\n')}\n)`
      : `const ${patternVar(pattern.id)} = silence`)
    lines.push('')
  }
  const soloing = mode === 'pattern'
  for (const track of project.tracks) {
    const clips = track.clips.filter((c) => project.patterns.some((p) => p.id === c.pattern))
    const body = clips.length
      ? `stack(${clips.map((c) => `${patternVar(c.pattern)}.late(${c.bar}).mask("${barMask(c.bar, c.bar + c.bars, song)}")`).join(', ')})`
      : 'silence'
    const label = soloing ? `_t_${track.id}` : trackLabel(track)
    lines.push(`// track: ${commentText(track.name)}`)
    lines.push(`${label}: ${body}`)
  }
  if (soloing && project.patterns.some((p) => p.id === current)) {
    lines.push('', '// pattern mode: loop the pattern being edited', `pattern: ${patternVar(current)}`)
  }
  return `${lines.join('\n')}\n`
}

/** A starter project: a beat and a bassline arranged over 8 bars. */
export function demoProject() {
  const on = (n, every, offset = 0) => Array.from({ length: n }, (_, i) => ((i - offset) % every === 0 && i >= offset ? 1 : 0))
  const beat = makePattern('beat', {
    channels: [
      makeChannel('drum', { name: 'kick', sound: 'bd', steps: on(16, 4) }),
      makeChannel('drum', { name: 'snare', sound: 'sd', steps: on(16, 8, 4) }),
      makeChannel('drum', { name: 'hat', sound: 'hh', gain: 0.6, steps: on(16, 2, 2) }),
    ],
  })
  const bassSteps = Array(16).fill(null)
  ;[[0, 'c2'], [3, 'c2'], [6, 'eb2'], [8, 'c2'], [11, 'g1'], [14, 'bb1']].forEach(([i, n]) => { bassSteps[i] = n })
  const bass = makePattern('bassline', {
    channels: [makeChannel('synth', { name: 'bass', sound: 'sawtooth', note: 'c2', steps: bassSteps, fx: '.lpf(900).decay(.2).sustain(0)' })],
  })
  return normalizeProject({
    v: 1,
    bpm: 120,
    beats: 4,
    patterns: [beat, bass],
    tracks: [
      makeTrack('drums', { clips: [{ id: newId(), pattern: beat.id, bar: 0, bars: 8 }] }),
      makeTrack('bass', { clips: [{ id: newId(), pattern: bass.id, bar: 2, bars: 6 }] }),
      makeTrack('track 3'),
    ],
  })
}

/** Turn labeled code lanes into a project: one code-channel pattern and one track per lane. */
export function projectFromLanes(lanes, { bpm = 120, beats = 4 } = {}) {
  const project = { v: 1, bpm, beats, patterns: [], tracks: [] }
  lanes.forEach((lane, i) => {
    const name = lane.title ?? `lane ${i + 1}`
    const pattern = makePattern(name, { channels: [makeChannel('code', { name, code: lane.source })] })
    project.patterns.push(pattern)
    project.tracks.push(makeTrack(name, { mute: lane.muted, clips: [{ id: newId(), pattern: pattern.id, bar: 0, bars: 8 }] }))
  })
  return normalizeProject(project)
}

/** Put a clip on a track, removing whatever it overlaps. Returns the clip. */
export function placeClip(track, clip) {
  const end = clip.bar + clip.bars
  track.clips = track.clips.filter((c) => c.id === clip.id || c.bar + c.bars <= clip.bar || c.bar >= end)
  if (!track.clips.some((c) => c.id === clip.id)) track.clips.push(clip)
  track.clips.sort((a, b) => a.bar - b.bar)
  return clip
}

/** Instruments you can drag into a pattern. Drums and synths start with empty steps. */
export const INSTRUMENTS = [
  { key: 'kick', label: 'kick', kind: 'drum', patch: { sound: 'bd' } },
  { key: 'snare', label: 'snare', kind: 'drum', patch: { sound: 'sd' } },
  { key: 'clap', label: 'clap', kind: 'drum', patch: { sound: 'cp' } },
  { key: 'hat', label: 'hat', kind: 'drum', patch: { sound: 'hh', gain: 0.7 } },
  { key: 'openhat', label: 'open hat', kind: 'drum', patch: { sound: 'oh', gain: 0.7 } },
  { key: 'rim', label: 'rim', kind: 'drum', patch: { sound: 'rim' } },
  { key: 'tom', label: 'tom', kind: 'drum', patch: { sound: 'lt' } },
  { key: 'crash', label: 'crash', kind: 'drum', patch: { sound: 'cr', gain: 0.6 } },
  { key: 'bass', label: 'bass', kind: 'synth', patch: { sound: 'sawtooth', note: 'c2', fx: '.lpf(900).decay(.2).sustain(0)' } },
  { key: 'lead', label: 'lead', kind: 'synth', patch: { sound: 'square', note: 'c4', fx: '.lpf(2400).decay(.15).sustain(.2)', gain: 0.6 } },
  { key: 'pad', label: 'pad', kind: 'synth', patch: { sound: 'supersaw', note: 'c3', fx: '.attack(.2).release(.8).room(.5)', gain: 0.5 } },
  { key: 'pluck', label: 'pluck', kind: 'synth', patch: { sound: 'triangle', note: 'c4', fx: '.decay(.12).sustain(0).delay(.25)' } },
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
  const ch = makeChannel(preset.kind, { ...preset.patch, name })
  if (ch.kind !== 'code') ch.steps = Array.from({ length: stepCount(pattern) }, () => (ch.kind === 'synth' ? null : 0))
  return ch
}
