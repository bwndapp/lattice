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

import { liveBus } from './live'
import { STEREO_ORBIT_BASE, beginInserts, commitInserts, declareInsert, declareRoute } from './stereo'
import { DELAY_DEFAULTS, DELAY_DIVISIONS, GLOBAL_DELAY, GLOBAL_REVERB, REVERB_DEFAULTS, beginFx, commitFx, declareFx } from './fxbus.js'

const clampNum = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const tidy = (v) => String(Math.round(Number(v) * 1000) / 1000)
// text that lands inside a double-quoted mini-notation string
const miniText = (s) => String(s ?? '').replace(/["\\\n\r`]/g, ' ').slice(0, 400).trim() || '~'
/**
 * A knob that moves notes already ringing (see live.js): the voice listens to a bus
 * the app sets to (knob now − the value it started with). Only for controls a value sets
 * outright, so that starting value is known.
 */
const tap = (ctx, param, control, value, scale = 1) => (ctx?.nodeId
  ? `.bmod({ b: ${liveBus(ctx.nodeId, param, Number(value), scale)}, c: '${control}', da: 0.3 })`
  : '')
const soundName = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '') || 'bd'
const round = (v) => String(Math.round(Number(v)))

/*
 * Automation (see automation.js). `ctx.autoOf(key)` names the continuous pattern a knob
 * follows along the song, or is null. K() puts that pattern where the knob's number would
 * go; a knob that follows a curve drops its live-knob bus (the curve sets it per note).
 */
const isAuto = (ctx, key) => !!ctx?.autoOf?.(key)
const K = (ctx, d, key, fmt = tidy) => ctx?.autoOf?.(key) ?? fmt(d[key])
const tapUnlessAuto = (ctx, key, ...rest) => (isAuto(ctx, key) ? '' : tap(ctx, key, ...rest))
/**
 * `x.fmap(v => body)` where some values in the body may follow automation: each automated
 * key becomes a function argument fed by `.appLeft(itsPattern)`. `body(val)` gets val(key),
 * an expression for that key; `fmts` formats the plain numbers.
 */
/**
 * Send the sound to reverb / delay effects of its own (see fxbus.js): `sends` are
 * [effect key, the knob that sets how much]. An automated amount rides on each note;
 * otherwise the effect's input turns with the knob, ringing tails included.
 */
function sendCode(x, ctx, d, sends) {
  if (!sends.length) return x
  return fmapWith(x, ctx, d, sends.map(([, k]) => k), (val) => `{ ...v, fxsends: [...(v.fxsends ?? []), ${sends.map(([key, k]) => `['${key}', ${isAuto(ctx, k) ? val(k) : 1}]`).join(', ')}] }`)
}
const beatSeconds = (ctx) => 1 / ((ctx?.cps || 0.5) * (ctx?.beats || 4))
/** Mark what a source makes with the node it came from, so the patch can light up (flow.js). */
const fromNode = (x, id) => `${x}.fmap((v) => ({ ...v, _n: '${id}' }))`

function fmapWith(x, ctx, d, keys, body, fmts = {}) {
  const autos = keys.filter((k) => isAuto(ctx, k))
  const val = (k) => (autos.includes(k) ? `_${k}` : (fmts[k] ?? tidy)(d[k]))
  const args = autos.map((k) => `(_${k}) => `).join('')
  return `${x}.fmap((v) => ${args}(${body(val)}))${autos.map((k) => `.appLeft(${ctx.autoOf(k)})`).join('')}`
}

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
    group: 'source', label: 'pattern', blurb: 'Steps and notes you draw in its pop-up',
    inputs: 0,
    params: [],
    // the main out carries whatever isn't wired out on its own instrument port
    code: (d, _in, ctx) => {
      if (!ctx.patternIds.has(d.patternId)) return null
      const rest = ctx.mixChannels(d.patternId)
      if (rest === null) return patternVar(d.patternId)
      if (!rest.length) return 'silence' // every instrument left by its own port
      return rest.length === 1 ? rest[0] : `stack(${rest.join(', ')})`
    },
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
    code: (d, [x], ctx) => `${x}.sometimesBy(${K(ctx, d, 'chance')}, ${APPLY[d.fn]?.code ?? APPLY.up12.code})`,
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
    code: (d, [x], ctx) => `${x}.degradeBy(${K(ctx, d, 'amount')})`,
  },
  echo: {
    group: 'transform', label: 'echo', blurb: 'Repeat each event, fading',
    inputs: 1,
    params: [
      { key: 'times', type: 'int', label: 'times', min: 2, max: 8, def: 3 },
      { key: 'time', type: 'knob', label: 'gap', min: 0.02, max: 0.5, def: 0.125, unit: 'c' },
      { key: 'feedback', type: 'knob', label: 'fade', min: 0.1, max: 0.95, def: 0.6 },
    ],
    code: (d, [x], ctx) => `${x}.echo(${d.times}, ${K(ctx, d, 'time')}, ${K(ctx, d, 'feedback')})`,
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
      // a note carries one filter, so filters along a line keep the tightest setting
      // instead of the last one replacing the rest (an instrument's own cutoff included)
      const hpOn = d.hpf > 20 || isAuto(ctx, 'hpf')
      const merged = fmapWith(x, ctx, d, ['lpf', 'lpq', 'hpf'], (val) => {
        const hp = hpOn ? `, hcutoff: Math.max(v.hcutoff ?? 0, ${val('hpf')})` : ''
        return `{ ...v, ...(v.cutoff !== undefined && v.cutoff <= ${val('lpf')} ? {} : { cutoff: ${val('lpf')}, resonance: ${val('lpq')} })${hp} }`
      }, { lpf: round, hpf: round })
      return `${merged}${tapUnlessAuto(ctx, 'lpf', 'cutoff', Math.round(d.lpf))}${tapUnlessAuto(ctx, 'lpq', 'resonance', tidy(d.lpq))}${hpOn ? tapUnlessAuto(ctx, 'hpf', 'hcutoff', Math.round(d.hpf)) : ''}`
    },
  },
  space: {
    group: 'effect', label: 'space', blurb: 'Reverb and delay',
    inputs: 1,
    params: [
      { key: 'room', type: 'knob', label: 'reverb', min: 0, max: 1, def: 0.4 },
      { key: 'delay', type: 'knob', label: 'delay', min: 0, max: 0.9, def: 0.25 },
      { key: 'delaytime', type: 'knob', label: 'time', min: 0.05, max: 0.75, def: 0.1875, unit: 'bar' },
    ],
    // a quick reverb and a delay (time in bars) on effects of their own; see the reverb and
    // delay nodes for every setting
    code: (d, [x], ctx) => {
      const sends = []
      if (d.room > 0 || isAuto(ctx, 'room')) {
        ctx?.declareFx?.(`rv_${ctx.nodeId}`, 'reverb', { ...REVERB_DEFAULTS, mix: d.room, automatedMix: isAuto(ctx, 'room') })
        sends.push([`rv_${ctx?.nodeId}`, 'room'])
      }
      if (d.delay > 0 || isAuto(ctx, 'delay')) {
        const seconds = d.delaytime * beatSeconds(ctx) * (ctx?.beats || 4)
        ctx?.declareFx?.(`dl_${ctx.nodeId}`, 'delay', { ...DELAY_DEFAULTS, mix: d.delay, seconds, automatedMix: isAuto(ctx, 'delay') })
        sends.push([`dl_${ctx?.nodeId}`, 'delay'])
      }
      return sendCode(x, ctx, d, sends)
    },
  },
  reverb: {
    group: 'effect', label: 'reverb', blurb: 'A room around the sound: how big, how bright, how wide',
    inputs: 1,
    params: [
      { key: 'mix', type: 'knob', label: 'amount', min: 0, max: 1, def: 0.35 },
      { key: 'size', type: 'knob', label: 'size', min: 0.2, max: 12, def: 2.2, log: true, unit: 's' },
      { key: 'predelay', type: 'knob', label: 'pre-delay', min: 0, max: 0.2, def: 0.015, unit: 's' },
      { key: 'tone', type: 'knob', label: 'tone', min: 0, max: 1, def: 0.55 },
      { key: 'lowcut', type: 'knob', label: 'low cut', min: 20, max: 1000, def: 160, log: true, unit: 'hz' },
      { key: 'width', type: 'knob', label: 'width', min: 0, max: 1, def: 1 },
    ],
    code: (d, [x], ctx) => {
      if (!(d.mix > 0) && !isAuto(ctx, 'mix')) return x
      const key = `rv_${ctx?.nodeId}`
      ctx?.declareFx?.(key, 'reverb', { mix: d.mix, size: d.size, predelay: d.predelay, tone: d.tone, lowcut: d.lowcut, width: d.width, automatedMix: isAuto(ctx, 'mix') })
      return sendCode(x, ctx, d, [[key, 'mix']])
    },
  },
  delay: {
    group: 'effect', label: 'delay', blurb: 'Echoes in time with the track, fading through a tone filter',
    inputs: 1,
    params: [
      { key: 'mix', type: 'knob', label: 'amount', min: 0, max: 1, def: 0.3 },
      { key: 'time', type: 'select', label: 'time', options: Object.keys(DELAY_DIVISIONS), def: '1/8 dotted' },
      { key: 'feedback', type: 'knob', label: 'feedback', min: 0, max: 0.95, def: 0.4 },
      { key: 'tone', type: 'knob', label: 'tone', min: 0, max: 1, def: 0.6 },
      { key: 'mode', type: 'select', label: 'echoes', options: ['ping-pong', 'stereo'], def: 'ping-pong' },
    ],
    code: (d, [x], ctx) => {
      if (!(d.mix > 0) && !isAuto(ctx, 'mix')) return x
      const key = `dl_${ctx?.nodeId}`
      const seconds = (DELAY_DIVISIONS[d.time] ?? 0.75) * beatSeconds(ctx)
      ctx?.declareFx?.(key, 'delay', { mix: d.mix, seconds, feedback: d.feedback, tone: d.tone, mode: d.mode, automatedMix: isAuto(ctx, 'mix') })
      return sendCode(x, ctx, d, [[key, 'mix']])
    },
  },
  level: {
    group: 'effect', label: 'level', blurb: 'Volume and pan',
    inputs: 1,
    params: [
      { key: 'gain', type: 'knob', label: 'vol', min: 0, max: 1.5, def: 0.8 },
      { key: 'pan', type: 'knob', label: 'pan', min: 0, max: 1, def: 0.5 },
    ],
    // one level after another turns the sound down twice (they multiply), and pans add up
    code: (d, [x], ctx) => {
      const pan = d.pan !== 0.5 || isAuto(ctx, 'pan')
      const merged = fmapWith(x, ctx, d, pan ? ['gain', 'pan'] : ['gain'], (val) => {
        const p = pan ? `, pan: Math.min(1, Math.max(0, (v.pan ?? 0.5) + ${val('pan')} - 0.5))` : ''
        return `{ ...v, gain: (v.gain ?? 1) * ${val('gain')}${p} }`
      })
      return `${merged}${tapUnlessAuto(ctx, 'gain', 'gain', tidy(d.gain))}${pan ? tapUnlessAuto(ctx, 'pan', 'pan', tidy(d.pan), 2) : ''}`
    },
  },
  drive: {
    group: 'effect', label: 'drive', blurb: 'Distortion and bitcrush',
    inputs: 1,
    params: [
      { key: 'shape', type: 'knob', label: 'drive', min: 0, max: 0.9, def: 0.4 },
      { key: 'crush', type: 'knob', label: 'crush', min: 0, max: 1, def: 0 },
    ],
    code: (d, [x], ctx) => {
      const crush = d.crush > 0 || isAuto(ctx, 'crush')
      const merged = fmapWith(x, ctx, d, crush ? ['shape', 'crush'] : ['shape'], (val) => {
        const bits = crush ? `, crush: Math.min(v.crush ?? 16, Math.round(16 - ${val('crush')} * 14))` : ''
        return `{ ...v, shape: Math.min(0.95, (v.shape ?? 0) + ${val('shape')})${bits} }`
      })
      return `${merged}${d.shape > 0 ? tapUnlessAuto(ctx, 'shape', 'shape', tidy(d.shape)) : ''}`
    },
  },

  djfilter: {
    group: 'effect', label: 'dj filter', blurb: 'One knob: left darkens, right thins out',
    inputs: 1,
    params: [{ key: 'djf', type: 'knob', label: 'sweep', min: 0, max: 1, def: 0.5 }],
    code: (d, [x], ctx) => `${x}.djf(${K(ctx, d, 'djf')})`,
  },
  phaser: {
    group: 'effect', label: 'phaser', blurb: 'A swirling, sweeping sound',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.1, max: 16, def: 2, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.6 },
    ],
    code: (d, [x], ctx) => `${x}.phaser(${K(ctx, d, 'rate')}).phaserdepth(${K(ctx, d, 'depth')})`,
  },
  tremolo: {
    group: 'effect', label: 'tremolo', blurb: 'Volume that pulses',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.25, max: 32, def: 4, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.7 },
    ],
    code: (d, [x], ctx) => `${x}.tremolo(${K(ctx, d, 'rate')}).tremolodepth(${K(ctx, d, 'depth')})`,
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
    code: (d, [x]) => `${x}.fmap((v) => ({ ...v, coarse: Math.max(v.coarse ?? 1, ${d.coarse}) }))`,
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
      if (!trigger) { if (ctx.route) ctx.route.orbit = ctx.inputOrbits?.[ctx.slots.indexOf('in-0')] ?? null; return sound }
      // a sound already on its own bus (a haas or widener before this) keeps it, so both work
      const orbit = ctx.inputOrbits?.[ctx.slots.indexOf('in-0')] ?? ctx.orbit
      if (ctx.route) ctx.route.orbit = orbit
      return `stack(${sound}.orbit(${orbit}), ${trigger}.duckorbit(${orbit}).duckonset(${K(ctx, d, 'attack')}).duckattack(${K(ctx, d, 'release')}).duckdepth(${K(ctx, d, 'depth')})${d.hear === 'silent' ? '.postgain(0)' : ''})`
    },
  },
  eq3: {
    group: 'mixing', label: '3-band eq', blurb: 'Boost or cut lows, mids and highs on the sound going through it',
    inputs: 1,
    params: [
      { key: 'low', type: 'knob', label: 'low', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'mid', type: 'knob', label: 'mid', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'high', type: 'knob', label: 'high', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
      { key: 'lowf', type: 'knob', label: 'low / mid', min: 40, max: 1000, def: 200, log: true, unit: 'hz' },
      { key: 'highf', type: 'knob', label: 'mid / high', min: 1000, max: 12000, def: 3000, log: true, unit: 'hz' },
    ],
    // a shelf at each end and a bell in the middle, on the summed sound (see stereo.js)
    code: stereoCode('eq', (d) => ({ low: d.low, mid: d.mid, high: d.high, lowf: d.lowf, highf: d.highf })),
  },
  saturator: {
    group: 'mixing', label: 'saturator', blurb: 'Warmth and grit: rounds off peaks and adds harmonics',
    inputs: 1,
    params: [
      { key: 'drive', type: 'knob', label: 'drive', min: 0, max: 4, def: 1.2 },
      { key: 'character', type: 'select', label: 'character', options: ['warm', 'tape', 'tube', 'asym', 'harmonics', 'fold'], def: 'tape' },
      { key: 'out', type: 'knob', label: 'output', min: 0.05, max: 1, def: 0.8 },
    ],
    code: (d, [x], ctx) => (isAuto(ctx, 'drive') || isAuto(ctx, 'out')
      ? fmapWith(x, ctx, d, ['drive', 'out'], (val) => `{ ...v, distort: ${val('drive')}, distortvol: ${val('out')}, distorttype: '${SATURATION[d.character] ?? 'soft'}' }`)
      : `${x}.distort("${tidy(d.drive)}:${tidy(d.out)}:${SATURATION[d.character] ?? 'soft'}")`),
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
    code: (d, [x], ctx) => fmapWith(x, ctx, d, ['push', 'ceiling'], (val) => `v.distort === undefined ? { ...v, distort: ${val('push')}, distortvol: ${val('ceiling')}, distorttype: 'hard' } : { ...v, distort: v.distort + ${val('push')}, distortvol: (v.distortvol ?? 1) * ${val('ceiling')} }`),
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
    code: (d, [x], ctx) => {
      const keys = ['threshold', 'ratio', 'knee', 'attack', 'release']
      const comp = keys.some((k) => isAuto(ctx, k))
        ? fmapWith(x, ctx, d, keys, (val) => `{ ...v, compressor: ${val('threshold')}, compressorRatio: ${val('ratio')}, compressorKnee: ${val('knee')}, compressorAttack: ${val('attack')}, compressorRelease: ${val('release')} }`)
        : `${x}.compressor("${Math.round(d.threshold * 10) / 10}:${tidy(d.ratio)}:${tidy(d.knee)}:${tidy(d.attack)}:${tidy(d.release)}")`
      if (isAuto(ctx, 'makeup')) return fmapWith(comp, ctx, d, ['makeup'], (val) => `{ ...v, postgain: (v.postgain ?? 1) * 10 ** (${val('makeup')} / 20) }`)
      return `${comp}${d.makeup > 0.05 ? `.mul(postgain(${tidy(10 ** (d.makeup / 20))}))` : ''}`
    },
  },
  punch: {
    group: 'mixing', label: 'transient', blurb: 'More or less snap at the start of each hit, and more or less tail',
    inputs: 1,
    params: [
      { key: 'attack', type: 'knob', label: 'snap', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 },
      { key: 'sustain', type: 'knob', label: 'tail', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
    ],
    code: (d, [x], ctx) => fmapWith(x, ctx, d, ['attack', 'sustain'], (val) =>
      `{ ...v, transient: Math.min(1, Math.max(-1, (v.transient ?? 0) + ${val('attack')})), transsustain: Math.min(1, Math.max(-1, (v.transsustain ?? 0) + ${val('sustain')})) }`),
  },

  haas: {
    group: 'mixing', label: 'haas', blurb: 'Delay one ear by a few milliseconds: a mono sound opens up wide',
    inputs: 1,
    params: [
      { key: 'time', type: 'knob', label: 'time', min: 0.001, max: 0.04, def: 0.015, unit: 's' },
      { key: 'mix', type: 'knob', label: 'amount', min: 0, max: 1, def: 1 },
      { key: 'side', type: 'select', label: 'delay', options: ['right', 'left'], def: 'right' },
    ],
    code: stereoCode('haas', (d) => ({ time: d.time, mix: d.mix, side: d.side })),
  },
  widener: {
    group: 'mixing', label: 'stereo widener', blurb: 'Wider stereo image, with the low end kept in the middle',
    inputs: 1,
    params: [
      { key: 'width', type: 'knob', label: 'width', min: 0, max: 2, def: 1.5, unit: 'x', origin: 1 },
      { key: 'spread', type: 'knob', label: 'spread', min: 0, max: 1, def: 0.35 },
      { key: 'mono', type: 'knob', label: 'mono below', min: 20, max: 500, def: 120, log: true, unit: 'hz' },
    ],
    code: stereoCode('widener', (d) => ({ width: d.width, spread: d.spread, mono: d.mono })),
  },

  fxrack: {
    group: 'effect', label: 'fx rack', blurb: 'Several effects in one box, applied top to bottom',
    inputs: 1,
    params: [],
    code: (d, [x], ctx) => {
      const chain = (d.chain ?? []).filter((u) => u.on && FX_UNITS.includes(u.type))
      return chain.reduce((acc, u) => {
        const autoOf = ctx?.auto ? (key) => ctx.auto(`u:${ctx.nodeId}:${u.id}:${key}`) : null
        return NODE_TYPES[u.type].code(u.data, [acc], { ...ctx, autoOf, nodeId: ctx?.nodeId && `${ctx.nodeId}_${u.id}` })
      }, x)
    },
  },

  bus: {
    group: 'combine', label: 'mixer bus', blurb: 'Route several sounds into one track: level, pan and effects after it act on them all',
    inputs: 'many',
    params: [
      { key: 'name', type: 'text', label: 'name', def: 'bus' },
      { key: 'vol', type: 'knob', label: 'vol', min: 0, max: 1.5, def: 1 },
      { key: 'pan', type: 'knob', label: 'pan', min: 0, max: 1, def: 0.5 },
    ],
    // Like a mixer insert: everything wired in plays on one audio bus (an orbit), so reverb,
    // delay, stereo effects and sidechain ducking after it treat the group as one sound.
    // A sound that already has a bus of its own (a haas, a sidechain) keeps it, and the app
    // plays that bus into this one. Level and pan act on the summed sound, live.
    code: (d, xs, ctx) => {
      if (!xs.length || !ctx?.route) return xs.length ? `stack(${xs.join(', ')})` : null
      const orbit = ctx.stereoOrbit(ctx.nodeId)
      const parts = xs.map((x, i) => {
        const from = ctx.inputOrbits?.[i]
        if (from == null) return `${x}.orbit(${orbit})`
        if (from !== orbit) ctx.routeBus(from, orbit)
        return x
      })
      ctx.declare(orbit, ctx.nodeId, 'fader', { gain: d.vol, pan: d.pan })
      ctx.route.orbit = orbit
      return parts.length === 1 ? parts[0] : `stack(${parts.join(', ')})`
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

/**
 * Haas and widener process the audio bus ("orbit") a sound plays on (see stereo.js). The
 * code puts the sound on a bus of its own, unless it's already on one, and the app
 * processes that bus.
 */
function stereoCode(kind, params) {
  return (d, [x], ctx) => {
    if (!ctx?.route) return x
    let tail = ''
    if (ctx.route.orbit == null) {
      ctx.route.orbit = ctx.stereoOrbit(ctx.nodeId)
      tail = `.orbit(${ctx.route.orbit})`
    }
    ctx.declare(ctx.route.orbit, ctx.nodeId, kind, params(d))
    return `${x}${tail}`
  }
}
const STEREO_TYPES = new Set(['haas', 'widener', 'bus', 'eq3'])

/** Effects that can sit inside an fx rack: every plain effect node. */
export const FX_UNITS = ['eq3', 'compressor', 'saturator', 'clipper', 'punch', 'haas', 'widener', 'filter', 'djfilter', 'reverb', 'delay', 'space', 'level', 'drive', 'phaser', 'tremolo', 'vowel', 'lofi']

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
  ['mixing', 'eq, dynamics & stereo'],
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
export function normalizeGraph(raw, patterns) {
  const patternIds = new Set(patterns instanceof Set ? patterns : patterns.map((p) => p.id))
  const channelsIn = (pid) => (patterns instanceof Set ? null : patterns.find((p) => p.id === pid)?.channels)
  const nodes = []
  const ids = new Set()
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    const spec = NODE_TYPES[n?.type]
    if (!spec || typeof n.id !== 'string') continue
    const id = n.id.replace(/\W/g, '')
    if (!id || ids.has(id)) continue
    ids.add(id)
    const data = cleanData(n.type, n.data)
    if (n.type === 'fxrack') {
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
    // a wire can leave a pattern node by one instrument's port instead of its main out;
    // when that instrument is gone the wire goes with it
    const chan = source.type === 'pattern' && /^out-[\w-]{1,40}$/.test(String(e?.sourceHandle)) ? e.sourceHandle.slice(4) : null
    const known = chan && channelsIn(source.data.patternId)
    if (chan && known && !known.some((c) => c.id === chan)) continue
    const from = chan ? `out-${chan}` : 'out'
    edges.push({ id: `e_${source.id}_${from === 'out' ? '' : `${from.slice(4)}_`}${target.id}_${handle.replace('-', '')}`, source: source.id, sourceHandle: from, target: target.id, targetHandle: handle })
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
export const patternVar = (id) => `p_${id}`
/** One instrument of a pattern, as its own variable (project.js writes these out). */
export const patternChanVar = (patternId, channelId) => `p_${patternId}_${channelId}`
/** The instrument a wire leaves a pattern node by, or null for its main out. */
export const outChannel = (handle) => /^out-(.+)$/.exec(String(handle ?? ''))?.[1] ?? null

/** Patterns with at least one instrument wired out on its own port. */
export function splitPatternIds(project) {
  const ids = new Set()
  for (const e of project.edges ?? []) {
    if (!outChannel(e.sourceHandle)) continue
    const src = project.nodes?.find((n) => n.id === e.source)
    if (src?.type === 'pattern' && src.data?.patternId) ids.add(src.data.patternId)
  }
  return ids
}

/**
 * Code for the graph: one `const` per node that makes a pattern, in dependency order,
 * then one lane per wire into each output node. `solo` (a node id) plays only that node.
 */
export function graphCode(project, { solo = null, song = null, audition = false, auto = null } = {}) {
  const { nodes, edges } = project
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const patternIds = new Set(project.patterns.map((p) => p.id))
  const exprs = new Map() // id → variable name, or null when the node makes nothing
  const lines = []
  // each sidechain gets its own audio bus; bus 1 is where everything else plays
  const sidechains = nodes.filter((n) => n.type === 'sidechain').map((n) => n.id)
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
  // stereo inserts: a bus each, numbered in patch order so the numbers stay put
  const stereoKeys = []
  for (const n of nodes) {
    if (STEREO_TYPES.has(n.type)) stereoKeys.push(n.id)
    for (const u of n.data?.chain ?? []) if (STEREO_TYPES.has(u.type)) stereoKeys.push(`${n.id}_${u.id}`)
  }
  const stereoOrbit = (key) => STEREO_ORBIT_BASE + Math.max(0, stereoKeys.indexOf(key))
  const inserts = beginInserts()
  // reverbs and delays: the patch's own, and the shared pair the instruments' knobs send to
  const fx = beginFx()
  const beats = Number(project.beats) || 4
  declareFx(fx, GLOBAL_REVERB, 'reverb', { ...REVERB_DEFAULTS, mix: 1 })
  declareFx(fx, GLOBAL_DELAY, 'delay', { ...DELAY_DEFAULTS, mix: 1, feedback: 0.35, seconds: 0.75 / (cps * beats) })
  const declare = (orbit, key, kind, params) => declareInsert(inserts, orbit, key, kind, params)
  const routeBus = (from, to) => declareRoute(inserts, from, to)
  const orbitOf = new Map() // node id → the bus its sound ends up on, when not the main one
  const channelsOf = (pid) => project.patterns.find((p) => p.id === pid)?.channels ?? []
  /** What a wire carries: one instrument of a pattern, or everything the source node makes. */
  const carried = (w, name) => {
    const chan = outChannel(w.sourceHandle)
    if (!chan) return name
    const src = byId.get(w.source)
    if (src?.type !== 'pattern' || !channelsOf(src.data.patternId).some((c) => c.id === chan)) return name
    return fromNode(patternChanVar(src.data.patternId, chan), src.id)
  }

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
      if (v) { inputs.push(carried(w, v)); slots.push(w.targetHandle) }
    }
    if (spec.inputs === 1 && !inputs.length) { exprs.set(id, null); return null }
    const inputOrbits = wires.filter((w) => exprs.get(w.source)).map((w) => orbitOf.get(w.source) ?? null)
    // a single input passes its bus on; mixing several inputs lands back on the main bus
    const route = { orbit: inputs.length === 1 && spec.inputs !== 'many' ? inputOrbits[0] : null }
    const autoOf = auto ? (key) => auto(`n:${id}:${key}`) : null
    // instruments this node sends out on their own port don't also go out its main one
    const split = new Set(edges.filter((e) => e.source === id).map((e) => outChannel(e.sourceHandle)).filter(Boolean))
    const mixChannels = (pid) => (split.size
      ? channelsOf(pid).filter((c) => !split.has(c.id)).map((c) => patternChanVar(pid, c.id))
      : null)
    let expr = spec.code(node.data, inputs, { patternIds, mixChannels, slots, nodeId: id, orbit: 2 + sidechains.indexOf(id), cps, beats, route, inputOrbits, stereoOrbit, declare, routeBus, auto, autoOf, declareFx: (key, kind, params) => declareFx(fx, key, kind, params) })
    if (!expr) { exprs.set(id, null); return null }
    // a source making sound on its own plays when the song says (patterns are handled where they're defined)
    if (song && spec.group === 'source' && node.type !== 'pattern' && !wires.length) expr = song(`node:${id}`, expr)
    if (spec.group === 'source') expr = fromNode(expr, id)
    if (route.orbit != null) orbitOf.set(id, route.orbit)
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
        lanes.push(`${muted ? '_' : ''}${out.id}_${w.targetHandle.replace('-', '')}: ${carried(w, v)}`)
      }
    }
  }
  commitInserts(inserts, { partial: !!solo || audition }) // an audition must not rewire the playing mix
  commitFx(fx, { partial: !!solo || audition })
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
        // the filter's cutoff is the knob the starter song automates
        { id: 'chordfilter', type: 'filter', x: 330, y: 680, data: data('filter', { lpf: 700, lpq: 7, hpf: 20 }) },
        { id: 'chorddelay', type: 'delay', x: 620, y: 680, data: data('delay', { mix: 0.22, time: '1/8 dotted', feedback: 0.35, tone: 0.55 }) },
        { id: 'chordverb', type: 'reverb', x: 910, y: 680, data: data('reverb', { mix: 0.4, size: 3.4, tone: 0.5 }) },
      ] : []),
      { id: 'hats', type: 'sound', x: 40, y: 940, data: { mini: 'hh*16', bank: 'RolandTR909' } },
      { id: 'hatsthin', type: 'thin', x: 330, y: 940, data: { amount: 0.35 } },
      { id: 'hatslevel', type: 'level', x: 620, y: 940, data: { gain: 0.45, pan: 0.65 } },
      { id: 'out', type: 'output', x: 1220, y: 460, data: { muted: {}, solo: null } },
    ],
    edges: [
      { source: 'beat', target: 'out', targetHandle: 'in-0' },
      { source: 'bass', target: 'basseq', targetHandle: 'in' },
      { source: 'basseq', target: 'basscomp', targetHandle: 'in' },
      { source: 'basscomp', target: 'bassduck', targetHandle: 'in-0' },
      { source: 'pump', target: 'bassduck', targetHandle: 'in-1' },
      { source: 'bassduck', target: 'out', targetHandle: 'in-1' },
      ...(chordsId ? [
        { source: 'chords', target: 'chordfilter', targetHandle: 'in' },
        { source: 'chordfilter', target: 'chorddelay', targetHandle: 'in' },
        { source: 'chorddelay', target: 'chordverb', targetHandle: 'in' },
        { source: 'chordverb', target: 'out', targetHandle: 'in-2' },
      ] : []),
      { source: 'hats', target: 'hatsthin', targetHandle: 'in' },
      { source: 'hatsthin', target: 'hatslevel', targetHandle: 'in' },
      { source: 'hatslevel', target: 'out', targetHandle: chordsId ? 'in-3' : 'in-2' },
    ],
  }
}
