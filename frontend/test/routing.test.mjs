/**
 * Routing is what the wires say. A mixer bus split two ways (one branch dry, one through a
 * reverb) and joined again plays each note once, and the reverb lives on its own branch,
 * so the dry branch never hears its tail. A reverb straight after a sound (no bus yet) is
 * still a send on each note.
 */
import { bundle } from './lib/bundle.mjs'

const m = await bundle({
  'project.js': ['generateCode', 'normalizeProject'],
  'stereo.js': ['declaredRouting'],
}, 'routing')

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ` — ${extra ?? ''}`))
  if (!cond) fails++
}

const drums = { id: 'pd', name: 'drums', bars: 1, stepsPerBar: 16, channels: [{ id: 'k', kind: 'drum', name: 'kick', sound: 'bd', bank: 'RolandTR909', steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], params: {} }] }
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data })
const edge = (source, target, targetHandle = 'in') => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle: 'out', target, targetHandle })

// drums → bus A, which splits: → saturator (dry) and → reverb → filter (wet), both → bus B → out
const split = m.normalizeProject({
  v: 3, bpm: 120, beats: 4, patterns: [drums],
  nodes: [
    node('out', 'output', { muted: {} }), node('pat', 'pattern', { patternId: 'pd' }),
    node('busA', 'bus', { name: 'a' }), node('dry', 'saturator'), node('verb', 'reverb', { mix: 0.5 }), node('flt', 'filter'),
    node('busB', 'bus', { name: 'b' }),
  ],
  edges: [edge('pat', 'busA', 'in-0'), edge('busA', 'dry'), edge('busA', 'verb'), edge('verb', 'flt'), edge('dry', 'busB', 'in-0'), edge('flt', 'busB', 'in-1'), edge('busB', 'out', 'in-0')],
  song: { on: false, clips: [] },
})
const code = m.generateCode(split)
const lane = code.split('\n').find((l) => l.startsWith('const n_busB'))
ok('a split bus joined again plays its notes once', lane && !/stack\(/.test(lane.split('=')[1]), lane)
ok('a reverb after a bus is not a send on the notes', !code.includes("['rv_verb'"))
const { inserts, routes } = m.declaredRouting()
const orbitOf = (key) => [...inserts].find(([, list]) => list.some((i) => i.key === key))?.[0]
const verbOrbit = orbitOf('rv_verb')
ok('the reverb is an insert on a bus', verbOrbit != null && inserts.get(verbOrbit).find((i) => i.key === 'rv_verb').kind === 'sendfx')
ok('the reverb and its filter share the wet branch', verbOrbit != null && verbOrbit === orbitOf('flt'))
ok('the dry branch is a different bus from the wet one', orbitOf('dry') != null && orbitOf('dry') !== verbOrbit)
ok('the reverb is not on the split bus itself', verbOrbit !== orbitOf('busA'))
ok('both branches are fed from the split bus', [orbitOf('dry'), verbOrbit].every((o) => routes.get(orbitOf('busA'))?.has(o)))

// a reverb straight on a pattern: a send on each note, as before
const plain = m.normalizeProject({
  v: 3, bpm: 120, beats: 4, patterns: [drums],
  nodes: [node('out', 'output', { muted: {} }), node('pat', 'pattern', { patternId: 'pd' }), node('verb', 'reverb', { mix: 0.5 })],
  edges: [edge('pat', 'verb'), edge('verb', 'out', 'in-0')],
  song: { on: false, clips: [] },
})
ok('a reverb before any bus is still a send', m.generateCode(plain).includes("['rv_verb'"))

const bass = { id: 'pb', name: 'bass', bars: 1, stepsPerBar: 16, channels: [{ id: 'b', kind: 'drum', name: 'bass', sound: 'bd', bank: 'RolandTR909', steps: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], params: {} }] }
const project = (nodes, edges) => m.normalizeProject({ v: 3, bpm: 120, beats: 4, patterns: [drums, bass], nodes: [node('out', 'output', { muted: {} }), ...nodes], edges, song: { on: false, clips: [] } })
const routing = (p) => { const code = m.generateCode(p); return { code, ...m.declaredRouting() } }
const orbitIn = (inserts, key) => [...inserts].find(([, list]) => list.some((i) => i.key === key))?.[0]
const lineOf = (code, v) => code.split('\n').find((l) => l.startsWith(`const ${v} =`)) ?? ''

