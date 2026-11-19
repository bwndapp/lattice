/**
 * The node graph a project is made of. Every node turns into one line of Strudel:
 *
 *   sources      pattern, sound, notes, code          → a pattern out
 *   transforms   fast, slow, every, euclid, …         → one pattern in, one out
 *   effects      filter, eq, reverb, compressor, …    → one pattern in, one out
 *                (the add menu files them by `cat`; `hidden` ones are older duplicates
 *                that saved tracks still play, left out of the menus)
 *   combine      stack, sequence, arrange             → many in, one out
 *   output       each wire into it is a lane you hear (mute is the track's, solo is yours)
 *
 * Wires go from a node's right edge (out) to a node's left edge (in). Multi-input nodes
 * grow a new input slot as you connect them; slot order is the order in the code.
 */

import { parse } from 'acorn'
import { GRAIN_STEPS, RING_MODES, RING_RATES, RING_SHAPES, RING_SOURCES, WOOK_FOLLOW, WOOK_RATES, WOOK_SHAPES, STEREO_ORBIT_BASE, beginInserts, commitInserts, declareBranch, declareInsert, declareQuiet, declareRoute, declareSide, declareSpeakers } from './stereo'
import { abstractBuild, abstractNodeTypes, abstractOf, abstractParts, packState } from './abstract/index.js'
import { DELAY_DEFAULTS, DELAY_DIVISIONS, GLOBAL_DELAY, GLOBAL_REVERB, REVERB_DEFAULTS, beginFx, commitFx, declareFx } from './fxbus.js'

