/**
 * The node graph a project is made of. Every node turns into one line of Strudel:
 *
 *   sources      pattern, sound, notes, code          → a pattern out
 *   transforms   fast, slow, every, euclid, …         → one pattern in, one out
 *   effects      filter, space, level, drive          → one pattern in, one out
 *   eq & dynamics  eq, saturator, clipper, compressor  → one pattern in, one out
 *   combine      stack, sequence, arrange             → many in, one out
 *   output       each wire into it is a lane you hear (with mute / solo)
 *
 * Wires go from a node's right edge (out) to a node's left edge (in). Multi-input nodes
 * grow a new input slot as you connect them; slot order is the order in the code.
 */

import { normalizePatch, phylloCode } from './phyllo/engine'

const clampNum = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const tidy = (v) => String(Math.round(Number(v) * 1000) / 1000)
// text that lands inside a double-quoted mini-notation string
const miniText = (s) => String(s ?? '').replace(/["\\\n\r`]/g, ' ').slice(0, 400).trim() || '~'
const soundName = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '') || 'bd'

/** Functions a transform like "every" or "sometimes" can apply. */
export const APPLY = {
  rev: { label: 'reverse', code: 'x => x.rev()' },
  fast2: { label: 'double speed', code: 'x => x.fast(2)' },
  slow2: { label: 'half speed', code: 'x => x.slow(2)' },
  ply2: { label: 'repeat each', code: 'x => x.ply(2)' },
  up12: { label: 'octave up', code: 'x => x.transpose(12)' },
  crush: { label: 'bitcrush', code: 'x => x.crush(4)' },
  silence: { label: 'drop out', code: 'x => x.degradeBy(1)' },
}

/**
 * Node types. `params` drive the controls on the node (knob = continuous, int = stepper,
 * select, text, mini = mini-notation text) and `code(data, inputs)` builds the expression.
 */
export const NODE_TYPES = {
  pattern: {
    group: 'source', label: 'pattern', blurb: 'Steps and notes you draw in the rack',
    inputs: 0,
    params: [],
    code: (d, _in, ctx) => (ctx.patternIds.has(d.patternId) ? `p_${d.patternId}` : null),
  },
  sound: {
    group: 'source', label: 'rhythm', blurb: 'A sound played in a mini-notation rhythm',
    inputs: 0,
    params: [
      { key: 'mini', type: 'mini', label: 'rhythm', def: 'hh*8' },
      { key: 'bank', type: 'kit', label: 'kit', def: 'RolandTR909' },
    ],
    code: (d) => `s("${miniText(d.mini)}")${d.bank ? `.bank("${String(d.bank).replace(/\W/g, '')}")` : ''}`,
  },
  notes: {
    group: 'source', label: 'melody', blurb: 'Notes in mini-notation on a synth',
    inputs: 0,
    params: [
      { key: 'mini', type: 'mini', label: 'notes', def: '<c3 eb3 g3 bb3>' },
      { key: 'sound', type: 'sound', label: 'sound', def: 'sawtooth' },
    ],
    code: (d) => `note("${miniText(d.mini)}").s("${soundName(d.sound)}")`,
  },
  phyllo: {
    group: 'source', label: 'phyllo', blurb: 'A layered synth: analog, supersaw and wavetable layers, filter, envelopes, lfos',
    // notes come from a wire (a pattern, a melody) or, with nothing wired, from its own notes
    inputs: ['notes'],
    params: [{ key: 'mini', type: 'mini', label: 'notes (with nothing wired)', def: '<[c3,eb3,g3] [ab2,c3,eb3] [f2,ab2,c3] [g2,bb2,d3]>' }],
    code: (d, xs, ctx) => {
      const notes = xs[ctx.slots.indexOf('in-0')] ?? `note("${miniText(d.mini)}")`
      const voice = phylloCode(normalizePatch(d.patch), notes, { cps: ctx.cps })
      return voice && NODE_TYPES.fxrack.code(d, [voice], ctx)
    },
  },
  code: {
    group: 'source', label: 'code', blurb: 'Any Strudel pattern, written out',
    inputs: 0,
    params: [{ key: 'code', type: 'code', label: 'code', def: 's("bd sd")' }],
    code: (d) => (String(d.code ?? '').trim() ? `(${String(d.code).trim()})` : null),
  },

  fast: {
    group: 'transform', label: 'speed', blurb: 'Play faster or slower',
    inputs: 1,
    params: [{ key: 'amount', type: 'knob', label: 'times', min: 0.25, max: 8, def: 2, log: true, unit: 'x' }],
    code: (d, [x]) => `${x}.fast(${tidy(d.amount)})`,
  },
  every: {
    group: 'transform', label: 'every', blurb: 'Change it every few cycles',
    inputs: 1,
    params: [
      { key: 'n', type: 'int', label: 'every', min: 2, max: 16, def: 4 },
      { key: 'fn', type: 'select', label: 'do', options: Object.keys(APPLY), def: 'rev' },
    ],
    code: (d, [x]) => `${x}.lastOf(${d.n}, ${APPLY[d.fn]?.code ?? APPLY.rev.code})`,
  },
  sometimes: {
    group: 'transform', label: 'sometimes', blurb: 'Change random events',
    inputs: 1,
    params: [
      { key: 'chance', type: 'knob', label: 'chance', min: 0, max: 1, def: 0.3 },
      { key: 'fn', type: 'select', label: 'do', options: Object.keys(APPLY), def: 'up12' },
    ],
    code: (d, [x]) => `${x}.sometimesBy(${tidy(d.chance)}, ${APPLY[d.fn]?.code ?? APPLY.up12.code})`,
  },
  euclid: {
    group: 'transform', label: 'euclid', blurb: 'Spread hits evenly',
    inputs: 1,
    params: [
      { key: 'pulses', type: 'int', label: 'hits', min: 1, max: 16, def: 3 },
      { key: 'steps', type: 'int', label: 'steps', min: 2, max: 32, def: 8 },
      { key: 'rotate', type: 'int', label: 'shift', min: 0, max: 31, def: 0 },
    ],
    code: (d, [x]) => `${x}.euclidRot(${Math.min(d.pulses, d.steps)}, ${d.steps}, ${d.rotate % d.steps})`,
  },
  thin: {
    group: 'transform', label: 'thin out', blurb: 'Randomly drop events',
    inputs: 1,
    params: [{ key: 'amount', type: 'knob', label: 'drop', min: 0, max: 1, def: 0.3 }],
    code: (d, [x]) => `${x}.degradeBy(${tidy(d.amount)})`,
  },
  echo: {
    group: 'transform', label: 'echo', blurb: 'Repeat each event, fading',
    inputs: 1,
    params: [
      { key: 'times', type: 'int', label: 'times', min: 2, max: 8, def: 3 },
      { key: 'time', type: 'knob', label: 'gap', min: 0.02, max: 0.5, def: 0.125, unit: 'c' },
      { key: 'feedback', type: 'knob', label: 'fade', min: 0.1, max: 0.95, def: 0.6 },
    ],
    code: (d, [x]) => `${x}.echo(${d.times}, ${tidy(d.time)}, ${tidy(d.feedback)})`,
  },
  shape: {
    group: 'transform', label: 'shuffle', blurb: 'Reverse, spread in stereo, repeat, swing',
    inputs: 1,
    params: [{ key: 'mode', type: 'select', label: 'how', options: ['rev', 'jux', 'ply', 'palindrome', 'iter', 'swing'], def: 'jux' }],
    code: (d, [x]) => ({
      rev: `${x}.rev()`, jux: `${x}.jux(rev)`, ply: `${x}.ply(2)`, palindrome: `${x}.palindrome()`, iter: `${x}.iter(4)`, swing: `${x}.swingBy(1/3, 4)`,
    })[d.mode] ?? `${x}.jux(rev)`,
  },
  transpose: {
    group: 'transform', label: 'transpose', blurb: 'Move notes up or down',
    inputs: 1,
    params: [{ key: 'semitones', type: 'int', label: 'semitones', min: -24, max: 24, def: 7 }],
    code: (d, [x]) => `${x}.transpose(${d.semitones})`,
  },

  filter: {
    group: 'effect', label: 'filter', blurb: 'Cut highs or lows',
    inputs: 1,
    params: [
      { key: 'lpf', type: 'knob', label: 'cutoff', min: 60, max: 20000, def: 2000, log: true, unit: 'hz' },
      { key: 'lpq', type: 'knob', label: 'reso', min: 0, max: 25, def: 4 },
      { key: 'hpf', type: 'knob', label: 'low cut', min: 20, max: 8000, def: 20, log: true, unit: 'hz' },
    ],
    code: (d, [x], ctx) => {
      if (!ctx?.eqAbove) return `${x}.lpf(${Math.round(d.lpf)}).lpq(${tidy(d.lpq)})${d.hpf > 20 ? `.hpf(${Math.round(d.hpf)})` : ''}`
      // after an eq, tighten each band's filters instead of replacing them (the last .lpf wins in Strudel)
      const hp = d.hpf > 20 ? `, ...(v.hcutoff >= ${Math.round(d.hpf)} ? {} : { hcutoff: ${Math.round(d.hpf)} })` : ''
      return `${x}.fmap(v => ({ ...v, ...(v.cutoff <= ${Math.round(d.lpf)} ? {} : { cutoff: ${Math.round(d.lpf)}, resonance: ${tidy(d.lpq)} })${hp} }))`
    },
  },
  space: {
    group: 'effect', label: 'space', blurb: 'Reverb and delay',
    inputs: 1,
    params: [
      { key: 'room', type: 'knob', label: 'reverb', min: 0, max: 1, def: 0.4 },
      { key: 'delay', type: 'knob', label: 'delay', min: 0, max: 0.9, def: 0.25 },
      { key: 'delaytime', type: 'knob', label: 'time', min: 0.05, max: 0.75, def: 0.1875, unit: 'c' },
    ],
    code: (d, [x]) => `${x}.room(${tidy(d.room)}).delay(${tidy(d.delay)}).delaytime(${tidy(d.delaytime)}).delayfeedback(.4)`,
  },
  level: {
    group: 'effect', label: 'level', blurb: 'Volume and pan',
    inputs: 1,
    params: [
      { key: 'gain', type: 'knob', label: 'vol', min: 0, max: 1.5, def: 0.8 },
      { key: 'pan', type: 'knob', label: 'pan', min: 0, max: 1, def: 0.5 },
    ],
    code: (d, [x]) => `${x}.gain(${tidy(d.gain)})${d.pan !== 0.5 ? `.pan(${tidy(d.pan)})` : ''}`,
  },
  drive: {
    group: 'effect', label: 'drive', blurb: 'Distortion and bitcrush',
    inputs: 1,
    params: [
      { key: 'shape', type: 'knob', label: 'drive', min: 0, max: 0.9, def: 0.4 },
      { key: 'crush', type: 'knob', label: 'crush', min: 0, max: 1, def: 0 },
    ],
    code: (d, [x]) => `${x}.shape(${tidy(d.shape)})${d.crush > 0 ? `.crush(${Math.round(16 - d.crush * 14)})` : ''}`,
  },

  djfilter: {
    group: 'effect', label: 'dj filter', blurb: 'One knob: left darkens, right thins out',
    inputs: 1,
    params: [{ key: 'djf', type: 'knob', label: 'sweep', min: 0, max: 1, def: 0.5 }],
    code: (d, [x]) => `${x}.djf(${tidy(d.djf)})`,
  },
  phaser: {
    group: 'effect', label: 'phaser', blurb: 'A swirling, sweeping sound',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.1, max: 16, def: 2, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.6 },
    ],
    code: (d, [x]) => `${x}.phaser(${tidy(d.rate)}).phaserdepth(${tidy(d.depth)})`,
  },
  tremolo: {
    group: 'effect', label: 'tremolo', blurb: 'Volume that pulses',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.25, max: 32, def: 4, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.7 },
    ],
    code: (d, [x]) => `${x}.tremolo(${tidy(d.rate)}).tremolodepth(${tidy(d.depth)})`,
  },
  vowel: {
    group: 'effect', label: 'vowel', blurb: 'Makes it sound like it says a vowel',
    inputs: 1,
    params: [{ key: 'vowel', type: 'select', label: 'vowel', options: ['a', 'e', 'i', 'o', 'u'], def: 'a' }],
    code: (d, [x]) => `${x}.vowel("${['a', 'e', 'i', 'o', 'u'].includes(d.vowel) ? d.vowel : 'a'}")`,
  },
  lofi: {
    group: 'effect', label: 'lo-fi', blurb: 'Lower sample rate, grittier',
    inputs: 1,
    params: [{ key: 'coarse', type: 'int', label: 'grit', min: 1, max: 32, def: 6 }],
    code: (d, [x]) => `${x}.coarse(${d.coarse})`,
  },
  sidechain: {
    group: 'effect', label: 'sidechain', blurb: 'Duck the sound every time the trigger hits (kick pumps the bass)',
    // named inputs: slot 0 is ducked, slot 1 does the ducking
    inputs: ['sound', 'trigger'],
    params: [
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.85 },
      { key: 'attack', type: 'knob', label: 'attack', min: 0, max: 0.1, def: 0.005, unit: 's' },
      { key: 'release', type: 'knob', label: 'release', min: 0.02, max: 1, def: 0.25, unit: 's' },
      { key: 'hear', type: 'select', label: 'trigger', options: ['silent', 'audible'], def: 'silent' },
    ],
    // Strudel ducks an audio bus ("orbit"): the sound plays on its own bus, the trigger
    // ducks that bus. A silent trigger still ducks (postgain 0 only mutes its own sound).
    code: (d, xs, ctx) => {
      const sound = xs[ctx.slots.indexOf('in-0')]
      const trigger = xs[ctx.slots.indexOf('in-1')]
      if (!sound) return null
      if (!trigger) return sound
      const orbit = ctx.orbit
      return `stack(${sound}.orbit(${orbit}), ${trigger}.duckorbit(${orbit}).duckonset(${tidy(d.attack)}).duckattack(${tidy(d.release)}).duckdepth(${tidy(d.depth)})${d.hear === 'silent' ? '.postgain(0)' : ''})`
    },
  },
  eq3: {
    group: 'mixing', label: '3-band eq', blurb: 'Boost or cut lows, mids and highs',
    inputs: 1,
    params: [
      { key: 'low', type: 'knob', label: 'low', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'mid', type: 'knob', label: 'mid', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'high', type: 'knob', label: 'high', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'lowf', type: 'knob', label: 'low / mid', min: 40, max: 1000, def: 200, log: true, unit: 'hz' },
      { key: 'highf', type: 'knob', label: 'mid / high', min: 1000, max: 12000, def: 3000, log: true, unit: 'hz' },
    ],
    // Strudel has no shelving eq, so the sound is split into three bands with steep (24 dB,
    // Linkwitz-Riley) crossovers that add back up flat, and each band gets its own gain.
    // A band's filter never opens up a filter that's already on the sound. Fully down = off.
    code: (d, [x]) => {
      const bands = [[d.low, 0, d.lowf], [d.mid, d.lowf, d.highf], [d.high, d.highf, 0]]
      if (!eqActive(d)) return x
      const live = bands.filter(([db]) => db > -24)
      if (!live.length) return `${x}.gain(0)`
      const band = ([db, lo, hi]) => {
        const lp = hi ? `, ...(v.cutoff <= ${Math.round(hi)} ? {} : { cutoff: ${Math.round(hi)}, resonance: .71 })` : ''
        const hp = lo ? `, ...(v.hcutoff >= ${Math.round(lo)} ? {} : { hcutoff: ${Math.round(lo)}, hresonance: .71 })` : ''
        return `v => ({ ...v${lp}${hp}, ftype: '24db', gain: (v.gain ?? .8) * ${tidy(10 ** (db / 20))} })`
      }
      return `${x}.layer(${live.map((b) => `p => p.fmap(${band(b)})`).join(', ')})`
    },
  },
  saturator: {
    group: 'mixing', label: 'saturator', blurb: 'Warmth and grit: rounds off peaks and adds harmonics',
    inputs: 1,
    params: [
      { key: 'drive', type: 'knob', label: 'drive', min: 0, max: 4, def: 1.2 },
      { key: 'character', type: 'select', label: 'character', options: ['warm', 'tape', 'tube', 'asym', 'harmonics', 'fold'], def: 'tape' },
      { key: 'out', type: 'knob', label: 'output', min: 0.05, max: 1, def: 0.8 },
    ],
    code: (d, [x]) => `${x}.distort("${tidy(d.drive)}:${tidy(d.out)}:${SATURATION[d.character] ?? 'soft'}")`,
  },
  clipper: {
    group: 'mixing', label: 'clipper', blurb: 'Pushes the level into a hard ceiling for loud, punchy peaks',
    inputs: 1,
    params: [
      { key: 'push', type: 'knob', label: 'push', min: 0, max: 3, def: 0.6 },
      { key: 'ceiling', type: 'knob', label: 'ceiling', min: 0.1, max: 1, def: 0.9 },
    ],
    // Clipper and saturator share Strudel's one distortion stage: after a saturator, the
    // clipper adds its push to it and its ceiling caps the (already bounded) output.
    code: (d, [x]) => `${x}.fmap(v => v.distort === undefined ? { ...v, distort: ${tidy(d.push)}, distortvol: ${tidy(d.ceiling)}, distorttype: 'hard' } : { ...v, distort: v.distort + ${tidy(d.push)}, distortvol: (v.distortvol ?? 1) * ${tidy(d.ceiling)} })`,
  },
  compressor: {
    group: 'mixing', label: 'compressor', blurb: 'Evens out the level: loud parts get turned down',
    inputs: 1,
    params: [
      { key: 'threshold', type: 'knob', label: 'thresh', min: -60, max: 0, def: -18, unit: 'db' },
      { key: 'ratio', type: 'knob', label: 'ratio', min: 1, max: 20, def: 4, log: true, unit: 'ratio' },
      { key: 'attack', type: 'knob', label: 'attack', min: 0.001, max: 0.2, def: 0.01, log: true, unit: 's' },
      { key: 'release', type: 'knob', label: 'release', min: 0.02, max: 1, def: 0.15, log: true, unit: 's' },
      { key: 'knee', type: 'knob', label: 'knee', min: 0, max: 30, def: 6, unit: 'db' },
      { key: 'makeup', type: 'knob', label: 'makeup', min: 0, max: 18, def: 3, unit: 'db', origin: 0 },
    ],
    code: (d, [x]) => `${x}.compressor("${Math.round(d.threshold * 10) / 10}:${tidy(d.ratio)}:${tidy(d.knee)}:${tidy(d.attack)}:${tidy(d.release)}")${d.makeup > 0.05 ? `.mul(postgain(${tidy(10 ** (d.makeup / 20))}))` : ''}`,
  },
  punch: {
    group: 'mixing', label: 'transient', blurb: 'More or less snap at the start of each hit, and more or less tail',
    inputs: 1,
    params: [
      { key: 'attack', type: 'knob', label: 'snap', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 },
      { key: 'sustain', type: 'knob', label: 'tail', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
    ],
    code: (d, [x]) => `${x}.transient("${tidy(d.attack)}:${tidy(d.sustain)}")`,
  },

  fxrack: {
    group: 'effect', label: 'fx rack', blurb: 'Several effects in one box, applied top to bottom',
    inputs: 1,
    params: [],
    code: (d, [x], ctx) => {
      const chain = (d.chain ?? []).filter((u) => u.on && FX_UNITS.includes(u.type))
      let eqAbove = !!ctx?.eqAbove
      return chain.reduce((acc, u) => {
        const out = NODE_TYPES[u.type].code(u.data, [acc], { ...ctx, eqAbove })
        eqAbove ||= splitsBands(u)
        return out
      }, x)
    },
  },

  stack: {
    group: 'combine', label: 'stack', blurb: 'Play inputs together',
    inputs: 'many',
    params: [],
    code: (_d, xs) => (xs.length ? `stack(${xs.join(', ')})` : null),
  },
  sequence: {
    group: 'combine', label: 'sequence', blurb: 'One input per cycle, in turn',
    inputs: 'many',
    params: [],
    code: (_d, xs) => (xs.length ? `cat(${xs.join(', ')})` : null),
  },
  arrange: {
    group: 'combine', label: 'arrange', blurb: 'Inputs one after another, for so many bars each',
    inputs: 'many',
    params: [],
    slotParam: { key: 'bars', label: 'bars', min: 1, max: 64, def: 4 },
    code: (d, xs, ctx) => (xs.length ? `arrange(${xs.map((x, i) => `[${clampNum(d.bars?.[ctx.slots[i]], 4, 1, 64)}, ${x}]`).join(', ')})` : null),
  },

  output: {
    group: 'output', label: 'output', blurb: 'What you hear. Each wire in is a lane.',
    inputs: 'many',
    params: [],
    code: () => null, // handled by generateGraphCode
  },
}

