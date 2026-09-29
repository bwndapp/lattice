/**
 * An instrument's own knob following automation reads the curve in song time. The song
 * plays each clip of a pattern as the pattern moved `.late(start)` (song.js), and the
 * automation used to move along with it: a curve read from the clip's start, starting
 * again at each clip. Here the generated code is run with @strudel/core and every note's
 * cutoff is checked against the curve at that note's place in the song.
 */
import { bundle } from './lib/bundle.mjs'

const m = await bundle({
  'project.js': ['normalizeProject', 'generateCode', 'auditionCode'],
  'automation.js': ['autoValueFn'],
  // Strudel itself, from the same bundle (as the app has it) for the generated code to run on
  '../node_modules/@strudel/core': ['stack', 'signal', 's', 'silence', 'pure'],
  '../node_modules/@strudel/mini': ['miniAllStrings'],
}, 'autotime')
m.miniAllStrings() // the code's strings are mini-notation, as in the app
const core = { stack: m.stack, signal: m.signal, s: m.s, silence: m.silence, pure: m.pure }

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

/** A kick on every beat, its cutoff following a curve 60 → 20000 Hz over 8 bars. */
const project = (clips, autoClips) => m.normalizeProject({
  bpm: 120, beats: 4,
  patterns: [{ id: 'p1', name: 'p1', bars: 1, channels: [{ id: 'c1', kind: 'drum', sound: 'bd', steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], mute: false }] }],
  nodes: [{ id: 'a', type: 'pattern', x: 0, y: 0, data: { patternId: 'p1' } }, { id: 'out', type: 'output', x: 0, y: 0, data: {} }],
  edges: [{ id: 'e1', source: 'a', target: 'out', sourceHandle: 'out', targetHandle: 'in-1' }],
  song: {
    on: true,
    clips: [
      ...clips.map(([start, len, offset], i) => ({ id: `k${i}`, src: 'pattern:p1', lane: 0, start, len, ...(offset ? { offset } : {}) })),
      ...autoClips.map(([start, len], i) => ({ id: `u${i}`, src: 'auto:lp', lane: 1, start, len })),
    ],
    autos: [{ id: 'lp', target: 'c:p1:c1:lpf', bars: 8, points: [{ x: 0, y: 0 }, { x: 8, y: 1 }] }],
  },
})

/** The song's pattern, from running its code (the lanes stacked). */
const play = (code) => {
  const lanes = []
  const body = code.split('\n')
    .filter((l) => !l.startsWith('setcpm('))
    .map((l) => l.replace(/^(_?\w+): (.*)$/, (_, name, expr) => (name.startsWith('_') ? '' : `lanes.push(${expr})`)))
    .join('\n')
  new Function(...Object.keys(core), 'lanes', body)(...Object.values(core), lanes)
  return core.stack(...lanes)
}

/** Every note from bar `from` to `to` has the cutoff the curve has there; returns how many. */
const check = (name, p, from, to) => {
  const code = m.generateCode(p)
  const curve = m.autoValueFn(p, p.song.autos[0])
  const pattern = play(code)
  const haps = pattern.queryArc(from, to).filter((h) => h.hasOnset())
  const wrong = haps.filter((h) => {
    const t = h.whole.begin.valueOf()
    return !(Math.abs(h.value.cutoff - curve(t)) <= 1e-6 * curve(t)) // .lpf() sets `cutoff`
  })
  ok(`${name}: notes play (${haps.length})`, haps.length > 0)
  ok(`${name}: each note's cutoff is the curve's at its song time`, !wrong.length,
    wrong.slice(0, 3).map((h) => `bar ${h.whole.begin.valueOf()}: ${h.value.cutoff} not ${curve(h.whole.begin.valueOf())}`).join('; '))
  return code
}

// the report: both clips at bar 4, a curve over 8 bars; at bar 8 it's half way up (~1100 Hz)
const late = project([[4, 8]], [[4, 8]])
check('pattern and automation at bar 4', late, 4, 12)
const at8 = play(m.generateCode(late)).queryArc(8, 8.25).find((h) => h.hasOnset())
ok('at bar 8 the cutoff is about 1100 Hz, not 63', Math.abs(at8?.value.cutoff - 60 * (20000 / 60) ** 0.5) < 1, `${at8?.value.cutoff}`)

// at bar 0 nothing moves: the code is what it always was, the automation read as is
const zero = check('pattern and automation at bar 0', project([[0, 8]], [[0, 8]]), 0, 8)
ok('at bar 0 the signal is read unshifted', zero.includes('.lpf(a_lp)') && !zero.includes('.early('))

// a pattern used twice, at bars 2 and 7, under one automation clip across both
const twice = check('a pattern in clips at bars 2 and 7', project([[2, 3], [7, 4]], [[0, 12]]), 0, 12)
ok('each clip reads the curve shifted back by its own start', twice.includes('a_lp.early(2)') && twice.includes('a_lp.early(7)'))

// a clip starting part way into the pattern: its bar 1 falls before the clip does
check('a clip playing its pattern from 1 bar in', project([[5, 3, 1]], [[3, 8]]), 3, 11)

// clips at bar 0 and bar 4 together
check('clips at bars 0 and 4', project([[0, 2], [4, 4]], [[0, 8]]), 0, 8)

// a note heard in the piano roll while the song plays has the cutoff the curve has now,
// not the knob's own (the app passes where each automated knob is: autoLive.js `liveKnobs`)
{
  const p = project([[0, 8]], [[0, 8]])
  const heard = (live) => {
    const lines = m.auditionCode(p, 'p1', 'c1', { live }).split('\n')
    const body = `${lines.slice(0, -1).join('\n')}\nreturn ${lines.at(-1)}`
    return new Function(...Object.keys(core), body)(...Object.values(core)).queryArc(0, 1).find((h) => h.hasOnset())?.value
  }
  ok('a note heard with the song stopped has the knob\'s own cutoff', heard(new Map())?.cutoff === undefined, JSON.stringify(heard(new Map())))
  ok('a note heard while the song plays has the curve\'s cutoff', heard(new Map([['c:p1:c1:lpf', 1234]]))?.cutoff === 1234, JSON.stringify(heard(new Map([['c:p1:c1:lpf', 1234]]))))
}

console.log(`\n${fails ? `${fails} failing` : 'all good'}`)
process.exit(fails ? 1 : 0)
