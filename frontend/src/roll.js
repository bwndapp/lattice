/**
 * Random hits for a drum row, across every bar of its pattern — to stumble on a groove
 * rather than write one. Not uniform noise: each kind of drum leans where it usually sits
 * (a kick on the beat, a snare on the backbeat, a hat between beats), and the density is
 * rolled too, so one roll comes out sparse and the next busy. The last bar of a longer
 * pattern gets a little more, the way a fill would.
 */

/** What kind of drum a row is, from its sound (or its name, for anything unusual). */
export function drumRole(ch) {
  const s = `${ch?.sound ?? ''} ${ch?.name ?? ''}`.toLowerCase()
  if (/\b(bd|kick)/.test(s)) return 'kick'
  if (/\b(sd|cp|rim|snare|clap)/.test(s)) return 'snare'
  if (/\b(oh|open)/.test(s)) return 'open'
  if (/\b(hh|hat|ch\b|ride|cr|shaker|sh\b)/.test(s)) return 'hat'
  return 'perc'
}

/** How likely a hit is: [the bar's first step, on a beat, halfway through a beat, anywhere else]. */
const LEAN = {
  kick: [0.95, 0.45, 0.22, 0.1],
  snare: [0.02, 0.08, 0.12, 0.08], // the backbeat is handled on its own, below
  hat: [0.6, 0.55, 0.75, 0.32],
  open: [0.05, 0.05, 0.45, 0.06],
  perc: [0.3, 0.3, 0.28, 0.16],
}

/**
 * A fresh step array for `ch`, `bars × stepsPerBar` long. `rand` is there for tests.
 * Never empty: a roll with nothing in it would look like the button did nothing.
 */
export function rollSteps(ch, { bars = 1, stepsPerBar = 16, beats = 4 } = {}, rand = Math.random) {
  const role = drumRole(ch)
  const lean = LEAN[role]
  const perBeat = Math.max(1, Math.round(stepsPerBar / Math.max(1, beats)))
  const density = 0.6 + rand() * 0.8 // this roll: sparse … busy
  const total = Math.max(1, bars * stepsPerBar)
  const steps = new Array(total).fill(0)
  for (let i = 0; i < total; i++) {
    const bar = Math.floor(i / stepsPerBar)
    const at = i % stepsPerBar
    const inBeat = at % perBeat
    const beat = Math.floor(at / perBeat)
    let p
    if (role === 'snare' && inBeat === 0 && beat % 2 === 1) p = 0.9 // two and four
    else if (at === 0) p = lean[0]
    else if (inBeat === 0) p = lean[1]
    else if (perBeat % 2 === 0 && inBeat === perBeat / 2) p = lean[2]
    else p = lean[3]
    p *= density
    if (bars > 1 && bar === bars - 1 && inBeat !== 0) p += 0.1 // a fill on the way round
    steps[i] = rand() < Math.min(0.97, p) ? 1 : 0
  }
  if (!steps.some(Boolean)) steps[0] = 1
  return steps
}