/** Effects that can sit inside an fx rack: every plain effect node. */
export const FX_UNITS = ['eq3', 'compressor', 'saturator', 'clipper', 'punch', 'filter', 'djfilter', 'space', 'level', 'drive', 'phaser', 'tremolo', 'vowel', 'lofi']

/** Whether an eq node or unit changes anything (a flat eq isn't in the code at all). */
const eqActive = (d) => [d.low, d.mid, d.high].some((db) => Math.abs(db) >= 0.05)

/** Whether a node splits the sound into eq bands, so later filters must merge with them. */
const splitsBands = (node) => (node.type === 'eq3' && eqActive(node.data))
  || ((node.type === 'fxrack' || node.type === 'phyllo') && (node.data.chain ?? []).some((u) => u.on && u.type === 'eq3' && eqActive(u.data)))

/** Saturator characters → Strudel's waveshaping curves. */
const SATURATION = { warm: 'scurve', tape: 'soft', tube: 'diode', asym: 'asym', harmonics: 'chebyshev', fold: 'fold' }

/** Clean one node type's data against its params. */
function cleanData(type, raw) {
  const spec = NODE_TYPES[type]
  const data = { ...defaultData(type) }
  for (const p of spec.params) {
    const v = raw?.[p.key]
    if (v === undefined) continue
    if (p.type === 'knob' || p.type === 'int') data[p.key] = clampNum(v, p.def, p.min, p.max)
    if (p.type === 'int') data[p.key] = Math.round(data[p.key])
    if (p.type === 'select') data[p.key] = p.options.includes(v) ? v : p.def
    if (['text', 'mini', 'sound', 'code', 'kit'].includes(p.type)) data[p.key] = String(v).slice(0, p.type === 'code' ? 20000 : 400)
  }
  return data
}