// two sounds, each with its own insert, ducked by one sidechain
{
  const { code, inserts, routes } = routing(project(
    [node('d', 'pattern', { patternId: 'pd' }), node('b', 'pattern', { patternId: 'pb' }), node('hs', 'haas'), node('wd', 'widener'), node('sc', 'sidechain')],
    [edge('b', 'hs'), edge('d', 'wd'), edge('hs', 'sc', 'in-0'), edge('wd', 'sc', 'in-0'), edge('b', 'sc', 'in-1'), edge('sc', 'out', 'in-0')],
  ))
  const hs = orbitIn(inserts, 'hs'); const wd = orbitIn(inserts, 'wd')
  ok('two ducked sounds keep their own inserts', hs != null && wd != null && hs !== wd && !lineOf(code, 'n_sc').includes(`.orbit(${hs})`))
  const duck = orbitIn(inserts, 'sc_sc')
  ok('they play into the sidechain\'s own bus, which is the one ducked', duck != null && routes.get(hs)?.has(duck) && routes.get(wd)?.has(duck) && duck !== hs && duck !== wd)
  ok('the sidechain is a ringside insert there', inserts.get(duck)?.find((i) => i.key === 'sc_sc')?.kind === 'ringside')
  // the trigger: its own bus, into the sidechain's input, not heard while it's silent
  const key = [...routes].find(([, to]) => to.has('side:sc_sc'))?.[0]
  ok('the trigger plays on a bus of its own into the sidechain\'s input', key != null && key !== duck && new RegExp(`\\.orbit\\(${key}\\)`).test(code))
  ok('a silent trigger goes nowhere else', key != null && routes.get(key).size === 1)
  ok('the trigger copy plays on an instrument instance of its own', /_r: 'sc\.sc'/.test(code))
  ok('no Strudel ducking left in the code', !/duckorbit/.test(code))
}

// the same, heard: the trigger's bus goes to the speakers too
{
  const p = project(
    [node('b', 'pattern', { patternId: 'pb' }), node('d', 'pattern', { patternId: 'pd' }), node('sc', 'sidechain', { hear: 'audible' })],
    [edge('b', 'sc', 'in-0'), edge('d', 'sc', 'in-1'), edge('sc', 'out', 'in-0')],
  )
  m.generateCode(p)
  const { routes, speakers } = m.declaredRouting()
  const key = [...routes].find(([, to]) => to.has('side:sc_sc'))?.[0]
  ok('an audible trigger is heard as well', key != null && speakers.has(key))
}

// a split bus: one branch dry, one sidechained, joined again
{
  const { code, inserts, routes } = routing(project(
    [node('d', 'pattern', { patternId: 'pd' }), node('b', 'pattern', { patternId: 'pb' }), node('ba', 'bus', { name: 'a' }), node('sat', 'saturator'), node('sc', 'sidechain'), node('bb', 'bus', { name: 'b' })],
    [edge('d', 'ba', 'in-0'), edge('ba', 'sat'), edge('ba', 'sc', 'in-0'), edge('b', 'sc', 'in-1'), edge('sat', 'bb', 'in-0'), edge('sc', 'bb', 'in-1'), edge('bb', 'out', 'in-0')],
  ))
  const a = orbitIn(inserts, 'ba')
  const duck = orbitIn(inserts, 'sc_sc')
  ok('a sidechain on one branch ducks only that branch', duck != null && duck !== a && routes.get(a)?.has(duck))
  const joined = lineOf(code, 'n_bb')
  ok('the branches joined again play the notes once (plus the trigger)', /n_sat/.test(joined) && !/n_sc[,)]/.test(joined) && /n_sc_trigger/.test(joined))
}

// a split bus where one branch changes the notes, then has an insert
{
  const { inserts } = routing(project(
    [node('d', 'pattern', { patternId: 'pd' }), node('ba', 'bus', { name: 'a' }), node('sat', 'saturator'), node('fx', 'fast'), node('f', 'filter'), node('bb', 'bus', { name: 'b' })],
    [edge('d', 'ba', 'in-0'), edge('ba', 'sat'), edge('ba', 'fx'), edge('fx', 'f'), edge('sat', 'bb', 'in-0'), edge('f', 'bb', 'in-1'), edge('bb', 'out', 'in-0')],
  ))
  ok('an insert further down a branch never lands on the split bus', orbitIn(inserts, 'f') !== orbitIn(inserts, 'ba') && orbitIn(inserts, 'f') !== orbitIn(inserts, 'sat'))
}

// one sound down two paths (dry into a bus, and through a distortion into it): each path
// plays it on an instrument instance of its own, or an engine's own lanes flip between them
{
  const { code } = routing(project(
    [node('b', 'pattern', { patternId: 'pb' }), node('dist', 'distortion'), node('mix', 'bus', { name: 'mix' })],
    [edge('b', 'dist'), edge('b', 'mix', 'in-0'), edge('dist', 'mix', 'in-1'), edge('mix', 'out', 'in-0')],
  ))
  const tags = [...code.matchAll(/'o(\d+)' \}\)\)\.orbit\((\d+)\)/g)]
  ok('a sound split two ways gets an instance per path', tags.length === 2 && new Set(tags.map((t) => t[1])).size === 2 && tags.every((t) => t[1] === t[2]))
  const single = routing(project([node('b', 'pattern', { patternId: 'pb' }), node('dist', 'distortion')], [edge('b', 'dist'), edge('dist', 'out', 'in-0')])).code
  ok('a sound on one path is left as it is', !/_r:/.test(single))
}

