/**
 * Phyllo: a layered synth. A patch is a few stacked sound layers (analog, supersaw,
 * wavetable, noise), one filter, an amp envelope, a mod envelope, two LFOs and a list of
 * modulation routes. It compiles to plain Strudel: each layer is one voice per note, the
 * shared parts chain after them.
 *
 * Strudel routes some modulation natively and continuously (filter env and LFO, pitch
 * env, vibrato, tremolo, FM env, wavetable position and warp). A route with no native
 * slot falls back to a value sampled at the start of each note ("per note"); a route
 * that can't work at all (an envelope on a pan knob, say) is kept but marked "off".
 */
import { registerWaveTable } from '@strudel/webaudio'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def)
const tidy = (v) => String(Math.round(Number(v) * 1000) / 1000)
const pick = (v, options, def) => (options.includes(v) ? v : def)
export const newPartId = () => Math.random().toString(36).slice(2, 8)

// ── controls ─────────────────────────────────────────────────────────────────

/** Knob specs, shared by the panel, the node face and modulation ranges. */
export const K = {
  level: { key: 'level', label: 'level', min: 0, max: 1, def: 0.8 },
  pan: { key: 'pan', label: 'pan', min: 0, max: 1, def: 0.5 },
  fine: { key: 'fine', label: 'fine', min: -100, max: 100, def: 0, unit: 'ct', origin: 0 },
  pw: { key: 'pw', label: 'width', min: 0.02, max: 0.98, def: 0.5 },
  pos: { key: 'pos', label: 'position', min: 0, max: 1, def: 0 },
  warp: { key: 'warp', label: 'warp', min: 0, max: 1, def: 0 },
  detune: { key: 'detune', label: 'detune', min: 0, max: 1, def: 0.18 },
  spread: { key: 'spread', label: 'spread', min: 0, max: 1, def: 0.6 },
  fm: { key: 'fm', label: 'fm', min: 0, max: 8, def: 0 },
  ratio: { key: 'ratio', label: 'ratio', min: 0.25, max: 8, def: 1, log: true, unit: 'x' },
  cutoff: { key: 'cutoff', label: 'cutoff', min: 30, max: 20000, def: 2400, log: true, unit: 'hz' },
  reso: { key: 'reso', label: 'reso', min: 0, max: 20, def: 1, unit: 'raw' },
  drive: { key: 'drive', label: 'drive', min: 0, max: 1, def: 0 },
  attack: { key: 'attack', label: 'attack', min: 0.001, max: 4, def: 0.005, log: true, unit: 's' },
  decay: { key: 'decay', label: 'decay', min: 0.01, max: 4, def: 0.3, log: true, unit: 's' },
  sustain: { key: 'sustain', label: 'sustain', min: 0, max: 1, def: 0.8 },
  release: { key: 'release', label: 'release', min: 0.01, max: 8, def: 0.2, log: true, unit: 's' },
  hz: { key: 'hz', label: 'rate', min: 0.05, max: 30, def: 2, log: true, unit: 'hz' },
  volume: { key: 'volume', label: 'volume', min: 0, max: 1.5, def: 0.8 },
}

export const LAYER_TYPES = {
  analog: { label: 'analog', blurb: 'Classic waves' },
  supersaw: { label: 'supersaw', blurb: 'A stack of detuned saws' },
  wavetable: { label: 'wavetable', blurb: 'Scan through a table of waveforms' },
  noise: { label: 'noise', blurb: 'Air, hiss and texture' },
}
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'pulse']
export const NOISES = ['white', 'pink', 'brown']
export const FM_WAVES = ['sine', 'triangle', 'sawtooth', 'square']
export const WARP_MODES = ['none', 'asym', 'mirror', 'bendp', 'bendm', 'bendmp', 'sync', 'quant', 'fold', 'pwm', 'orbit', 'spin', 'chaos', 'primes', 'binary', 'brownian', 'reciprocal', 'wormhole', 'logistic', 'sigmoid', 'fractal', 'flip']
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass']
export const FILTER_SLOPES = ['12db', '24db', 'ladder']
export const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square']
/** LFO lengths when synced, in bars (a Strudel cycle is one bar here). */
export const LFO_BARS = [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32]
export const barsLabel = (b) => (b >= 1 ? `${b} bar${b === 1 ? '' : 's'}` : `1/${Math.round(1 / b)}`)
export const MAX_LAYERS = 4
export const SOURCES = ['env', 'lfo1', 'lfo2']
export const SOURCE_LABELS = { env: 'mod env', lfo1: 'lfo 1', lfo2: 'lfo 2' }