/** A new effect unit for an fx rack. */
export function makeFxUnit(type, id) {
  return { id, type, on: true, data: defaultData(type) }
}

export const GROUPS = [
  ['source', 'sources'],
  ['transform', 'transform'],
  ['effect', 'effects'],
  ['mixing', 'eq & dynamics'],
  ['combine', 'combine'],
  ['output', 'output'],
]

export function defaultData(type) {
  const spec = NODE_TYPES[type]
  return Object.fromEntries((spec?.params ?? []).map((p) => [p.key, p.def]))
}

const slotIndex = (handle) => {
  const m = /^in-(\d+)$/.exec(String(handle ?? ''))
  return m ? Number(m[1]) : 0
}

/** Clean nodes and wires from a (possibly hand-edited) project header. */
export function normalizeGraph(raw, patternIds) {
  const nodes = []
  const ids = new Set()
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    const spec = NODE_TYPES[n?.type]
    if (!spec || typeof n.id !== 'string') continue
    const id = n.id.replace(/\W/g, '')
    if (!id || ids.has(id)) continue
    ids.add(id)
    const data = cleanData(n.type, n.data)
    if (n.type === 'phyllo') data.patch = normalizePatch(n.data?.patch)
    if (n.type === 'fxrack' || n.type === 'phyllo') {
      const seen = new Set()
      data.chain = (Array.isArray(n.data?.chain) ? n.data.chain : [])
        .filter((u) => u && FX_UNITS.includes(u.type) && typeof u.id === 'string' && !seen.has(u.id) && seen.add(u.id))
        .slice(0, 16)
        .map((u) => ({ id: u.id.replace(/\W/g, '').slice(0, 24) || 'fx', type: u.type, on: u.on !== false, data: cleanData(u.type, u.data) }))
    }
    if (n.type === 'pattern') data.patternId = patternIds.has(n.data?.patternId) ? n.data.patternId : [...patternIds][0] ?? null
    if (n.type === 'arrange') data.bars = Object.fromEntries(Object.entries(n.data?.bars ?? {}).filter(([k]) => /^in-\d+$/.test(k)).map(([k, v]) => [k, Math.round(clampNum(v, 4, 1, 64))]))
    if (n.type === 'output') {
      data.muted = Object.fromEntries(Object.entries(n.data?.muted ?? {}).filter(([, v]) => v === true))
      data.solo = typeof n.data?.solo === 'string' ? n.data.solo : null
    }
    if (typeof n.data?.name === 'string' && n.data.name.trim()) data.name = n.data.name.slice(0, 40)
    nodes.push({ id, type: n.type, x: Math.round(clampNum(n.x, 0, -20000, 20000)), y: Math.round(clampNum(n.y, 0, -20000, 20000)), data })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = []
  const taken = new Set()
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    const source = byId.get(String(e?.source))
    const target = byId.get(String(e?.target))
    if (!source || !target || source.id === target.id) continue
    const spec = NODE_TYPES[target.type]
    if (!spec.inputs) continue
    const handle = spec.inputs === 1 ? 'in' : `in-${slotIndex(e.targetHandle)}`
    if (Array.isArray(spec.inputs) && slotIndex(e.targetHandle) >= spec.inputs.length) continue
    const key = `${target.id}:${handle}`
    if (taken.has(key)) continue // one wire per input slot
    taken.add(key)
    edges.push({ id: `e_${source.id}_${target.id}_${handle.replace('-', '')}`, source: source.id, target: target.id, targetHandle: handle })
  }
  return { nodes, edges: dropCycles(nodes, edges) }
}