// soloing a line (alt + S): what feeds the node, what it goes on through, and a sidechain's
// trigger on the way; nothing else
{
  const p = project(
    [node('b', 'pattern', { patternId: 'pb' }), node('d', 'pattern', { patternId: 'pd' }), node('dist', 'distortion'),
      node('sc', 'sidechain'), node('mix', 'bus', { name: 'mix' }), node('other', 'sound', { mini: 'hh*8' })],
    [edge('b', 'dist'), edge('dist', 'sc', 'in-0'), edge('d', 'sc', 'in-1'), edge('sc', 'mix', 'in-0'), edge('other', 'mix', 'in-1'), edge('d', 'mix', 'in-2'), edge('mix', 'out', 'in-0')],
  )
  const solo = m.generateCode(p, { lineSolo: 'dist' })
  ok('a soloed line plays the sound through it', /const n_dist = /.test(solo) && /const n_mix = /.test(solo))
  ok('and nothing else mixed in on the way', !/const n_other = /.test(solo))
  ok('a sidechain on the line still has its trigger', /_r: 'sc\.sc'/.test(solo))
  ok('the trigger only drives the duck: its own wire into the mix is off the line', !/n_patternd\.orbit|n_d\.orbit\(\d+\)\)?,? n_/.test(solo.split('const n_mix')[1] ?? ''))
  ok('without a solo everything plays', /const n_other = /.test(m.generateCode(p)))
}

// a sidechain after a bus that has a path of its own inside it (a distortion into the bus):
// the bus's notes stay where they are, so the distortion still gets its sound
{
  const { code, inserts } = routing(project(
    [node('b', 'pattern', { patternId: 'pb' }), node('d', 'pattern', { patternId: 'pd' }), node('dist', 'distortion'), node('mix', 'bus', { name: 'mix' }), node('sc', 'sidechain')],
    [edge('b', 'dist'), edge('b', 'mix', 'in-0'), edge('dist', 'mix', 'in-1'), edge('mix', 'sc', 'in-0'), edge('d', 'sc', 'in-1'), edge('sc', 'out', 'in-0')],
  ))
  const distBus = orbitIn(inserts, 'dist')
  const line = lineOf(code, 'n_sc')
  ok('a sidechain after a bus leaves the bus\'s notes where they are', /stack\(n_mix, /.test(line) && !/n_mix\.orbit/.test(line), line)
  ok('so a distortion inside the bus still plays on its own bus', new RegExp(`\\.orbit\\(${distBus}\\)`).test(lineOf(code, 'n_dist')))
}

// a trigger that's already on a bus (the kick through a saturator): that bus's own audio
// drives the sidechain, no copy, and the kick plays once
{
  const { code, routes, speakers, quiet } = routing(project(
    [node('b', 'pattern', { patternId: 'pb' }), node('d', 'pattern', { patternId: 'pd' }), node('sat', 'saturator'), node('sc', 'sidechain'), node('mix', 'bus', { name: 'mix' })],
    [edge('d', 'sat'), edge('sat', 'sc', 'in-1'), edge('sat', 'mix', 'in-1'), edge('b', 'sc', 'in-0'), edge('sc', 'mix', 'in-0'), edge('mix', 'out', 'in-0')],
  ))
  const satBus = [...routes].find(([, to]) => to.has('side:sc_sc'))?.[0]
  ok('a trigger after an effect feeds the sidechain from its own bus', satBus != null && /\.orbit\(/.test(lineOf(code, 'n_sat')) && lineOf(code, 'n_sat').includes(`.orbit(${satBus})`))
  ok('with no copy of its notes', !/_r: 'sc\./.test(code))
  ok('and it still plays into the mix, once', routes.get(satBus)?.size === 2 && (lineOf(code, 'n_mix').match(/n_sat/g) ?? []).length === 0 && !quiet.has(satBus))
  void speakers
}
// the same trigger wired only into the sidechain, silent: its bus isn't heard
{
  const { routes, quiet } = routing(project(
    [node('b', 'pattern', { patternId: 'pb' }), node('d', 'pattern', { patternId: 'pd' }), node('sat', 'saturator'), node('sc', 'sidechain')],
    [edge('d', 'sat'), edge('sat', 'sc', 'in-1'), edge('b', 'sc', 'in-0'), edge('sc', 'out', 'in-0')],
  ))
  const satBus = [...routes].find(([, to]) => to.has('side:sc_sc'))?.[0]
  ok('a silent trigger that only feeds the sidechain is kept off the speakers', satBus != null && quiet.has(satBus))
}

if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('\nrouting ok')