const clampNum = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
const tidy = (v) => String(Math.round(Number(v) * 1000) / 1000)
// text that lands inside a double-quoted mini-notation string
const miniText = (s) => String(s ?? '').replace(/["\\\n\r`]/g, ' ').slice(0, 400).trim() || '~'
const soundName = (s) => String(s ?? '').replace(/[^\w:.#-]/g, '') || 'bd'
const round = (v) => String(Math.round(Number(v)))

/*
 * Automation (see automation.js). `ctx.autoOf(key)` names the continuous pattern a knob
 * follows along the song, or is null. K() puts that pattern where the knob's number would
 * go; a knob that follows a curve drops its live-knob bus (the curve sets it per note).
 */
const isAuto = (ctx, key) => !!ctx?.autoOf?.(key)
const K = (ctx, d, key, fmt = tidy) => ctx?.autoOf?.(key) ?? fmt(d[key])
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
/**
 * A reverb or delay on a sound that's already on a bus — after a mixer bus, or on one branch
 * of a split one — works on that bus, as an insert, rather than as a send on each note. Its
 * tail stays on that path instead of going back to where the notes started (which is before
 * the split, so the dry branch would hear it too), and the notes are left as they are, so
 * two branches that come back together still play them once. Returns null when the sound
 * isn't on a bus, or the mix follows automation (which is read at each note): a send, then.
 */
function spaceOnBus(x, ctx, key, kind, params, mixKey = 'mix') {
  if (ctx?.route?.orbit == null || isAuto(ctx, mixKey)) return null
  ctx.declare(ctx.route.orbit, key, 'sendfx', { ...params, kind })
  return x
}

function sendCode(x, ctx, d, sends) {
  if (!sends.length) return x
  return fmapWith(x, ctx, d, sends.map(([, k]) => k), (val) => `{ ...v, fxsends: [...(v.fxsends ?? []), ${sends.map(([key, k]) => `['${key}', ${isAuto(ctx, k) ? val(k) : 1}]`).join(', ')}] }`)
}
const beatSeconds = (ctx) => 1 / ((ctx?.cps || 0.5) * (ctx?.beats || 4))
/** Mark what a source makes with the node it came from, so the patch can light up (flow.js). */
const fromNode = (x, id) => `${x}.fmap((v) => ({ ...v, _n: '${id}' }))`
// a rhythm machine's hits keep the node that made the sound (what's wired in), so the patch
// lights that node and its wire in, not just the machine (flow.js); its own sounds are its own
const fromMachine = (x, id) => `${x}.fmap((v) => ({ ...v, _n: v._n ?? '${id}' }))`

function fmapWith(x, ctx, d, keys, body, fmts = {}) {
  const autos = keys.filter((k) => isAuto(ctx, k))
  const val = (k) => (autos.includes(k) ? `_${k}` : (fmts[k] ?? tidy)(d[k]))
  const args = autos.map((k) => `(_${k}) => `).join('')
  return `${x}.fmap((v) => ${args}(${body(val)}))${autos.map((k) => `.appLeft(${ctx.autoOf(k)})`).join('')}`
}

/** How a soft clip rounds off: a curve that flattens gently, a tanh, or a cubic. */
const KNEES = { round: 'scurve', smooth: 'soft', cubic: 'cubic' }

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
    code: (d) => codeNodeExpr(d.code),
  },
  // the stranger sources: a cube you twist, … (see abstract/index.js)
  ...abstractNodeTypes(),

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
    group: 'transform', label: 'note echo', codeLabel: 'echo', blurb: 'Repeat each note, fading (the notes, not the audio: see delay)',
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
    group: 'effect', cat: 'filter', label: 'filter', blurb: 'Cut highs or lows',
    inputs: 1,
    params: [
      { key: 'lpf', type: 'knob', label: 'cutoff', min: 60, max: 20000, def: 2000, log: true, unit: 'hz' },
      { key: 'lpq', type: 'knob', label: 'reso', min: 0, max: 25, def: 4 },
      { key: 'hpf', type: 'knob', label: 'low cut', min: 20, max: 8000, def: 20, log: true, unit: 'hz' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    // on the bus, so filters along a line really do cascade (see stereo.js). An
    // instrument's own cutoff knob still belongs to its notes.
    code: stereoCode('filter', (d) => ({ lpf: d.lpf, lpq: d.lpq, hpf: d.hpf })),
  },
  space: {
    group: 'effect', cat: 'space', hidden: true, label: 'space', blurb: 'Reverb and delay',
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
      // on a bus, both are inserts on it (see spaceOnBus)
      if (ctx?.route?.orbit != null && !isAuto(ctx, 'room') && !isAuto(ctx, 'delay')) {
        if (d.room > 0) spaceOnBus(x, ctx, `rv_${ctx.nodeId}`, 'reverb', { ...REVERB_DEFAULTS, mix: d.room }, 'room')
        if (d.delay > 0) spaceOnBus(x, ctx, `dl_${ctx.nodeId}`, 'delay', { ...DELAY_DEFAULTS, mix: d.delay, seconds: d.delaytime * beatSeconds(ctx) * (ctx?.beats || 4) }, 'delay')
        return x
      }
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
    group: 'effect', cat: 'space', label: 'reverb', blurb: 'A room around the sound: how big, how bright, how wide',
    inputs: 1,
    params: [
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 0.35 },
      { key: 'size', type: 'knob', label: 'size', min: 0.2, max: 12, def: 2.2, log: true, unit: 's' },
      { key: 'predelay', type: 'knob', label: 'pre-delay', min: 0, max: 0.2, def: 0.015, unit: 's' },
      { key: 'tone', type: 'knob', label: 'tone', min: 0, max: 1, def: 0.55 },
      { key: 'lowcut', type: 'knob', label: 'low cut', min: 20, max: 1000, def: 160, log: true, unit: 'hz' },
      { key: 'width', type: 'knob', label: 'width', min: 0, max: 1, def: 1 },
    ],
    code: (d, [x], ctx) => {
      if (!(d.mix > 0) && !isAuto(ctx, 'mix')) return x
      const key = `rv_${ctx?.nodeId}`
      const params = { mix: d.mix, size: d.size, predelay: d.predelay, tone: d.tone, lowcut: d.lowcut, width: d.width }
      const onBus = spaceOnBus(x, ctx, key, 'reverb', params)
      if (onBus != null) return onBus
      ctx?.declareFx?.(key, 'reverb', { ...params, automatedMix: isAuto(ctx, 'mix') })
      return sendCode(x, ctx, d, [[key, 'mix']])
    },
  },
  delay: {
    group: 'effect', cat: 'space', label: 'delay', blurb: 'Echoes in time with the track, fading through a tone filter',
    inputs: 1,
    params: [
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 0.3 },
      { key: 'time', type: 'select', label: 'time', options: Object.keys(DELAY_DIVISIONS), def: '1/8 dotted' },
      { key: 'feedback', type: 'knob', label: 'feedback', min: 0, max: 0.95, def: 0.4 },
      { key: 'tone', type: 'knob', label: 'tone', min: 0, max: 1, def: 0.6 },
      { key: 'mode', type: 'select', label: 'echoes', options: ['ping-pong', 'stereo'], def: 'ping-pong' },
    ],
    code: (d, [x], ctx) => {
      if (!(d.mix > 0) && !isAuto(ctx, 'mix')) return x
      const key = `dl_${ctx?.nodeId}`
      const seconds = (DELAY_DIVISIONS[d.time] ?? 0.75) * beatSeconds(ctx)
      const params = { mix: d.mix, seconds, feedback: d.feedback, tone: d.tone, mode: d.mode }
      const onBus = spaceOnBus(x, ctx, key, 'delay', params)
      if (onBus != null) return onBus
      ctx?.declareFx?.(key, 'delay', { ...params, automatedMix: isAuto(ctx, 'mix') })
      return sendCode(x, ctx, d, [[key, 'mix']])
    },
  },
  level: {
    group: 'effect', cat: 'stereo', hidden: true, label: 'level', blurb: 'Volume and pan',
    inputs: 1,
    params: [
      { key: 'gain', type: 'knob', label: 'vol', min: 0, max: 1.5, def: 0.8, fmt: 'gain' },
      { key: 'pan', type: 'knob', label: 'pan', min: 0, max: 1, def: 0.5 },
    ],
    // a fader on the bus, like the mixer bus node's own (see stereo.js)
    code: stereoCode('fader', (d) => ({ gain: d.gain, pan: d.pan })),
  },
  drive: {
    group: 'effect', cat: 'drive', hidden: true, label: 'drive', blurb: 'Distortion and bitcrush',
    inputs: 1,
    params: [
      { key: 'shape', type: 'knob', label: 'drive', min: 0, max: 0.9, def: 0.4 },
      { key: 'crush', type: 'knob', label: 'crush', min: 0, max: 1, def: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('shaper', (d) => ({ shape: d.shape, crush: d.crush, out: 1, curve: 'scurve' })),
  },

  pitch: {
    group: 'effect', cat: 'pitch', label: 'pitch', blurb: 'Up or down in semitones, with the tempo left alone',
    inputs: 1,
    params: [
      { key: 'semitones', type: 'knob', label: 'shift', min: -24, max: 24, def: 0, unit: 'st', origin: 0 },
      { key: 'fine', type: 'knob', label: 'fine', min: -100, max: 100, def: 0, unit: 'ct', origin: 0 },
      { key: 'grain', type: 'knob', label: 'window', min: 0.01, max: 0.25, def: 0.06, log: true, unit: 's' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('pitch', (d) => ({ semitones: d.semitones, fine: d.fine, grain: d.grain, mix: d.mix })),
  },
  freqshift: {
    group: 'effect', cat: 'pitch', label: 'freq shift', blurb: 'Every partial moved by the same hertz: it stops being a note',
    inputs: 1,
    params: [
      { key: 'hz', type: 'knob', label: 'shift', min: -500, max: 500, def: 40, unit: 'hz', origin: 0 },
      { key: 'spread', type: 'knob', label: 'spread', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('freqshift', (d) => ({ hz: d.hz, spread: d.spread, mix: d.mix })),
  },
  djfilter: {
    group: 'effect', cat: 'filter', label: 'dj filter', blurb: 'One knob: left darkens, right thins out',
    inputs: 1,
    params: [{ key: 'djf', type: 'knob', label: 'sweep', min: 0, max: 1, def: 0.5 }],
    code: stereoCode('djfilter', (d) => ({ djf: d.djf })),
  },
  phaser: {
    group: 'effect', cat: 'mod', label: 'phaser', blurb: 'A swirling, sweeping sound',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.1, max: 16, def: 2, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.6 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('phaser', (d) => ({ rate: d.rate, depth: d.depth })),
  },
  chorus: {
    group: 'effect', cat: 'mod', label: 'chorus', blurb: 'Thicker and wider, like several players at once',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.05, max: 5, def: 0.8, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.5 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 0.5 },
    ],
    code: stereoCode('chorus', (d) => ({ rate: d.rate, depth: d.depth, mix: d.mix })),
  },
  flanger: {
    group: 'effect', cat: 'mod', label: 'flanger', blurb: 'A metallic whoosh that sweeps up and down, like a jet',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.02, max: 10, def: 0.25, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.8 },
      { key: 'feedback', type: 'knob', label: 'feedback', min: -0.95, max: 0.95, def: 0.6, unit: 'bi', origin: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 0.5 },
    ],
    code: stereoCode('flanger', (d) => ({ rate: d.rate, depth: d.depth, feedback: d.feedback, mix: d.mix })),
  },
  tremolo: {
    group: 'effect', cat: 'mod', label: 'tremolo', blurb: 'Volume that pulses',
    inputs: 1,
    params: [
      { key: 'rate', type: 'knob', label: 'rate', min: 0.25, max: 32, def: 4, log: true },
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.7 },
    ],
    code: stereoCode('tremolo', (d) => ({ rate: d.rate, depth: d.depth })),
  },
  vowel: {
    group: 'effect', cat: 'filter', label: 'vowel', blurb: 'Makes it sound like it says a vowel',
    inputs: 1,
    params: [{ key: 'vowel', type: 'select', label: 'vowel', options: ['a', 'e', 'i', 'o', 'u'], def: 'a' }],
    code: stereoCode('vowel', (d) => ({ vowel: ['a', 'e', 'i', 'o', 'u'].includes(d.vowel) ? d.vowel : 'a' })),
  },
  lofi: {
    group: 'effect', cat: 'texture', label: 'lo-fi', blurb: 'Lower sample rate, grittier',
    inputs: 1,
    params: [{ key: 'coarse', type: 'int', label: 'grit', min: 1, max: 32, def: 6 }],
    code: stereoCode('lofi', (d) => ({ coarse: d.coarse })),
  },
  granulizer: {
    group: 'effect', cat: 'texture', label: 'granulizer', blurb: 'Chop the sound into tiny grains and spray them back: smears, clouds, glitches',
    inputs: 1,
    params: [
      { key: 'size', type: 'knob', label: 'size', min: 0.001, max: 1, def: 0.08, log: true, unit: 's' },
      { key: 'density', type: 'knob', label: 'density', min: 1, max: 1000, def: 20, log: true, unit: 'hz' },
      { key: 'position', type: 'knob', label: 'position', min: 0, max: 3, def: 0.1, unit: 's' },
      { key: 'spray', type: 'knob', label: 'spray', min: 0, max: 3, def: 0.05, unit: 's' },
      { key: 'pitch', type: 'knob', label: 'pitch', min: -48, max: 48, def: 0, unit: 'st', origin: 0 },
      { key: 'pitchRand', type: 'knob', label: 'pitch rand', min: 0, max: 48, def: 0, unit: 'st' },
      { key: 'steps', type: 'select', label: 'steps', options: GRAIN_STEPS, def: 'free' },
      { key: 'glide', type: 'knob', label: 'glide', min: -48, max: 48, def: 0, unit: 'st', origin: 0 },
      { key: 'chaos', type: 'knob', label: 'chaos', min: 0, max: 1, def: 0.25 },
      { key: 'shape', type: 'knob', label: 'shape', min: 0, max: 1, def: 0 },
      { key: 'reverse', type: 'knob', label: 'reverse', min: 0, max: 1, def: 0 },
      { key: 'spread', type: 'knob', label: 'spread', min: 0, max: 1, def: 0.5 },
      { key: 'freeze', type: 'knob', label: 'freeze', min: 0, max: 1, def: 0 },
      { key: 'feedback', type: 'knob', label: 'feedback', min: 0, max: 0.95, def: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 0.6 },
    ],
    code: stereoCode('grain', (d) => ({ size: d.size, density: d.density, position: d.position, spray: d.spray, pitch: d.pitch, pitchRand: d.pitchRand, steps: d.steps, glide: d.glide, chaos: d.chaos, shape: d.shape, reverse: d.reverse, spread: d.spread, freeze: d.freeze, feedback: d.feedback, mix: d.mix })),
  },
  ringmod: {
    group: 'effect', cat: 'pitch', label: 'ring mod', blurb: 'The sound times a carrier: metallic, bell-like and robotic in ring mode, beating in am, or chopped in time',
    inputs: 1,
    params: [
      { key: 'source', type: 'select', label: 'source', options: RING_SOURCES, def: 'hz' },
      { key: 'freq', type: 'knob', label: 'freq', min: 1, max: 5000, def: 220, log: true, unit: 'hz', when: (d) => (d.source ?? 'hz') === 'hz' },
      { key: 'rate', type: 'select', label: 'rate', options: RING_RATES, def: '1/32', when: (d) => d.source === 'tempo' },
      { key: 'shape', type: 'select', label: 'shape', options: RING_SHAPES, def: 'sine' },
      { key: 'mode', type: 'select', label: 'mode', options: RING_MODES, def: 'ring' },
      { key: 'amount', type: 'knob', label: 'depth', min: 0, max: 1, def: 1 },
      { key: 'spread', type: 'knob', label: 'spread', min: 0, max: 1, def: 0 },
      { key: 'drift', type: 'knob', label: 'drift', min: 0, max: 1, def: 0, when: (d) => (d.source ?? 'hz') === 'hz' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
      { key: 'out', type: 'knob', label: 'out', min: 0, max: 2, def: 1, fmt: 'gain' },
    ],
    code: (() => {
      const pick = (d) => ({ source: d.source, freq: d.freq, rate: d.rate, shape: d.shape, mode: d.mode, amount: d.amount, spread: d.spread, drift: d.drift, mix: d.mix, out: d.out })
      const base = stereoCode('ringmod', pick)
      const code = (d, xs, ctx) => stereoCode('ringmod', (dd) => ({ ...pick(dd), cps: ctx?.cps }))(d, xs, ctx)
      code.insert = base.insert
      return code
    })(),
  },
  wook: {
    group: 'effect', cat: 'texture', label: 'w00k', blurb: 'Flutter: a fast chop in time on anything you send through it — the wook bass flutter, with warble, a darkening filter, spread, swing and hit-following',
    inputs: 1,
    params: [
      { key: 'rate', type: 'select', label: 'rate', options: WOOK_RATES, def: '1/32' },
      // only when the rate is free: in time, the song's tempo sets it
      { key: 'hz', type: 'knob', label: 'hz', min: 0.5, max: 60, def: 12, log: true, unit: 'hz', when: (d) => d.rate === 'free' },
      { key: 'shape', type: 'select', label: 'shape', options: WOOK_SHAPES, def: 'sine' },
      { key: 'width', type: 'knob', label: 'width', min: 0.05, max: 0.95, def: 0.5 },
      { key: 'smooth', type: 'knob', label: 'smooth', min: 0, max: 1, def: 0.3 },
      { key: 'chop', type: 'knob', label: 'chop', min: 0, max: 1, def: 0.85 },
      { key: 'warble', type: 'knob', label: 'warble', min: 0, max: 100, def: 10, unit: 'ct' },
      { key: 'filter', type: 'knob', label: 'filter', min: 0, max: 1, def: 0 },
      { key: 'spread', type: 'knob', label: 'spread', min: 0, max: 1, def: 0 },
      { key: 'swing', type: 'knob', label: 'swing', min: 0, max: 0.5, def: 0 },
      { key: 'follow', type: 'select', label: 'follow', options: WOOK_FOLLOW, def: 'song' },
      // after each hit the chop fades in over this long, so the hit's front comes through whole
      { key: 'rise', type: 'knob', label: 'rise', min: 0, max: 2, def: 0, unit: 's' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
      { key: 'out', type: 'knob', label: 'out', min: 0, max: 2, def: 1, fmt: 'gain' },
    ],
    // the song's tempo goes with it, so the flutter keeps time even before the song's position reaches it
    code: (() => {
      const pick = (d) => ({ rate: d.rate, hz: d.hz, shape: d.shape, width: d.width, smooth: d.smooth, chop: d.chop, warble: d.warble, filter: d.filter, spread: d.spread, swing: d.swing, follow: d.follow, rise: d.rise, mix: d.mix, out: d.out })
      const base = stereoCode('wook', pick)
      const code = (d, xs, ctx) => stereoCode('wook', (dd) => ({ ...pick(dd), cps: ctx?.cps }))(d, xs, ctx)
      code.insert = base.insert
      return code
    })(),
  },
  bitcrush: {
    group: 'effect', cat: 'texture', label: 'bitcrush', blurb: 'Fewer bits, lower rate: crunchy and digital',
    inputs: 1,
    params: [
      { key: 'bits', type: 'knob', label: 'bits', min: 1, max: 16, def: 6 },
      { key: 'rate', type: 'knob', label: 'rate', min: 1, max: 32, def: 1, log: true, unit: 'x' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('crush', (d) => ({ bits: d.bits, rate: d.rate, mix: d.mix })),
  },
  sidechain: {
    group: 'effect', cat: 'dynamics', label: 'sidechain', blurb: 'Duck the sound every time the trigger hits (kick pumps the bass)',
    // named inputs: slot 0 is ducked, slot 1 does the ducking
    inputs: ['sound', 'trigger'],
    /*
     * As many sounds as you like get ducked; they land on one bus and pump together, which
     * is what you want — a bass, a pad and a stab all breathing with the same kick.
     *
     * The trigger stays one, and that isn't an omission. Ducking is one gain curve written
     * onto the bus; two triggers would each write their own over the top of the other and
     * you'd hear whichever hit last, not both. Wire triggers into one pattern or a bus
     * first if you want a kick and a snare to duck together.
     */
    many: ['in-0'],
    params: [
      { key: 'depth', type: 'knob', label: 'depth', min: 0, max: 1, def: 0.85 },
      { key: 'attack', type: 'knob', label: 'attack', min: 0, max: 0.1, def: 0.005, unit: 's' },
      { key: 'release', type: 'knob', label: 'release', min: 0.02, max: 1, def: 0.25, unit: 's' },
      { key: 'drive', type: 'knob', label: 'drive', min: 0.5, max: 4, def: 1, log: true, unit: 'x' },
      { key: 'mode', type: 'select', label: 'mode', options: ['clean', 'ring'], def: 'clean' },
      { key: 'hear', type: 'select', label: 'trigger', options: ['silent', 'audible'], def: 'silent' },
    ],
    /*
     * The ring-mod way (Kilohearts' Ring Mod with a sidechain source): the ducked bus is
     * multiplied by the trigger's own audio, on the audio thread, sample by sample — so the
     * dip is the kick's own shape and length and is never late, however busy the page.
     * The trigger plays a copy on a bus of its own that goes into the sidechain's input
     * (stereo.js ringside), and to the speakers as well only when it's to be heard.
     */
    code: (d, xs, ctx) => {
      const sounds = xs.filter((_, i) => ctx.slots[i] === 'in-0')
      const trigger = xs[ctx.slots.indexOf('in-1')]
      if (!sounds.length) return null
      const at = xs.map((_, i) => i).filter((i) => ctx.slots[i] === 'in-0')
      const sound = sounds.length === 1 ? sounds[0] : `stack(${sounds.join(', ')})`
      if (!trigger) { if (ctx.route) ctx.route.orbit = sounds.length === 1 ? ctx.inputOrbits?.[at[0]] ?? null : null; return sound }
      // One sound already on a bus of its own (a haas or widener before this): duck that bus,
      // so both work. Several sounds, or one on a bus another path hears as well (after a
      // split): the sidechain gets a bus of its own, and each sound plays into it — through
      // its own inserts, from its own bus, so ducking one path never pumps another.
      const first = ctx.inputOrbits?.[at[0]] ?? null
      const own = sounds.length > 1 || (first != null && ctx.inputShared?.[at[0]])
      const orbit = own ? ctx.orbit : first ?? ctx.orbit
      if (ctx.route) ctx.route.orbit = orbit
      const placed = at.map((i) => {
        const from = ctx.inputOrbits?.[i] ?? null
        if (from == null) return `${ctx.ownPath ? ctx.ownPath(xs[i], i, orbit) : xs[i]}.orbit(${orbit})` // notes with no bus play onto this one
        if (from !== orbit) { ctx.routeBus(from, orbit, 1); return xs[i] } // a bus plays in, notes as they were
        return xs[i]
      })
      // the sidechain itself, on the ducked bus after whatever that sound already goes through
      const key = `sc_${ctx.nodeId}`
      ctx.declare(orbit, key, 'ringside', { depth: d.depth, attack: d.attack, release: d.release, drive: d.drive, mode: d.mode })
      // The trigger. Already on a bus of its own (after an effect: a kick through a
      // saturator): that bus's own audio goes into the sidechain's input, exactly what's
      // patched, with no copy. Its notes come along unchanged, and a merge further on plays
      // them once even when the trigger is wired somewhere else as well. A trigger that's
      // only here and meant to be silent isn't heard on its own.
      const ti = ctx.slots.indexOf('in-1')
      const trigBus = ctx.inputOrbits?.[ti] ?? null
      // the sounds as placed above: notes already on a bus stay where they are (a bus's own
      // paths, a distortion inside it, keep their inserts), only those with none come here
      const soundAtoms = placed.flatMap((x, n) => (x === xs[at[n]] && ctx.atomsOf ? ctx.atomsOf(x) : [x]))
      if (trigBus != null && trigBus !== orbit) {
        ctx.sideTo?.(trigBus, key)
        if (d.hear === 'audible') ctx.toSpeakers?.(trigBus)
        else if (!ctx.inputFans?.[ti]) ctx.unheard?.(trigBus)
        ctx.setAtoms?.([...soundAtoms, ...(ctx.atomsOf ? ctx.atomsOf(trigger) : [trigger])])
        return `stack(${[...placed, trigger].join(', ')})`
      }
      // Straight from an instrument (no bus yet): a copy on a bus of its own feeds the input;
      // on an instance of its own, so a one-voice instrument (the kick synth) isn't cut by it
      const keyOrbit = ctx.stereoOrbit(`sckey:${ctx.nodeId}`)
      ctx.sideTo?.(keyOrbit, key)
      if (d.hear === 'audible') ctx.toSpeakers?.(keyOrbit)
      else ctx.unheard?.(keyOrbit)
      const trig = `${trigger}.fmap((v) => ({ ...v, _r: 'sc.${ctx.nodeId}' })).orbit(${keyOrbit})`
      const trigVar = own && ctx.define ? ctx.define('trigger', trig) : trig
      ctx.setAtoms?.([...soundAtoms, trigVar])
      return `stack(${[...placed, trigVar].join(', ')})`
    },
  },
  eq3: {
    group: 'mixing', cat: 'filter', label: '3-band eq', blurb: 'Boost or cut lows, mids and highs on the sound going through it',
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
    group: 'mixing', cat: 'drive', label: 'saturator', blurb: 'Warmth and grit: rounds off peaks and adds harmonics',
    inputs: 1,
    params: [
      { key: 'drive', type: 'knob', label: 'drive', min: 0, max: 4, def: 1.2 },
      { key: 'character', type: 'select', label: 'character', options: ['warm', 'tape', 'tube', 'asym', 'harmonics', 'fold'], def: 'tape' },
      { key: 'out', type: 'knob', label: 'output', min: 0.05, max: 1, def: 0.8, fmt: 'gain' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    // on the summed bus, like a mixer insert (see stereo.js)
    code: stereoCode('shaper', (d) => ({ drive: d.drive, out: d.out, curve: SATURATION[d.character] ?? 'soft' })),
  },
  distortion: {
    group: 'effect', cat: 'drive', label: 'distortion', blurb: 'A pedal: drive it, bias it, and shape what goes in and comes out',
    inputs: 1,
    params: [
      { key: 'drive', type: 'knob', label: 'drive', min: 0, max: 1, def: 0.45 },
      { key: 'mode', type: 'select', label: 'pedal', options: ['overdrive', 'crunch', 'rat', 'fuzz', 'octave'], def: 'overdrive' },
      { key: 'tighten', type: 'knob', label: 'tighten', min: 0, max: 1, def: 0.15 },
      { key: 'tone', type: 'knob', label: 'tone', min: 0, max: 1, def: 0.55 },
      { key: 'bias', type: 'knob', label: 'bias', min: 0, max: 1, def: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
      { key: 'out', type: 'knob', label: 'output', min: 0.05, max: 1, def: 0.8, fmt: 'gain' },
    ],
    code: stereoCode('dist', (d) => ({
      drive: d.drive, mode: d.mode, tighten: d.tighten, tone: d.tone, bias: d.bias, mix: d.mix, out: d.out,
    })),
  },
  clipper: {
    group: 'mixing', cat: 'drive', label: 'hard clip', blurb: 'Cuts peaks off flat: loud, aggressive, and it bites',
    inputs: 1,
    params: [
      { key: 'push', type: 'knob', label: 'push', min: 0, max: 3, def: 0.6 },
      { key: 'ceiling', type: 'knob', label: 'output', min: 0.1, max: 1, def: 0.9, fmt: 'gain' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('shaper', (d) => ({ drive: d.push, out: d.ceiling, curve: 'hard' })),
  },
  softclip: {
    group: 'mixing', cat: 'drive', label: 'soft clip', blurb: 'Rounds peaks into the ceiling instead of cutting them flat',
    inputs: 1,
    params: [
      { key: 'push', type: 'knob', label: 'push', min: 0, max: 3, def: 0.5 },
      { key: 'knee', type: 'select', label: 'knee', options: ['round', 'smooth', 'cubic'], def: 'round' },
      { key: 'ceiling', type: 'knob', label: 'output', min: 0.1, max: 1, def: 0.95, fmt: 'gain' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    code: stereoCode('shaper', (d) => ({ drive: d.push, out: d.ceiling, curve: KNEES[d.knee] ?? 'scurve' })),
  },
  compressor: {
    group: 'mixing', cat: 'dynamics', label: 'compressor', blurb: 'Evens out the level: loud parts get turned down',
    inputs: 1,
    params: [
      { key: 'threshold', type: 'knob', label: 'thresh', min: -60, max: 0, def: -18, unit: 'db' },
      { key: 'ratio', type: 'knob', label: 'ratio', min: 1, max: 20, def: 4, log: true, unit: 'ratio' },
      { key: 'attack', type: 'knob', label: 'attack', min: 0.001, max: 0.2, def: 0.01, log: true, unit: 's' },
      { key: 'release', type: 'knob', label: 'release', min: 0.02, max: 1, def: 0.15, log: true, unit: 's' },
      { key: 'knee', type: 'knob', label: 'knee', min: 0, max: 30, def: 6, unit: 'db' },
      { key: 'makeup', type: 'knob', label: 'makeup', min: 0, max: 18, def: 3, unit: 'db', origin: 0 },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
    ],
    // across the whole bus, so it hears the parts together (see stereo.js)
    code: stereoCode('comp', (d) => ({ threshold: d.threshold, ratio: d.ratio, knee: d.knee, attack: d.attack, release: d.release, makeup: d.makeup })),
  },
  limiter: {
    group: 'mixing', cat: 'dynamics', label: 'limiter', blurb: 'Pushes the level up to a ceiling nothing gets past: loud, clean, last on the master',
    inputs: 1,
    params: [
      { key: 'gain', type: 'knob', label: 'gain', min: -6, max: 24, def: 0, unit: 'db', origin: 0 },
      { key: 'ceiling', type: 'knob', label: 'ceiling', min: -12, max: 0, def: -0.3, unit: 'db' },
      { key: 'release', type: 'knob', label: 'release', min: 0.005, max: 1, def: 0.08, log: true, unit: 's' },
    ],
    // across the whole bus, looking a few milliseconds ahead (see stereo.js)
    code: stereoCode('limiter', (d) => ({ gain: d.gain, ceiling: d.ceiling, release: d.release })),
  },
  punch: {
    group: 'mixing', cat: 'dynamics', label: 'transient shaper', codeLabel: 'transient', blurb: 'More or less snap at the start of each hit, and more or less tail',
    inputs: 1,
    params: [
      { key: 'attack', type: 'knob', label: 'snap', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 },
      { key: 'sustain', type: 'knob', label: 'tail', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 },
    ],
    code: (d, [x], ctx) => fmapWith(x, ctx, d, ['attack', 'sustain'], (val) =>
      `{ ...v, transient: Math.min(1, Math.max(-1, (v.transient ?? 0) + ${val('attack')})), transsustain: Math.min(1, Math.max(-1, (v.transsustain ?? 0) + ${val('sustain')})) }`),
  },

  haas: {
    group: 'mixing', cat: 'stereo', label: 'haas', blurb: 'Delay one ear by a few milliseconds: a mono sound opens up wide',
    inputs: 1,
    params: [
      { key: 'time', type: 'knob', label: 'time', min: 0.001, max: 0.04, def: 0.015, unit: 's' },
      { key: 'mix', type: 'knob', label: 'mix', min: 0, max: 1, def: 1 },
      { key: 'side', type: 'select', label: 'delay', options: ['right', 'left'], def: 'right' },
    ],
    code: stereoCode('haas', (d) => ({ time: d.time, mix: d.mix, side: d.side })),
  },
  widener: {
    group: 'mixing', cat: 'stereo', label: 'stereo widener', blurb: 'Wider stereo image, with the low end kept in the middle',
    inputs: 1,
    params: [
      { key: 'width', type: 'knob', label: 'width', min: 0, max: 2, def: 1.5, unit: 'x', origin: 1 },
      { key: 'spread', type: 'knob', label: 'spread', min: 0, max: 1, def: 0.35 },
      { key: 'mono', type: 'knob', label: 'mono below', min: 20, max: 500, def: 120, log: true, unit: 'hz' },
    ],
    code: stereoCode('widener', (d) => ({ width: d.width, spread: d.spread, mono: d.mono })),
  },
  utility: {
    group: 'mixing', cat: 'stereo', label: 'utility', blurb: 'The plain jobs: gain, mono or width, balance, swap or pick a side, flip the phase',
    inputs: 1,
    params: [
      { key: 'gain', type: 'knob', label: 'gain', min: -36, max: 24, def: 0, unit: 'db', origin: 0 },
      { key: 'width', type: 'knob', label: 'width', min: 0, max: 2, def: 1, unit: 'x', origin: 1 },
      { key: 'pan', type: 'knob', label: 'balance', min: 0, max: 1, def: 0.5 },
      { key: 'channels', type: 'select', label: 'channels', options: ['stereo', 'mono', 'left only', 'right only', 'swap'], def: 'stereo' },
      { key: 'phase', type: 'select', label: 'phase', options: ['normal', 'flip left', 'flip right', 'flip both'], def: 'normal' },
    ],
    // on the summed bus, like a mixer channel's utility (see stereo.js)
    code: stereoCode('utility', (d) => ({ gain: d.gain, width: d.width, pan: d.pan, channels: d.channels, phase: d.phase })),
  },

  fxrack: {
    group: 'effect', cat: 'rack', label: 'fx rack', blurb: 'Several effects in one box, applied top to bottom',
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
    group: 'combine', label: 'mixer bus', blurb: 'Route several sounds into one track: a fader a channel, then level, pan and effects on them all',
    inputs: 'many',
    params: [
      { key: 'name', type: 'text', label: 'name', def: 'bus' },
      { key: 'vol', type: 'knob', label: 'vol', min: 0, max: 1.5, def: 1, fmt: 'gain' },
      { key: 'pan', type: 'knob', label: 'pan', min: 0, max: 1, def: 0.5 },
    ],
    // Like a mixer insert: everything wired in plays on one audio bus (an orbit), so reverb,
    // delay, stereo effects and sidechain ducking after it treat the group as one sound.
    // A sound that already has a bus of its own (a haas, a sidechain) keeps it, and the app
    // plays that bus into this one. Level and pan act on the summed sound, live.
    code: (d, xs, ctx) => {
      if (!xs.length || !ctx?.route) return xs.length ? `stack(${xs.join(', ')})` : null
      const orbit = ctx.stereoOrbit(ctx.nodeId)
      const seen = new Set()
      const parts = xs.map((x, i) => {
        const from = ctx.inputOrbits?.[i]
        const fader = channelGain(d, ctx.inputKeys?.[i])
        // a channel that carries its own bus is turned down where it plays into this one,
        // after its own effects, the way a mixer's fader sits after its inserts
        if (from == null) { const own = ctx.ownPath ? ctx.ownPath(x, i, orbit) : x; return `${fader === 1 ? own : `${own}.mul(gain(${tidy(fader)}))`}.orbit(${orbit})` }
        if (from !== orbit) ctx.routeBus(from, orbit, fader)
        // two branches of one split bus bring the same notes: they play once, and each
        // branch is heard through its own route
        return ctx.takeNew ? ctx.takeNew(x, seen) : x
      }).filter(Boolean)
      ctx.setAtoms?.(parts.flatMap((x) => (ctx.atomsOf ? ctx.atomsOf(x) : [x])))
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
  stream: {
    group: 'output', label: 'stream', blurb: 'What you hear, as data over a websocket: every hit, the spectrum and the energy, for TouchDesigner, Max or an agent',
    inputs: 1, // only ever the output's wire: it listens to the master, it doesn't play
    params: [
      { key: 'rate', type: 'select', label: 'frames/s', options: ['15', '30', '60'], def: '60' },
      { key: 'bins', type: 'select', label: 'spectrum', options: ['16', '32', '64'], def: '64' },
      // the sound itself, lossless (about 1.5 Mbit/s): off unless asked
      { key: 'audio', type: 'select', label: 'audio', options: ['off', 'on'], def: 'off' },
    ],
    code: () => null,
  },
}

const CODE_MAX = 100_000
const TEMPO_CALLS = new Set(['setcpm', 'setCpm', 'setcps', 'setCps'])
const codeCache = new Map()

/**
 * What a code node plays. One pattern (`s("bd sd")`) is used as it is. A whole script (the
 * consts, sliders and helpers a pasted song comes with) runs inside a function of its own
 * and plays its last pattern, or its `$:` parts stacked, so its names can't clash with the
 * rest of the patch. The track sets the tempo, so the script's own setcpm/setcps is left
 * out. Code that doesn't parse, or throws while it runs, plays nothing instead of
 * stopping the whole track.
 */
export function codeNodeExpr(raw) {
  const src = String(raw ?? '').trim()
  if (!src) return null
  if (codeCache.has(src)) return codeCache.get(src)
  const out = compileCodeNode(src)
  if (codeCache.size > 50) codeCache.delete(codeCache.keys().next().value)
  codeCache.set(src, out)
  return out
}

function compileCodeNode(src) {
  let ast
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch (e) {
    return `(silence /* code node: mistake on line ${e.loc?.line ?? '?'} */)`
  }
  const body = ast.body
  const text = (n) => src.slice(n.start, n.end)
  const only = body.length === 1 && body[0].type === 'ExpressionStatement' ? body[0] : null
  if (only) return `(${text(only.expression)})`
  const stmts = []
  const parts = []
  let last = null
  for (const n of body) {
    const call = n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' ? n.expression : null
    if (call?.callee.type === 'Identifier' && TEMPO_CALLS.has(call.callee.name)) continue
    if (n.type === 'LabeledStatement') {
      const muted = /^_|_$/.test(n.label.name)
      if (!muted) parts.push(text(n.body).replace(/;\s*$/, ''))
      continue
    }
    // setup like `await samples(…)` can't wait in here: it loads, and plays once it has
    if (n.type === 'ExpressionStatement' && n.expression.type === 'AwaitExpression') {
      stmts.push(`${text(n.expression.argument)};`)
      last = null
      continue
    }
    if (n.type === 'ExpressionStatement') last = text(n.expression)
    else last = null
    stmts.push(text(n))
  }
  let result = 'silence'
  if (parts.length) result = parts.length === 1 ? parts[0] : `stack(${parts.join(', ')})`
  else if (last != null) { stmts.pop(); result = last }
  return `(() => { try {\n${stmts.join('\n')}\nreturn (${result})\n} catch (e) { console.warn('code node:', e); return silence } })()`
}

/**
 * Haas and widener process the audio bus ("orbit") a sound plays on (see stereo.js). The
 * code puts the sound on a bus of its own, unless it's already on one, and the app
 * processes that bus.
 */
function stereoCode(kind, raw) {
  // a node with a mix knob hands it on, whatever its own settings say (see stereo.js MIXED)
  const params = (d) => { const p = raw(d); return d && d.mix != null && !('mix' in p) ? { ...p, mix: d.mix } : p }
  const code = (d, [x], ctx) => {
    if (!ctx?.route) return x
    let tail = ''
    let notes = x
    if (ctx.route.orbit == null) {
      ctx.route.orbit = ctx.stereoOrbit(ctx.nodeId)
      tail = `.orbit(${ctx.route.orbit})`
      notes = ctx.ownPath ? ctx.ownPath(x, 0, ctx.route.orbit) : x
    }
    ctx.declare(ctx.route.orbit, ctx.nodeId, kind, params(d))
    return `${notes}${tail}`
  }
  // what it is on the bus, for anything that makes these units itself (instrument lanes)
  code.insert = { kind, params }
  return code
}
/** Reverb and delay: sends on each note, or inserts on a bus when the sound is on one (spaceOnBus). */
const SPACE_TYPES = new Set(['reverb', 'delay', 'space'])
const STEREO_TYPES = new Set(['haas', 'widener', 'utility', 'bus', 'eq3', 'saturator', 'distortion', 'clipper', 'softclip', 'compressor', 'limiter',
  'filter', 'djfilter', 'level', 'drive', 'phaser', 'chorus', 'flanger', 'tremolo', 'vowel', 'lofi', 'bitcrush', 'granulizer', 'wook', 'ringmod', 'pitch', 'freqshift'])

/**
 * Nodes that are real audio on a bus rather than settings on each note: they work on
 * everything mixed into them, like a mixer insert or a send, and they run after every
 * per-note effect in the patch whatever order the wires are in.
 */
export const BUS_NODES = new Set([...STEREO_TYPES, 'reverb', 'delay'])

/** Effects that can sit inside an fx rack: every plain effect node. */
export const FX_UNITS = ['eq3', 'compressor', 'limiter', 'saturator', 'distortion', 'clipper', 'softclip', 'punch', 'haas', 'widener', 'utility', 'filter', 'djfilter', 'reverb', 'delay', 'space', 'level', 'drive', 'phaser', 'chorus', 'flanger', 'tremolo', 'vowel', 'lofi', 'bitcrush', 'granulizer', 'wook', 'ringmod', 'pitch', 'freqshift']

/**
 * Effects an instrument's lane can stack: the ones that are real audio on a bus. Reverb and
 * delay are sends here, so a lane wraps them with a dry path (instruments/laneFx.js).
 */
export const LANE_FX = FX_UNITS.filter((t) => t === 'reverb' || t === 'delay' || NODE_TYPES[t]?.code?.insert)

/** A lane effect's settings for its unit (reverb and delay need the tempo: `beatSeconds`). */
export function laneFxParams(type, d, { beatSeconds: beat = 0.5 } = {}) {
  if (type === 'reverb') return { mix: d.mix, size: d.size, predelay: d.predelay, tone: d.tone, lowcut: d.lowcut, width: d.width }
  if (type === 'delay') return { mix: d.mix, seconds: (DELAY_DIVISIONS[d.time] ?? 0.75) * beat, feedback: d.feedback, tone: d.tone, mode: d.mode }
  return NODE_TYPES[type]?.code?.insert?.params(d) ?? {}
}

/** Where a wire came from, as a mixer bus names its channels. */
export const inputKey = (edge) => `${edge.source}:${edge.sourceHandle ?? 'out'}`
/** A mixer bus's fader for one channel (1 when it hasn't been touched). */
export const channelGain = (data, key) => clampNum(key ? data?.chan?.[key] : 1, 1, 0, 1.5)
/** The fader knob a mixer bus gives each channel. */
export const CHANNEL_FADER = { key: 'chan', type: 'knob', label: 'level', min: 0, max: 1.5, def: 1, fmt: 'gain' }

/** Saturator characters → Strudel's waveshaping curves. */
const SATURATION = { warm: 'scurve', tape: 'soft', tube: 'diode', asym: 'asym', harmonics: 'chebyshev', fold: 'fold' }

/** Clean one node type's data against its params. */
export function cleanData(type, raw) {
  const spec = NODE_TYPES[type]
  const data = { ...defaultData(type) }
  for (const p of spec.params) {
    const v = raw?.[p.key]
    if (v === undefined) continue
    if (p.type === 'knob' || p.type === 'int') data[p.key] = clampNum(v, p.def, p.min, p.max)
    if (p.type === 'int') data[p.key] = Math.round(data[p.key])
    if (p.type === 'select') data[p.key] = p.options.includes(v) ? v : p.def
    if (['text', 'mini', 'sound', 'code', 'kit'].includes(p.type)) data[p.key] = String(v).slice(0, p.type === 'code' ? CODE_MAX : 400)
  }
  return data
}

/** A new effect unit for an fx rack. */
export function makeFxUnit(type, id) {
  return { id, type, on: true, data: defaultData(type) }
}

/**
 * The add menu's groups. A node's `group` stays what the patch runs on (its colour, how it
 * wires); the menu files things where someone would look for them: the rhythm machines
 * apart from the plain sources, mixing tools in with the effects (sorted by `cat`), and a
 * subheading (MENU_SUBS) inside the groups that would otherwise be one long list.
 */
export const GROUPS = [
  ['source', 'sources'],
  ['machine', 'generators'],
  ['transform', 'pattern tools'],
  ['effect', 'effects'],
  ['combine', 'mix & arrange'],
  ['output', 'output'],
]

/** What each effect does, in the order the menus list them (the add menu, racks, lanes). */
export const FX_CATS = [
  ['filter', 'eq & filter'],
  ['dynamics', 'dynamics'],
  ['drive', 'drive & distortion'],
  ['texture', 'lo-fi & texture'],
  ['space', 'reverb & delay'],
  ['mod', 'modulation'],
  ['pitch', 'pitch & frequency'],
  ['stereo', 'stereo & utility'],
  ['rack', 'racks'],
]

/** Subheadings for the add menu's groups that aren't effects, in order. */
export const MENU_SUBS = [
  ['timing', 'timing', ['fast', 'every']],
  ['rhythm', 'rhythm', ['euclid', 'shape', 'echo']],
  ['chance', 'chance', ['sometimes', 'thin']],
  ['notes', 'notes', ['transpose']],
  ['mix', 'mixing', ['bus', 'stack']],
  ['song', 'song structure', ['sequence', 'arrange']],
]

/** Which add-menu group a node type is filed under. */
export function menuGroup(type) {
  const spec = NODE_TYPES[type]
  if (!spec) return null
  if (spec.abstract) return 'machine'
  return spec.group === 'mixing' ? 'effect' : spec.group
}

/**
 * Effect types, menu order: by category, then as listed. Hidden ones (older duplicates that
 * saved tracks still use) are left out unless asked for.
 */
export function effectsByCat({ hidden = false, only = null } = {}) {
  const cats = FX_CATS.map(([key]) => key)
  return Object.keys(NODE_TYPES)
    .filter((t) => NODE_TYPES[t].cat && (hidden || !NODE_TYPES[t].hidden) && (!only || only.includes(t)))
    .sort((a, b) => cats.indexOf(NODE_TYPES[a].cat) - cats.indexOf(NODE_TYPES[b].cat))
}

export function defaultData(type) {
  const spec = NODE_TYPES[type]
  const data = Object.fromEntries((spec?.params ?? []).map((p) => [p.key, p.def]))
  // an abstract instrument keeps everything it is in `state`
  if (spec?.abstract) data.state = packState(type, abstractOf(type).normalize(null))
  return data
}

const slotIndex = (handle) => {
  const m = /^in-(\d+)$/.exec(String(handle ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * Triggers. A rhythm machine (the cube, fibonacci…) says when; an instrument says what. A
 * layer's trigger port (`trig-<layer>`) wires into an instrument's trigger port on a pattern
 * node (`trig-<channel>`), and while it's wired that instrument plays on the layer's rhythm
 * instead of its own steps; its sound goes on from the pattern node like any other.
 */
export const triggerOf = (handle) => /^trig-([\w-]{1,40})$/.exec(String(handle ?? ''))?.[1] ?? null
export const isTrigger = (e) => !!triggerOf(e?.sourceHandle)

/**
 * Tracks made before triggers wired sounds *into* a machine's layers, and the machine's out
 * on to the effects. Turned round: each layer triggers the instruments that were wired into
 * it, and those patterns take the machine's place on its outgoing wires (several into one
 * input get a stack between). The machine keeps its out for the layers that still play their
 * own sound. Runs on every load; once turned round there's nothing left for it to do.
 */
function machinesToTriggers(nodes, byId, rawEdges, channelsIn) {
  const into = rawEdges.filter((e) => NODE_TYPES[byId.get(String(e?.target))?.type]?.abstract && /^in-\d+$/.test(String(e?.targetHandle)))
  if (!into.length) return rawEdges
  let out = rawEdges.filter((e) => !into.includes(e))
  const machines = new Set(into.map((e) => String(e.target)))
  for (const mid of machines) {
    const machine = byId.get(mid)
    const parts = abstractParts(machine)
    const fedLayers = new Set()
    const feeders = [] // [{ source, handle, layers }]: the patterns that played through it
    for (const e of into.filter((x) => String(x.target) === mid)) {
      const layer = parts[slotIndex(e.targetHandle)]
      const src = byId.get(String(e.source))
      if (!layer || src?.type !== 'pattern') continue // only an instrument can take a trigger
      const chan = outChannel(e.sourceHandle)
      const all = channelsIn(src.data.patternId) ?? []
      const chans = chan ? [chan] : all.filter((c) => !src.data.offMain?.[c.id]).map((c) => c.id)
      for (const c of chans) out.push({ source: mid, sourceHandle: `trig-${layer.id}`, target: src.id, targetHandle: `trig-${c}` })
      fedLayers.add(layer.id)
      let f = feeders.find((x) => x.source === src.id)
      if (!f) feeders.push(f = { source: src.id, chans: new Set(), wasOut: rawEdges.some((x) => String(x.source) === src.id && !outChannel(x.sourceHandle) && x !== e) })
      chans.forEach((c) => f.chans.add(c))
    }
    // a pattern now carries its triggered instruments out of its main port; what else it
    // has stays off that port if the port wasn't wired before (it wasn't heard then either)
    for (const f of feeders) {
      const node = byId.get(f.source)
      for (const c of channelsIn(node.data.patternId) ?? []) {
        if (f.chans.has(c.id)) { if (node.data.offMain) delete node.data.offMain[c.id] } else if (!f.wasOut) node.data.offMain = { ...(node.data.offMain ?? {}), [c.id]: true }
      }
      if (node.data.offMain && !Object.keys(node.data.offMain).length) delete node.data.offMain
    }
    const ownLeft = parts.some((p) => p.expr && !fedLayers.has(p.id))
    const outs = out.filter((e) => String(e.source) === mid && !triggerOf(e.sourceHandle))
    out = out.filter((e) => !outs.includes(e))
    outs.forEach((e, k) => {
      const layer = outChannel(e.sourceHandle)
      const mine = feeders.filter((f) => !layer || into.some((x) => String(x.source) === f.source && String(x.target) === mid && parts[slotIndex(x.targetHandle)]?.id === layer))
      const from = [...mine.map((f) => ({ source: f.source, sourceHandle: 'out' })), ...(ownLeft && !(layer && fedLayers.has(layer)) ? [{ source: mid, sourceHandle: e.sourceHandle ?? 'out' }] : [])]
      const target = byId.get(String(e.target))
      const tspec = NODE_TYPES[target?.type]
      const many = tspec?.inputs === 'many' || tspec?.many?.includes(e.targetHandle)
      if (from.length <= 1 || many) {
        // a many-input node: the first takes the machine's old slot, the rest the next free ones
        const first = e.targetHandle
        const used = () => Math.max(-1, ...out.filter((x) => String(x.target) === String(e.target)).map((x) => slotIndex(x.targetHandle)), slotIndex(first))
        if (tspec?.inputs === 'many') {
          from.forEach((f, i) => out.push({ ...f, target: e.target, targetHandle: i === 0 ? first : `in-${used() + 1}` }))
          return
        }
        for (const f of from) out.push({ ...f, target: e.target, targetHandle: e.targetHandle })
        return
      }
      const sid = `stack${mid.slice(-6)}${k || ''}`.replace(/\W/g, '')
      if (!byId.has(sid)) {
        const n = { id: sid, type: 'stack', x: machine.x + 40, y: machine.y + 260, data: defaultData('stack') }
        nodes.push(n)
        byId.set(sid, n)
      }
      from.forEach((f, i) => out.push({ ...f, target: sid, targetHandle: `in-${i}` }))
      out.push({ source: sid, sourceHandle: 'out', target: e.target, targetHandle: e.targetHandle })
    })
  }
  return out
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
    if (n.type === 'pattern') {
      data.patternId = patternIds.has(n.data?.patternId) ? n.data.patternId : [...patternIds][0] ?? null
      data.offMain = Object.fromEntries(Object.entries(n.data?.offMain ?? {}).filter(([, v]) => v === true))
    }
    // a mixer bus's channel faders, one per input (see inputKey), aren't among its params
    if (n.type === 'bus') {
      const chan = Object.entries(n.data?.chan ?? {}).filter(([k, v]) => /^\w{1,64}:out(-[\w-]{1,40})?$/.test(k) && Number.isFinite(v))
      if (chan.length) data.chan = Object.fromEntries(chan.map(([k, v]) => [k, clampNum(v, 1, 0, 1.5)]))
    }
    if (spec.abstract) {
      data.state = packState(n.type, abstractOf(n.type).normalize(n.data?.state))
      const ids = new Set(abstractParts({ type: n.type, data }).map((p) => p.id))
      const off = Object.entries(n.data?.offMain ?? {}).filter(([k, v]) => v === true && ids.has(k))
      if (off.length) data.offMain = Object.fromEntries(off)
    }
    if (n.type === 'arrange') data.bars = Object.fromEntries(Object.entries(n.data?.bars ?? {}).filter(([k]) => /^in-\d+$/.test(k)).map(([k, v]) => [k, Math.round(clampNum(v, 4, 1, 64))]))
    if (n.type === 'output') {
      data.muted = Object.fromEntries(Object.entries(n.data?.muted ?? {}).filter(([, v]) => v === true))
      // (a solo used to be kept here; it belongs to whoever is listening now, so it isn't
      // saved with the track any more — App picks up an old one as your own when you open it)
    }
    if (typeof n.data?.name === 'string' && n.data.name.trim()) data.name = n.data.name.slice(0, 40)
    if (n.type !== 'output' && n.data?.mute === true) data.mute = true
    if (n.data?.bypass === true) data.bypass = true
    nodes.push({ id, type: n.type, x: Math.round(clampNum(n.x, 0, -20000, 20000)), y: Math.round(clampNum(n.y, 0, -20000, 20000)), data })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = []
  const taken = new Set()
  const rawEdges = machinesToTriggers(nodes, byId, Array.isArray(raw?.edges) ? raw.edges : [], channelsIn)
  for (const e of rawEdges) {
    const source = byId.get(String(e?.source))
    const target = byId.get(String(e?.target))
    if (!source || !target || source.id === target.id) continue
    // a trigger: a rhythm machine's layer into one instrument of a pattern (see triggerOf)
    const fromLayer = triggerOf(e?.sourceHandle)
    const toChan = triggerOf(e?.targetHandle)
    if (fromLayer || toChan) {
      if (!fromLayer || !toChan || !NODE_TYPES[source.type]?.abstract || target.type !== 'pattern') continue
      if (!abstractParts(source).some((p) => p.id === fromLayer)) continue
      const chans = channelsIn(target.data.patternId)
      if (chans && !chans.some((c) => c.id === toChan)) continue
      const key = `trig:${source.id}:${fromLayer}:${target.id}:${toChan}`
      if (taken.has(key)) continue
      taken.add(key)
      edges.push({ id: `t_${source.id}_${fromLayer}_${target.id}_${toChan}`, source: source.id, sourceHandle: `trig-${fromLayer}`, target: target.id, targetHandle: `trig-${toChan}` })
      continue
    }
    const spec = NODE_TYPES[target.type]
    if (!spec.inputs) continue
    if ((source.type === 'output') !== (target.type === 'stream')) continue
    const handle = spec.inputs === 1 ? 'in' : `in-${slotIndex(e.targetHandle)}`
    if (Array.isArray(spec.inputs) && slotIndex(e.targetHandle) >= spec.inputs.length) continue
    // a wire can leave a pattern node by one instrument's port instead of its main out;
    // when that instrument is gone the wire goes with it
    const split = source.type === 'pattern' || NODE_TYPES[source.type]?.abstract
    const chan = split && /^out-[\w-]{1,40}$/.test(String(e?.sourceHandle)) ? e.sourceHandle.slice(4) : null
    // (an abstract instrument's parts are its own, so they're always known)
    const known = chan && (source.type === 'pattern' ? channelsIn(source.data.patternId) : abstractParts(source))
    if (chan && known && !known.some((c) => c.id === chan)) continue
    const from = chan ? `out-${chan}` : 'out'
    // one wire per input slot, unless the node says that input takes as many as you give
    // it (a sidechain's sound side) — there, one wire per thing feeding it
    const key = spec.many?.includes(handle)
      ? `${target.id}:${handle}:${source.id}:${from}`
      : `${target.id}:${handle}`
    if (taken.has(key)) continue
    taken.add(key)
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
/**
 * The instruments (or machine layers) a node holds back from its main out. "main off" only
 * holds while the instrument is wired out on its own port: unwire it and it's back on the
 * main, so a sound never ends up going nowhere.
 */
export function offMainOf(node, edges) {
  return new Set(Object.entries(node?.data?.offMain ?? {})
    .filter(([k, v]) => v === true && edges.some((e) => e.source === node.id && outChannel(e.sourceHandle) === k))
    .map(([k]) => k))
}

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
 * A node's line, for soloing it: every wire that feeds it (all the way back), every wire on
 * from it that reaches an output, and what triggers any sidechain on the way, so it still
 * ducks. { nodes: Set(id), edges: Set(edge) }, or null when there's no such node.
 */
export function lineOf(project, id) {
  const byId = new Map(project.nodes.map((n) => [n.id, n]))
  if (!byId.has(id)) return null
  const edges = project.edges.filter((e) => !isTrigger(e) && byId.has(e.source) && byId.has(e.target))
  const into = (n) => edges.filter((e) => e.target === n)
  const outOf = (n) => edges.filter((e) => e.source === n)
  const keep = new Set()
  const nodes = new Set([id])
  const upFrom = (start) => {
    const todo = [start]
    while (todo.length) {
      const n = todo.pop()
      for (const e of into(n)) {
        if (keep.has(e)) continue
        keep.add(e)
        if (!nodes.has(e.source)) { nodes.add(e.source); todo.push(e.source) }
      }
    }
  }
  upFrom(id)
  // on from it: only the way to an output (a wire into a dead end isn't part of what's heard)
  const reaches = new Set(project.nodes.filter((n) => n.type === 'output').map((n) => n.id))
  for (let grew = true; grew;) {
    grew = false
    for (const e of edges) if (reaches.has(e.target) && !reaches.has(e.source)) { reaches.add(e.source); grew = true }
  }
  const down = [id]
  const seen = new Set([id])
  while (down.length) {
    const n = down.pop()
    for (const e of outOf(n)) {
      if (!reaches.has(e.target) && byId.get(e.target)?.type !== 'output') continue
      keep.add(e)
      nodes.add(e.target)
      if (!seen.has(e.target)) { seen.add(e.target); down.push(e.target) }
      // a sidechain on the way still needs what triggers it
      if (byId.get(e.target)?.type === 'sidechain') {
        for (const t of into(e.target).filter((w) => w.targetHandle === 'in-1')) { keep.add(t); nodes.add(t.source); upFrom(t.source) }
      }
    }
  }
  return { nodes, edges: keep }
}

/**
 * Code for the graph: one `const` per node that makes a pattern, in dependency order,
 * then one lane per wire into each output node. `solo` (a node id) plays only that node.
 */
export function graphCode(project, { solo = null, song = null, audition = false, auto = null, laneSolo = null, lineSolo = null } = {}) {
  const { nodes } = project
  // triggers carry rhythm, not sound: the patterns they fire make their own code (project.js)
  let edges = project.edges.filter((e) => !isTrigger(e))
  // soloing a line (alt + S): only its wires are followed, so nothing else is reached
  const line = lineSolo ? lineOf(project, lineSolo) : null
  if (line) edges = edges.filter((e) => line.edges.has(e))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const patternIds = new Set(project.patterns.map((p) => p.id))
  const exprs = new Map() // id → variable name, or null when the node makes nothing
  const lines = []
  const cps = (Number(project.bpm) || 140) / (Number(project.beats) || 4) / 60
  /*
   * Stereo inserts, branches and sidechains each get a bus, and its number comes from what
   * it's for (a node's id), not from where it is in the patch. Numbered by position, adding
   * or removing one effect (an fx rack's especially) moved every bus after it, and the
   * notes already scheduled — the next third of a second — landed on buses set up for
   * something else, often straight to the speakers: a burst of the unprocessed track.
   */
  const busFor = new Map()
  const busTaken = new Set()
  const stereoOrbit = (key) => {
    if (busFor.has(key)) return busFor.get(key)
    let h = 2166136261
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
    let orbit = STEREO_ORBIT_BASE + ((h >>> 0) % 900000)
    while (busTaken.has(orbit)) orbit++ // two keys landing together: the later one steps on
    busTaken.add(orbit)
    busFor.set(key, orbit)
    return orbit
  }
  // claim them in patch order, so if two ever do land together it's settled the same way each time
  for (const n of nodes) {
    if (STEREO_TYPES.has(n.type)) stereoOrbit(n.id)
    for (const u of n.data?.chain ?? []) if (STEREO_TYPES.has(u.type)) stereoOrbit(`${n.id}_${u.id}`)
  }
  const inserts = beginInserts()
  // reverbs and delays: the patch's own, and the shared pair the instruments' knobs send to
  const fx = beginFx()
  const beats = Number(project.beats) || 4
  declareFx(fx, GLOBAL_REVERB, 'reverb', { ...REVERB_DEFAULTS, mix: 1 })
  declareFx(fx, GLOBAL_DELAY, 'delay', { ...DELAY_DEFAULTS, mix: 1, feedback: 0.35, seconds: 0.75 / (cps * beats) })
  const declare = (orbit, key, kind, params) => declareInsert(inserts, orbit, key, kind, params)
  const routeBus = (from, to, gain) => declareRoute(inserts, from, to, gain)
  const orbitOf = new Map() // node id → the bus its sound ends up on, when not the main one
  // A node that passes its input on unchanged (an insert on a bus already there) plays the
  // same notes: `sameAs` maps it to the node that made them, so where two wires bring the
  // same notes back together (a dry and a wet branch into one mixer bus) they play once.
  const sameAs = new Map()
  const notesOf = (x) => sameAs.get(x) ?? x
  // What notes an expression plays, as the smallest pieces that can be told apart: a node
  // that only adds to what it was given (a sidechain adds its trigger) lists its input's
  // pieces and the new one, so a merge point can take only what it isn't playing already.
  const atomsMap = new Map()
  const atomsOf = (x) => atomsMap.get(x) ?? (sameAs.has(x) ? atomsOf(sameAs.get(x)) : [x])
  /** Of `x`'s notes, those not in `seen` (which takes them): `x` itself, a stack of the rest, or null. */
  const takeNew = (x, seen) => {
    const atoms = atomsOf(x)
    const fresh = atoms.filter((a) => !seen.has(a))
    for (const a of fresh) seen.add(a)
    if (!fresh.length) return null
    return fresh.length === atoms.length ? x : fresh.length === 1 ? fresh[0] : `stack(${fresh.join(', ')})`
  }
  const fanout = (id) => edges.filter((e) => e.source === id && byId.get(e.target)).length
  // A node whose sound is on a bus that something else also hears from (it's downstream of
  // a split, with nothing since giving it a bus of its own): anything that works on the bus
  // from here on needs a branch, or it would act on the other paths too.
  const sharedOf = new Map()
  const onShared = (src) => orbitOf.get(src) != null && (fanout(src) > 1 || !!sharedOf.get(src))
  const partVars = new Map() // `${node}:${part}` → an abstract instrument's part, wired out on its own
  const channelsOf = (pid) => project.patterns.find((p) => p.id === pid)?.channels ?? []
  /** What a wire carries: one instrument of a pattern, or everything the source node makes. */
  const carried = (w, name) => {
    const chan = outChannel(w.sourceHandle)
    if (!chan) return name
    const src = byId.get(w.source)
    if (partVars.has(`${w.source}:${chan}`)) return partVars.get(`${w.source}:${chan}`)
    if (src?.type !== 'pattern' || !channelsOf(src.data.patternId).some((c) => c.id === chan)) return name
    return fromNode(patternChanVar(src.data.patternId, chan), src.id)
  }

  const visit = (id, trail = new Set()) => {
    if (exprs.has(id)) return exprs.get(id)
    if (trail.has(id)) return null
    trail.add(id)
    const node = byId.get(id)
    const spec = node && NODE_TYPES[node.type]
    if (!spec || node.type === 'output' || node.type === 'stream') { exprs.set(id, null); return null }
    // muted (ctrl + M): it makes nothing, and nothing gets through it
    if (node.data?.mute === true) { exprs.set(id, null); return null }
    const wires = inputsOf(edges, id)
    const inputs = []
    const slots = []
    for (const w of wires) {
      const v = visit(w.source, trail)
      if (v) { inputs.push(carried(w, v)); slots.push(w.targetHandle) }
    }
    if (spec.inputs === 1 && !inputs.length) { exprs.set(id, null); return null }
    const inputOrbits = wires.filter((w) => exprs.get(w.source)).map((w) => orbitOf.get(w.source) ?? null)
    // what each input came from, so a mixer bus can keep a fader per channel
    const inputKeys = wires.filter((w) => exprs.get(w.source)).map((w) => inputKey(w))
    // a single input passes its bus on; mixing several inputs lands back on the main bus
    const route = { orbit: inputs.length === 1 && spec.inputs !== 'many' ? inputOrbits[0] : null }
    // Inserts on a bus act on the whole bus. When that bus also goes somewhere else (split
    // to a dry and a wet path), these inserts get a branch of their own, fed from it, so
    // they only touch the sound on this wire.
    const feeder = wires.find((w) => exprs.get(w.source))?.source
    // Bypassed (alt + B): what comes in goes straight out, untouched — for a sidechain, the
    // sounds it ducks; the trigger has nothing to do. Saved with the track, like a mute.
    if (node.data?.bypass === true && (spec.inputs === 1 || node.type === 'sidechain')) {
      const pass = inputs.map((x, i) => [x, inputOrbits[i], slots[i]]).filter(([, , slot]) => node.type !== 'sidechain' || slot === 'in-0')
      if (!pass.length) { exprs.set(id, null); return null }
      const name = nodeVar(id)
      if (pass.length === 1) {
        if (pass[0][1] != null) orbitOf.set(id, pass[0][1])
        sameAs.set(name, notesOf(pass[0][0]))
        if (feeder && onShared(feeder)) sharedOf.set(id, true)
      }
      lines.push(`// ${node.data.name ?? spec.codeLabel ?? spec.label} (bypassed)`, `const ${name} = ${pass.length === 1 ? pass[0][0] : `stack(${pass.map((p) => p[0]).join(', ')})`}`)
      exprs.set(id, name)
      return name
    }
    let shared = route.orbit != null && !!feeder && onShared(feeder)
    if (shared && (STEREO_TYPES.has(node.type) || SPACE_TYPES.has(node.type) || node.type === 'fxrack') && node.type !== 'bus') {
      const branch = stereoOrbit(`branch:${id}`)
      declareBranch(inserts, route.orbit, branch)
      route.orbit = branch
      shared = false
    }
    const inputShared = wires.filter((w) => exprs.get(w.source)).map((w) => onShared(w.source))
    // A sound that goes down more than one path: each path that puts it on a bus of its own
    // plays it on an instrument instance of its own (instruments/host.js `_r`). One instance
    // mixes its own lanes (Syrup's effect lanes) to one bus only, and would flip between the
    // paths note by note, so one path or the other went missing.
    const inputFans = wires.filter((w) => exprs.get(w.source)).map((w) => fanout(w.source) > 1)
    const ownPath = (x, i, orbit) => (inputFans[i] ? `${x}.fmap((v) => ({ ...v, _r: (v._r ? v._r + '|' : '') + 'o${orbit}' }))` : x)
    if (spec.abstract) {
      // a rhythm machine: its out plays the layers that make their own sound, when the song
      // says; a layer that triggers instruments plays through them instead (project.js)
      const gate = (e) => (song ? song(`node:${id}`, () => e) : e)
      const triggering = new Set(project.edges.filter((e) => e.source === id && isTrigger(e)).map((e) => triggerOf(e.sourceHandle)))
      const built = abstractBuild(node).map((p) => ({ ...p, expr: p.expr && !triggering.has(p.id) ? gate(p.expr) : null }))
      // a layer is held back from the main out only while it's wired out on its own port —
      // unwire it and it's back in the mix (its "main" button goes with the wire)
      const offMainIds = offMainOf(node, edges)
      const main = built.filter((p) => p.expr && !offMainIds.has(p.id)).map((p) => p.expr)
      const name = nodeVar(id)
      lines.push(`// ${node.data.name ?? spec.label}`, `const ${name} = ${fromMachine(main.length > 1 ? `stack(${main.join(', ')})` : main[0] ?? 'silence', id)}`)
      exprs.set(id, name)
      // layers wired out on their own ports: a line each
      for (const p of built) {
        if (!edges.some((e) => e.source === id && outChannel(e.sourceHandle) === p.id)) continue
        const pv = `${name}_${p.id}`
        lines.push(`const ${pv} = ${fromMachine(p.expr ?? 'silence', id)}`)
        partVars.set(`${id}:${p.id}`, pv)
      }
      return name
    }
    // a source making sound on its own plays when the song says (patterns are handled where
    // they're defined); its automations are marked in its code, to be read in song time
    // inside each clip (song.js)
    const songPart = song && spec.group === 'source' && node.type !== 'pattern' && !wires.length
    const nodeAuto = auto && songPart ? (target) => { const a = auto(target); return a && `\u0001${a}\u0001` } : auto
    const autoOf = nodeAuto ? (key) => nodeAuto(`n:${id}:${key}`) : null
    // Wiring an instrument's own port is a copy: it still goes out the main one as well,
    // because a wire shouldn't silently take a sound out of the mix. Taking it off the main
    // is a separate thing you ask for, instrument by instrument.
    const off = offMainOf(node, edges)
    const mixChannels = (pid) => (off.size
      ? channelsOf(pid).filter((c) => !off.has(c.id)).map((c) => patternChanVar(pid, c.id))
      : null)
    const define = (suffix, code) => { const v = `${nodeVar(id)}_${suffix}`; lines.push(`const ${v} = ${code}`); return v }
    let atoms = null // what notes it plays, when a node says (see atomsOf)
    const setAtoms = (list) => { atoms = list }
    const sideTo = (from, key) => declareSide(inserts, from, key)
    const toSpeakers = (orbit) => declareSpeakers(inserts, orbit)
    const unheard = (orbit) => declareQuiet(inserts, orbit)
    let expr = spec.code(node.data, inputs, { patternIds, mixChannels, slots, inputKeys, notesOf, atomsOf, takeNew, inputShared, ownPath, define, setAtoms, inputFans, unheard, nodeId: id, orbit: stereoOrbit(`scbus:${id}`), cps, beats, route, inputOrbits, stereoOrbit, declare, routeBus, sideTo, toSpeakers, auto: nodeAuto, autoOf, declareFx: (key, kind, params) => declareFx(fx, key, kind, params) })
    if (!expr) { exprs.set(id, null); return null }
    if (songPart) { const marked = expr; expr = song(`node:${id}`, (shift, read) => marked.replace(/\u0001(\w+)\u0001/g, (_, a) => read(a))) }
    if (spec.group === 'source') expr = fromNode(expr, id)
    if (route.orbit != null) orbitOf.set(id, route.orbit)
    // still on the bus it was handed, and that bus is shared: so is this node's sound
    if (route.orbit != null && shared && route.orbit === inputOrbits[0]) sharedOf.set(id, true)
    const name = nodeVar(id)
    if (inputs.length === 1 && expr === inputs[0] && route.orbit != null) sameAs.set(name, notesOf(inputs[0]))
    if (atoms) atomsMap.set(name, atoms)
    // `codeLabel` keeps a renamed node's comment as it was, so saved tracks make the same code
    lines.push(`// ${node.data.name ?? spec.codeLabel ?? spec.label}`, `const ${name} = ${expr}`)
    exprs.set(id, name)
    return name
  }

  const lanes = []
  if (solo && byId.has(solo)) {
    const v = visit(solo)
    if (v) lanes.push(`solo: ${v}`)
    if (v && orbitOf.get(solo) != null) declareSpeakers(inserts, orbitOf.get(solo))
  } else {
    for (const out of nodes.filter((n) => n.type === 'output')) {
      // soloing a lane is listening, not a decision about the track: it's whoever is at
      // this keyboard, so it never travels to the other people in the room (collab.js)
      const soloWire = laneSolo?.[out.id] ?? null
      const playing = new Set() // notes already on a lane (a split bus's branches carry the same ones)
      for (const w of inputsOf(edges, out.id)) {
        const v = visit(w.source)
        if (!v) continue
        const muted = out.data.muted?.[w.targetHandle] || (soloWire && soloWire !== w.targetHandle)
        const lane = `${out.id}_${w.targetHandle.replace('-', '')}`
        const bus = orbitOf.get(w.source)
        const what = carried(w, v)
        if (muted || bus == null || what !== v) { lanes.push(`${muted ? '_' : ''}${lane}: ${what}`); continue }
        // a bus on a lane is heard from the speakers even when it's also routed on
        declareSpeakers(inserts, bus)
        lanes.push(`${lane}: ${takeNew(v, playing) ?? 'silence'}`)
      }
    }
  }
  // an audition must not rewire the playing mix, nor put automated knobs back where they're set
  commitInserts(inserts, { partial: !!solo || audition, keep: audition })
  commitFx(fx, { partial: !!solo || audition, keep: audition })
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