/** Would wiring source → target create a loop? */
export function makesCycle(edges, source, target) {
  const stack = [target]
  const seen = new Set()
  while (stack.length) {
    const id = stack.pop()
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of edges) if (e.source === id) stack.push(e.target)
  }
  return false
}

/** Keep wires in order, skipping any that would close a loop. Two routes from A to B is fine. */
function dropCycles(nodes, edges) {
  const kept = []
  for (const e of edges) if (!makesCycle(kept, e.source, e.target)) kept.push(e)
  return kept
}

/** Inputs of a node in slot order. */
export function inputsOf(edges, nodeId) {
  return edges.filter((e) => e.target === nodeId).sort((a, b) => slotIndex(a.targetHandle) - slotIndex(b.targetHandle))
}

export const nodeVar = (id) => `n_${id}`

/**
 * Code for the graph: one `const` per node that makes a pattern, in dependency order,
 * then one lane per wire into each output node. `solo` (a node id) plays only that node.
 */
export function graphCode(project, { solo = null } = {}) {
  const { nodes, edges } = project
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const patternIds = new Set(project.patterns.map((p) => p.id))
  const exprs = new Map() // id → variable name, or null when the node makes nothing
  const banded = new Set() // ids whose output has been split into eq bands somewhere upstream
  const lines = []
  // each sidechain gets its own audio bus; bus 1 is where everything else plays
  const sidechains = nodes.filter((n) => n.type === 'sidechain').map((n) => n.id)
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60

  const visit = (id, trail = new Set()) => {
    if (exprs.has(id)) return exprs.get(id)
    if (trail.has(id)) return null
    trail.add(id)
    const node = byId.get(id)
    const spec = node && NODE_TYPES[node.type]
    if (!spec || node.type === 'output') { exprs.set(id, null); return null }
    const wires = inputsOf(edges, id)
    const inputs = []
    const slots = []
    for (const w of wires) {
      const v = visit(w.source, trail)
      if (v) { inputs.push(v); slots.push(w.targetHandle) }
    }
    const eqAbove = wires.some((w) => banded.has(w.source))
    if (spec.inputs === 1 && !inputs.length) { exprs.set(id, null); return null }
    const expr = spec.code(node.data, inputs, { patternIds, slots, nodeId: id, orbit: 2 + sidechains.indexOf(id), eqAbove, cps })
    if (!expr) { exprs.set(id, null); return null }
    if (eqAbove || splitsBands(node)) banded.add(id)
    const name = nodeVar(id)
    lines.push(`// ${node.data.name ?? spec.label}`, `const ${name} = ${expr}`)
    exprs.set(id, name)
    return name
  }

  const lanes = []
  if (solo && byId.has(solo)) {
    const v = visit(solo)
    if (v) lanes.push(`solo: ${v}`)
  } else {
    for (const out of nodes.filter((n) => n.type === 'output')) {
      const soloWire = out.data.solo
      for (const w of inputsOf(edges, out.id)) {
        const v = visit(w.source)
        if (!v) continue
        const muted = out.data.muted?.[w.targetHandle] || (soloWire && soloWire !== w.targetHandle)
        lanes.push(`${muted ? '_' : ''}${out.id}_${w.targetHandle.replace('-', '')}: ${v}`)
      }
    }
  }
  return { lines, lanes }
}