// ── wavetables ───────────────────────────────────────────────────────────────

const FRAME = 2048
const FRAMES = 64
export const TABLES = {
  basic: 'sine → triangle → saw → square',
  bright: 'one harmonic → all of them',
  pulse: 'pulse width, wide → thin',
  vowel: 'a talking sweep: a e i o u',
  sync: 'hard sync, climbing',
  fold: 'a sine, folded harder',
}
const tableKey = (name) => `wt_phyllo_${name}`

let tableData = null // name → Float32Array[] (one per frame)

/** Build every table (about 50 ms, once) and register them with Strudel's wavetable synth. */
export function ensureTables() {
  if (tableData) return tableData
  tableData = {}
  const H = 40
  const sinT = new Float32Array(FRAME)
  const cosT = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) { sinT[i] = Math.sin((2 * Math.PI * i) / FRAME); cosT[i] = Math.cos((2 * Math.PI * i) / FRAME) }
  const additive = (coeffs) => { // coeffs(frame t 0..1) → { s: sine amps[H+1], c: cosine amps[H+1] }
    const frames = []
    for (let f = 0; f < FRAMES; f++) {
      const { s, c } = coeffs(f / (FRAMES - 1))
      const out = new Float32Array(FRAME)
      for (let h = 1; h <= H; h++) {
        const a = s[h] ?? 0
        const b = c?.[h] ?? 0
        if (!a && !b) continue
        for (let i = 0; i < FRAME; i++) out[i] += a * sinT[(h * i) & (FRAME - 1)] + b * cosT[(h * i) & (FRAME - 1)]
      }
      frames.push(out)
    }
    return frames
  }
  const timeDomain = (fn) => {
    const frames = []
    for (let f = 0; f < FRAMES; f++) {
      const out = new Float32Array(FRAME)
      for (let i = 0; i < FRAME; i++) out[i] = fn(f / (FRAMES - 1), i / FRAME)
      frames.push(out)
    }
    return frames
  }
  const shapes = {
    sine: (h) => (h === 1 ? 1 : 0),
    tri: (h) => (h % 2 ? ((((h - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * h * h) : 0),
    saw: (h) => (2 / Math.PI) * ((h % 2 ? 1 : -1) / h),
    square: (h) => (h % 2 ? 4 / (Math.PI * h) : 0),
  }
  const morph = ['sine', 'tri', 'saw', 'square']
  tableData.basic = additive((t) => {
    const x = t * (morph.length - 1)
    const i = Math.min(morph.length - 2, Math.floor(x))
    const k = x - i
    const s = []
    for (let h = 1; h <= H; h++) s[h] = shapes[morph[i]](h) * (1 - k) + shapes[morph[i + 1]](h) * k
    return { s }
  })
  tableData.bright = additive((t) => {
    const n = 1 + t * (H - 1)
    const s = []
    for (let h = 1; h <= H; h++) s[h] = clamp(n - h + 1, 0, 1) / h
    return { s }
  })
  tableData.pulse = additive((t) => {
    const w = 0.5 - t * 0.46
    const c = []
    for (let h = 1; h <= H; h++) c[h] = (2 / (h * Math.PI)) * Math.sin(Math.PI * h * w)
    return { s: [], c }
  })
  const vowels = [[800, 1150], [400, 1600], [270, 2300], [450, 800], [325, 700]]
  tableData.vowel = additive((t) => {
    const x = t * (vowels.length - 1)
    const i = Math.min(vowels.length - 2, Math.floor(x))
    const k = x - i
    const F1 = vowels[i][0] * (1 - k) + vowels[i + 1][0] * k
    const F2 = vowels[i][1] * (1 - k) + vowels[i + 1][1] * k
    const s = []
    for (let h = 1; h <= H; h++) {
      const f = h * 110
      s[h] = Math.exp(-(((f - F1) / 140) ** 2)) + 0.6 * Math.exp(-(((f - F2) / 220) ** 2)) + 0.08 / h
    }
    return { s }
  })
  tableData.sync = timeDomain((t, p) => {
    const ratio = 1 + t * 5
    const fade = Math.sin(Math.PI * p) // soften the reset click
    return (2 * ((p * ratio) % 1) - 1) * (0.35 + 0.65 * fade)
  })
  tableData.fold = timeDomain((t, p) => Math.sin((1 + t * 5) * (Math.PI / 2) * Math.sin(2 * Math.PI * p)))

  for (const [name, frames] of Object.entries(tableData)) {
    for (const frame of frames) { // each frame peaks just under full scale
      let peak = 0
      for (let i = 0; i < FRAME; i++) peak = Math.max(peak, Math.abs(frame[i]))
      if (peak > 0) for (let i = 0; i < FRAME; i++) frame[i] *= 0.95 / peak
    }
    const url = URL.createObjectURL(new Blob([wav(frames)], { type: 'audio/wav' }))
    registerWaveTable(tableKey(name), [url], { frameLen: FRAME })
  }
  return tableData
}

/** A mono 16-bit wav of frames back to back, the layout Strudel's wavetable synth reads. */
function wav(frames) {
  const length = frames.length * FRAME
  const buf = new ArrayBuffer(44 + length * 2)
  const dv = new DataView(buf)
  const text = (at, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); dv.setUint32(4, 36 + length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 44100, true); dv.setUint32(28, 88200, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  text(36, 'data'); dv.setUint32(40, length * 2, true)
  let o = 44
  for (const frame of frames) for (let i = 0; i < FRAME; i++, o += 2) dv.setInt16(o, Math.round(clamp(frame[i], -1, 1) * 32767), true)
  return buf
}

/** One frame of a table at a position 0..1, for drawing. */
export function tableFrame(name, pos) {
  const data = ensureTables()[name] ?? ensureTables().basic
  return data[Math.round(clamp(pos, 0, 1) * (data.length - 1))]
}

// ── patches ──────────────────────────────────────────────────────────────────

export function makeLayer(type = 'analog', over = {}) {
  return {
    id: newPartId(), type, on: true, level: 0.8, pan: 0.5, oct: 0, semi: 0, fine: 0,
    wave: 'sawtooth', pw: 0.5, table: 'basic', pos: 0, warp: 0, warpmode: 'none',
    unison: type === 'supersaw' ? 5 : 1, detune: type === 'supersaw' ? 0.18 : 0.1, spread: 0.6,
    fm: 0, ratio: 1, fmwave: 'sine', color: 'pink',
    ...over,
  }
}

export function initPatch() {
  return {
    v: 1,
    name: 'init',
    layers: [makeLayer('analog')],
    filter: { on: false, type: 'lowpass', slope: '24db', cutoff: 2400, reso: 1, drive: 0 },
    amp: { attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.2 },
    env: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.3 },
    lfos: [{ shape: 'sine', sync: true, bars: 1 / 4, hz: 2 }, { shape: 'tri', sync: true, bars: 1, hz: 0.5 }],
    mods: [],
    volume: 0.8,
  }
}

/** Anything → a valid patch (saved projects, presets, hand-edited JSON). */
export function normalizePatch(raw) {
  const base = initPatch()
  if (!raw || typeof raw !== 'object') return base
  const layers = (Array.isArray(raw.layers) ? raw.layers : [])
    .filter((l) => l && LAYER_TYPES[l.type])
    .slice(0, MAX_LAYERS)
    .map((l) => {
      const d = makeLayer(l.type)
      return {
        id: typeof l.id === 'string' && l.id ? l.id.replace(/\W/g, '').slice(0, 12) || d.id : d.id,
        type: l.type,
        on: l.on !== false,
        level: num(l.level, d.level, 0, 1),
        pan: num(l.pan, d.pan, 0, 1),
        oct: Math.round(num(l.oct, 0, -3, 3)),
        semi: Math.round(num(l.semi, 0, -12, 12)),
        fine: num(l.fine, 0, -100, 100),
        wave: pick(l.wave, WAVES, d.wave),
        pw: num(l.pw, d.pw, K.pw.min, K.pw.max),
        table: pick(l.table, Object.keys(TABLES), d.table),
        pos: num(l.pos, 0, 0, 1),
        warp: num(l.warp, 0, 0, 1),
        warpmode: pick(l.warpmode, WARP_MODES, 'none'),
        unison: Math.round(num(l.unison, d.unison, 1, 16)),
        detune: num(l.detune, d.detune, 0, 1),
        spread: num(l.spread, d.spread, 0, 1),
        fm: num(l.fm, 0, K.fm.min, K.fm.max),
        ratio: num(l.ratio, 1, K.ratio.min, K.ratio.max),
        fmwave: pick(l.fmwave, FM_WAVES, 'sine'),
        color: pick(l.color, NOISES, 'pink'),
      }
    })
  const seen = new Set()
  for (const l of layers) { while (seen.has(l.id)) l.id = newPartId(); seen.add(l.id) }
  const f = raw.filter ?? {}
  const env = (e, d) => ({
    attack: num(e?.attack, d.attack, K.attack.min, K.attack.max),
    decay: num(e?.decay, d.decay, K.decay.min, K.decay.max),
    sustain: num(e?.sustain, d.sustain, 0, 1),
    release: num(e?.release, d.release, K.release.min, K.release.max),
  })
  const patch = {
    v: 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 40) : base.name,
    layers: layers.length ? layers : base.layers,
    filter: {
      on: f.on === true,
      type: pick(f.type, FILTER_TYPES, 'lowpass'),
      slope: pick(f.slope, FILTER_SLOPES, '24db'),
      cutoff: num(f.cutoff, K.cutoff.def, K.cutoff.min, K.cutoff.max),
      reso: num(f.reso, K.reso.def, K.reso.min, K.reso.max),
      drive: num(f.drive, 0, 0, 1),
    },
    amp: env(raw.amp, base.amp),
    env: env(raw.env, base.env),
    lfos: [0, 1].map((i) => {
      const l = raw.lfos?.[i] ?? {}
      const d = base.lfos[i]
      return {
        shape: pick(l.shape, LFO_SHAPES, d.shape),
        sync: l.sync !== false,
        bars: LFO_BARS.includes(l.bars) ? l.bars : d.bars,
        hz: num(l.hz, d.hz, K.hz.min, K.hz.max),
      }
    }),
    mods: [],
    volume: num(raw.volume, K.volume.def, K.volume.min, K.volume.max),
  }
  const routes = new Set()
  for (const m of Array.isArray(raw.mods) ? raw.mods : []) {
    if (!m || !SOURCES.includes(m.src) || !targetSpec(patch, m.target)) continue
    const key = `${m.src}>${m.target}`
    if (routes.has(key) || routes.size >= 24) continue
    routes.add(key)
    patch.mods.push({ id: typeof m.id === 'string' ? m.id.replace(/\W/g, '').slice(0, 12) || newPartId() : newPartId(), src: m.src, target: m.target, amt: num(m.amt, 0.5, -1, 1) })
  }
  return patch
}

// ── modulation targets ───────────────────────────────────────────────────────

/**
 * Targets are strings: "filter.cutoff", "amp.level", "pitch", "volume", or
 * "layer:<id>.<knob>". Returns the knob spec plus where its value lives, or null.
 */
export function targetSpec(patch, target) {
  if (typeof target !== 'string') return null
  if (target === 'pitch') return { label: 'pitch', spec: { min: -24, max: 24 } }
  if (target === 'amp.level') return { label: 'amp', spec: { min: 0, max: 1 } }
  if (target === 'volume') return { label: 'volume', spec: K.volume, get: (p) => p.volume }
  const f = /^filter\.(cutoff|reso|drive)$/.exec(target)
  if (f) return { label: `filter ${f[1]}`, spec: K[f[1]], get: (p) => p.filter[f[1]] }
  const l = /^layer:(\w+)\.(level|pan|fine|pw|pos|warp|detune|spread|fm)$/.exec(target)
  if (l) {
    const index = patch.layers.findIndex((x) => x.id === l[1])
    if (index < 0) return null
    return { label: `layer ${index + 1} ${K[l[2]].label}`, spec: K[l[2]], layerId: l[1], knob: l[2], get: (p) => p.layers.find((x) => x.id === l[1])?.[l[2]] }
  }
  return null
}

const SHAPE_SIGNAL = { sine: 'sine', tri: 'tri', saw: 'saw', ramp: 'isaw', square: 'square' }
const lfoHz = (lfo, cps) => (lfo.sync ? cps / lfo.bars : lfo.hz)

/**
 * The whole patch as Strudel controls: `layers` is one list of [control, value] per
 * layer, `shared` applies to all of them, and `status` says how each route is heard.
 * A value is a number/string, or { signal } for per-note modulation.
 */
export function compileVoice(patch, { cps = 0.5 } = {}) {
  const status = {}
  const claimed = new Set() // native slots already used by an earlier route
  const perNote = new Map() // target → [{ lfo, amt }]
  const nativeLayer = new Map() // layer id → [[control, value]]
  const shared = []
  const push = (list, ...pairs) => list.push(...pairs)
  const fprefix = { lowpass: 'lp', highpass: 'hp', bandpass: 'bp' }[patch.filter.type]
  const active = new Set(patch.layers.filter((l) => l.on).map((l) => l.id))

  for (const m of patch.mods) {
    const t = targetSpec(patch, m.target)
    const lfoIndex = m.src === 'env' ? -1 : Number(m.src.slice(3)) - 1
    const lfo = patch.lfos[lfoIndex]
    const layer = t?.layerId && patch.layers.find((x) => x.id === t.layerId)
    const filterOff = m.target.startsWith('filter.') && !patch.filter.on
    if (!t || filterOff || (layer && !active.has(layer.id)) || Math.abs(m.amt) < 0.001) { status[m.id] = 'off'; continue }
    const claim = (slot) => (claimed.has(slot) ? false : (claimed.add(slot), true))
    const envPairs = (p) => [[`${p}attack`, patch.env.attack], [`${p}decay`, patch.env.decay], [`${p}sustain`, patch.env.sustain], [`${p}release`, patch.env.release]]
    const layerList = (id) => { if (!nativeLayer.has(id)) nativeLayer.set(id, []); return nativeLayer.get(id) }

    if (m.src === 'env') {
      if (m.target === 'filter.cutoff' && patch.filter.on && claim('fenv')) {
        push(shared, [`${fprefix}env`, Math.round(m.amt * 6 * 100) / 100], ...envPairs(fprefix))
        status[m.id] = 'native'
      } else if (m.target === 'pitch' && claim('penv')) {
        push(shared, ['penv', Math.round(m.amt * 24 * 10) / 10], ['pattack', patch.env.attack], ['pdecay', patch.env.decay], ['psustain', patch.env.sustain], ['prelease', patch.env.release])
        status[m.id] = 'native'
      } else if (layer && t.knob === 'fm' && layer.fm > 0 && layer.type !== 'noise') {
        push(layerList(layer.id), ['fmenv', 'lin'], ['fmattack', patch.env.attack], ['fmdecay', patch.env.decay], ['fmsustain', patch.env.sustain], ['fmrelease', patch.env.release])
        status[m.id] = 'native'
      } else if (layer && layer.type === 'wavetable' && (t.knob === 'pos' || t.knob === 'warp')) {
        const p = t.knob === 'pos' ? 'wt' : 'warp'
        push(layerList(layer.id), [`${p}env`, Math.round(m.amt * 100) / 100], ...envPairs(p))
        status[m.id] = 'native'
      } else status[m.id] = 'off'
      continue
    }

    // LFOs
    const hz = lfoHz(lfo, cps)
    const rate = (p) => (lfo.sync ? [`${p}sync`, Math.round((1 / lfo.bars) * 1000) / 1000] : [`${p}rate`, lfo.hz])
    if (m.target === 'filter.cutoff' && patch.filter.on && claim('flfo')) {
      push(shared, rate(fprefix), [`${fprefix}depth`, Math.round(Math.abs(m.amt) * 200) / 100], [`${fprefix}shape`, lfo.shape])
      status[m.id] = 'native'
    } else if (m.target === 'pitch' && claim('vib')) {
      push(shared, ['vib', Math.round(hz * 1000) / 1000], ['vibmod', Math.round(Math.abs(m.amt) * 12 * 100) / 100])
      status[m.id] = lfo.shape === 'sine' ? 'native' : 'native (sine)'
    } else if (m.target === 'amp.level' && claim('trem')) {
      push(shared, lfo.sync ? ['tremolosync', Math.round((1 / lfo.bars) * 1000) / 1000] : ['tremolo', lfo.hz], ['tremolodepth', Math.round(Math.abs(m.amt) * 100) / 100], ['tremoloshape', lfo.shape])
      status[m.id] = 'native'
    } else if (layer && layer.type === 'wavetable' && (t.knob === 'pos' || t.knob === 'warp') && claim(`${layer.id}.${t.knob}lfo`)) {
      const p = t.knob === 'pos' ? 'wt' : 'warp'
      push(layerList(layer.id), rate(p), [`${p}depth`, Math.round(Math.abs(m.amt) * 100) / 100], [`${p}shape`, lfo.shape])
      status[m.id] = 'native'
    } else if (m.target === 'amp.level' || m.target === 'pitch') {
      status[m.id] = 'off' // the second lfo on these has nowhere to go
    } else {
      if (!perNote.has(m.target)) perNote.set(m.target, [])
      perNote.get(m.target).push({ lfo, amt: m.amt })
      status[m.id] = 'per note'
    }
  }

  // a knob's value, or a signal swinging around it for per-note routes
  const value = (target, base, spec) => {
    const routes = perNote.get(target)
    if (!routes?.length) return base
    const { lfo, amt } = routes[0] // one signal per knob; the matrix shows the rest as per note too
    const swing = (Math.abs(amt) * (spec.max - spec.min)) / 2
    const lo = clamp(base - swing, spec.min, spec.max)
    const hi = clamp(base + swing, spec.min, spec.max)
    return { signal: SHAPE_SIGNAL[lfo.shape], invert: amt < 0, bars: lfo.sync ? lfo.bars : null, cycles: lfo.sync ? null : lfo.hz / cps, lo, hi, base }
  }

  const layers = []
  for (const l of patch.layers) {
    if (!l.on) continue
    const pairs = []
    const tgt = (knob) => `layer:${l.id}.${knob}`
    if (l.type === 'analog') pairs.push(['s', l.wave])
    if (l.type === 'supersaw') pairs.push(['s', 'supersaw'])
    if (l.type === 'wavetable') pairs.push(['s', tableKey(l.table)])
    if (l.type === 'noise') pairs.push(['s', l.color])
    const pitch = l.oct + l.semi / 12
    const fine = value(tgt('fine'), l.fine, K.fine)
    if (typeof fine === 'object') pairs.push(['octave', { ...fine, lo: pitch + fine.lo / 1200, hi: pitch + fine.hi / 1200, base: pitch + fine.base / 1200 }])
    else if (pitch || fine) pairs.push(['octave', Math.round((pitch + fine / 1200) * 10000) / 10000])
    if (l.type === 'analog' && l.wave === 'pulse') pairs.push(['pw', value(tgt('pw'), l.pw, K.pw)])
    if (l.type === 'wavetable') {
      pairs.push(['wt', value(tgt('pos'), l.pos, K.pos)])
      const warp = value(tgt('warp'), l.warp, K.warp)
      if (l.warpmode !== 'none' || typeof warp === 'object' || l.warp > 0) pairs.push(['warp', warp], ['warpmode', l.warpmode])
    }
    if (l.type === 'supersaw' || (l.type === 'wavetable' && l.unison > 1)) {
      pairs.push(['unison', l.unison], ['detune', value(tgt('detune'), l.detune, K.detune)], ['spread', value(tgt('spread'), l.spread, K.spread)])
    }
    const fm = value(tgt('fm'), l.fm, K.fm)
    if (l.type !== 'noise' && (typeof fm === 'object' || l.fm > 0)) pairs.push(['fmi', fm], ['fmh', l.ratio], ['fmwave', l.fmwave])
    pairs.push(...(nativeLayer.get(l.id) ?? []))
    const pan = value(tgt('pan'), l.pan, K.pan)
    if (typeof pan === 'object' || Math.abs(l.pan - 0.5) > 0.001) pairs.push(['pan', pan])
    pairs.push(['gain', value(tgt('level'), l.level, K.level)])
    layers.push({ layer: l, pairs })
  }

  if (patch.filter.on) {
    const f = patch.filter
    const p = fprefix
    shared.unshift([`${p}f`, value('filter.cutoff', f.cutoff, K.cutoff)], [`${p}q`, value('filter.reso', f.reso, K.reso)])
    if (f.slope !== '12db') shared.unshift(['ftype', f.slope])
    const drive = value('filter.drive', f.drive, K.drive)
    if (f.slope === 'ladder') shared.push(['drive', typeof drive === 'object' ? drive : Math.round(f.drive * 5 * 100) / 100])
    else if (typeof drive === 'object' || f.drive > 0) shared.push(['shape', typeof drive === 'object' ? { ...drive, lo: drive.lo * 0.7, hi: drive.hi * 0.7, base: drive.base * 0.7 } : Math.round(f.drive * 0.7 * 1000) / 1000])
  }
  const a = patch.amp
  shared.push(['attack', a.attack], ['decay', a.decay], ['sustain', a.sustain], ['release', a.release])
  shared.push(['gain', value('volume', patch.volume, K.volume)])
  return { layers, shared, status }
}

// ── code ─────────────────────────────────────────────────────────────────────

const valueCode = (v) => {
  if (typeof v === 'string') return `'${v.replace(/[^\w.-]/g, '')}'`
  if (typeof v === 'number') return tidy(v)
  let sig = v.signal
  if (v.bars) sig += v.bars === 1 ? '' : v.bars > 1 ? `.slow(${tidy(v.bars)})` : `.fast(${tidy(1 / v.bars)})`
  else if (v.cycles) sig += `.fast(${tidy(v.cycles)})`
  return `${sig}.range(${tidy(v.invert ? v.hi : v.lo)}, ${tidy(v.invert ? v.lo : v.hi)})`
}
const chain = (pairs) => pairs.map(([k, v]) => (k === 'gain' ? `.mul(gain(${valueCode(v)}))` : `.${k}(${valueCode(v)})`)).join('')

/** Strudel for a patch playing the notes in `input` (an expression). */
export function phylloCode(patch, input, { cps } = {}) {
  const { layers, shared } = compileVoice(patch, { cps })
  if (layers.some(({ layer }) => layer.type === 'wavetable')) ensureTables()
  if (!layers.length) return null
  const body = layers.length === 1
    ? `${input}${chain(layers[0].pairs)}`
    : `${input}.layer(\n${layers.map(({ pairs }) => `  p => p${chain(pairs)},`).join('\n')}\n)`
  return `${body}${chain(shared)}`
}

/** Superdough values for one note of the patch, one per layer (per-note signals at rest). */
export function previewValues(patch, midi, { cps = 0.5 } = {}) {
  const { layers, shared } = compileVoice(patch, { cps })
  if (layers.some(({ layer }) => layer.type === 'wavetable')) ensureTables()
  const KEY = { lpf: 'cutoff', lpq: 'resonance', hpf: 'hcutoff', hpq: 'hresonance', bpf: 'bandf', bpq: 'bandq' }
  return layers.map(({ pairs }) => {
    const v = { note: midi }
    for (const [k, raw] of [...pairs, ...shared]) {
      const x = typeof raw === 'object' ? raw.base : raw
      if (k === 'gain') v.gain = (v.gain ?? 1) * x
      else v[KEY[k] ?? k] = x
    }
    return v
  })
}

/** Voices per note: each layer is one voice in Strudel's polyphony (128 at most). */
export const voiceCount = (patch) => patch.layers.filter((l) => l.on).length

// ── presets ──────────────────────────────────────────────────────────────────

const preset = (name, build) => {
  const p = initPatch()
  p.name = name
  build(p)
  return normalizePatch(p)
}

export const PRESETS = [
  preset('init', () => {}),
  preset('sub bass', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sine', oct: -1 }), makeLayer('analog', { wave: 'triangle', level: 0.35 })]
    p.filter = { ...p.filter, on: true, cutoff: 900, reso: 0.5 }
    p.amp = { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.08 }
  }),
  preset('reese', (p) => {
    p.layers = [makeLayer('supersaw', { unison: 7, detune: 0.32, spread: 0.3, level: 0.7 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.6 })]
    p.filter = { ...p.filter, on: true, slope: 'ladder', cutoff: 520, reso: 3, drive: 0.35 }
    p.amp = { attack: 0.01, decay: 0.3, sustain: 1, release: 0.15 }
    p.lfos[0] = { shape: 'sine', sync: true, bars: 1 / 2, hz: 2 }
    p.mods = [{ src: 'lfo1', target: 'filter.cutoff', amt: 0.4 }]
  }),
  preset('pluck', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sawtooth' }), makeLayer('analog', { wave: 'square', oct: 1, level: 0.3 })]
    p.filter = { ...p.filter, on: true, cutoff: 300, reso: 4 }
    p.amp = { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 }
    p.env = { attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 }
    p.mods = [{ src: 'env', target: 'filter.cutoff', amt: 0.75 }]
  }),
  preset('hoover lead', (p) => {
    p.layers = [makeLayer('supersaw', { unison: 9, detune: 0.45, spread: 0.8 }), makeLayer('analog', { wave: 'pulse', pw: 0.25, oct: -1, level: 0.5 })]
    p.filter = { ...p.filter, on: true, cutoff: 3200, reso: 2 }
    p.env = { attack: 0.08, decay: 0.3, sustain: 0, release: 0.1 }
    p.mods = [{ src: 'env', target: 'pitch', amt: -0.1 }, { src: 'lfo1', target: 'pitch', amt: 0.02 }]
    p.lfos[0] = { shape: 'sine', sync: false, bars: 1, hz: 5.5 }
  }),
  preset('glass pad', (p) => {
    p.layers = [makeLayer('wavetable', { table: 'bright', pos: 0.3, unison: 4, detune: 0.12 }), makeLayer('wavetable', { table: 'vowel', pos: 0.2, oct: 1, level: 0.4 })]
    p.filter = { ...p.filter, on: true, cutoff: 4200, reso: 1 }
    p.amp = { attack: 0.6, decay: 1, sustain: 0.8, release: 1.8 }
    p.lfos[0] = { shape: 'tri', sync: true, bars: 4, hz: 0.3 }
    p.lfos[1] = { shape: 'sine', sync: true, bars: 2, hz: 0.5 }
    p.volume = 0.6
  }),
  preset('fm bell', (p) => {
    p.layers = [makeLayer('analog', { wave: 'sine', fm: 3, ratio: 3.5 })]
    p.amp = { attack: 0.002, decay: 1.4, sustain: 0, release: 1.2 }
    p.env = { attack: 0.001, decay: 0.9, sustain: 0, release: 0.6 }
  }),
  preset('talking wobble', (p) => {
    p.layers = [makeLayer('wavetable', { table: 'vowel', pos: 0.5 }), makeLayer('analog', { wave: 'sine', oct: -1, level: 0.5 })]
    p.filter = { ...p.filter, on: true, slope: '24db', cutoff: 1400, reso: 5 }
    p.lfos[0] = { shape: 'sine', sync: true, bars: 1 / 8, hz: 4 }
  }),
]

// routes that point at a layer need that layer's id, so they're added once the layers exist
const LAYER_ROUTES = {
  'glass pad': [['lfo1', 0, 'pos', 0.5], ['lfo2', 1, 'pan', 0.6]],
  'fm bell': [['env', 0, 'fm', 1]],
  'talking wobble': [['lfo1', 0, 'pos', 0.9]],
}
for (const p of PRESETS) {
  for (const [src, index, knob, amt] of LAYER_ROUTES[p.name] ?? []) p.mods.push({ id: newPartId(), src, target: `layer:${p.layers[index].id}.${knob}`, amt })
}