/**
 * The starter patch: a beat; a bassline through an eq and compressor, ducked by a silent
 * kick; chords in some space; and thinned-out hats. Four lanes into the output.
 */
export function demoGraph(beatId, bassId, chordsId) {
  const data = (type, patch) => ({ ...defaultData(type), ...patch })
  return {
    nodes: [
      { id: 'beat', type: 'pattern', x: 40, y: 40, data: { patternId: beatId } },
      { id: 'bass', type: 'pattern', x: 40, y: 250, data: { patternId: bassId } },
      { id: 'basseq', type: 'eq3', x: 330, y: 230, data: data('eq3', { low: 3, mid: -2 }) },
      { id: 'basscomp', type: 'compressor', x: 620, y: 230, data: data('compressor', { threshold: -20, ratio: 4 }) },
      { id: 'pump', type: 'sound', x: 330, y: 470, data: { mini: 'bd*4', bank: 'RolandTR909' } },
      { id: 'bassduck', type: 'sidechain', x: 910, y: 250, data: data('sidechain', { depth: 0.7 }) },
      ...(chordsId ? [
        { id: 'chords', type: 'pattern', x: 40, y: 680, data: { patternId: chordsId } },
        { id: 'chordspace', type: 'space', x: 330, y: 700, data: data('space', { room: 0.6, delay: 0.3 }) },
      ] : []),
      { id: 'hats', type: 'sound', x: 40, y: 920, data: { mini: 'hh*16', bank: 'RolandTR909' } },
      { id: 'hatsthin', type: 'thin', x: 330, y: 920, data: { amount: 0.35 } },
      { id: 'hatslevel', type: 'level', x: 620, y: 920, data: { gain: 0.45, pan: 0.65 } },
      { id: 'out', type: 'output', x: 1220, y: 420, data: { muted: {}, solo: null } },
    ],
    edges: [
      { source: 'beat', target: 'out', targetHandle: 'in-0' },
      { source: 'bass', target: 'basseq', targetHandle: 'in' },
      { source: 'basseq', target: 'basscomp', targetHandle: 'in' },
      { source: 'basscomp', target: 'bassduck', targetHandle: 'in-0' },
      { source: 'pump', target: 'bassduck', targetHandle: 'in-1' },
      { source: 'bassduck', target: 'out', targetHandle: 'in-1' },
      ...(chordsId ? [
        { source: 'chords', target: 'chordspace', targetHandle: 'in' },
        { source: 'chordspace', target: 'out', targetHandle: 'in-2' },
      ] : []),
      { source: 'hats', target: 'hatsthin', targetHandle: 'in' },
      { source: 'hatsthin', target: 'hatslevel', targetHandle: 'in' },
      { source: 'hatslevel', target: 'out', targetHandle: chordsId ? 'in-3' : 'in-2' },
    ],
  }
}
