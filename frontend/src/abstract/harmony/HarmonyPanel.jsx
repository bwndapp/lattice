import { useEffect, useMemo, useRef } from 'react'
import Knob from '../../Knob.jsx'
import {
  ARP_MODES, ARP_RATES, BASS_RHYTHMS, CHORD_RHYTHMS, LANES, LENGTHS, NOTE_NAMES, SCALES, SCALE_KEYS, STEPS,
  chordName, lanes as laneSteps, numeral, roll, rollLane, setLength,
} from './model.js'
import './harmony.css'

// '' first: no sound of its own (play what it fires)
const SOUNDS = ['', 'sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'piano']
const INKS = ['#c8a2ff', '#ffb347', '#86d8cc', '#ff8fa3']
const KNOBS = [
  { key: 'density', label: 'density', min: 0, max: 1, def: 0.5 },
  { key: 'motion', label: 'motion', min: 0, max: 1, def: 0.4 },
  { key: 'color', label: 'colour', min: 0, max: 1, def: 0.3 },
  { key: 'swing', label: 'swing', min: 0, max: 1, def: 0 },
]

/** A lane's notes as a little piano roll: [{ s, len, n, vel }] over every bar. */
function notesOf(bars) {
  const out = []
  bars.forEach((steps, b) => steps.forEach((st, s) => {
    if (st && st !== 'hold') {
      let len = 1
      while (steps[s + len] === 'hold') len++
      for (const n of st.notes) out.push({ s: b * STEPS + s, len, n, vel: st.vel })
    }
  }))
  return out
}

/**
 * The harmony engine's window: key and scale, the progression a chord a bar, four knobs,
 * then a lane a part, each with its notes drawn as a strip of piano roll.
 */
export default function HarmonyPanel({ state, change, position, playing }) {
  const heads = useRef([])
  const cards = useRef([])
  const live = useRef({ state, position, playing })
  live.current = { state, position, playing }

  // the playheads (and the chord playing now) move every frame without React
  useEffect(() => {
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const { state: st, position: pos, playing: on } = live.current
      const p = on?.() ? pos?.() ?? 0 : null
      const bars = st.progression.length
      const total = bars * STEPS
      const step = p == null ? -1 : Math.floor(Math.max(0, p) * STEPS + 1e-6) % total
      heads.current.forEach((el) => {
        if (!el) return
        el.style.opacity = step < 0 ? '0' : '1'
        if (step >= 0) el.setAttribute('x', String(step))
      })
      cards.current.forEach((el, i) => el?.classList.toggle('now', step >= 0 && Math.floor(step / STEPS) === i))
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const all = useMemo(() => laneSteps(state), [state])
  const rolls = useMemo(() => all.map(notesOf), [all])
  const setLane = (i, patch) => change((st) => ({ ...st, lanes: st.lanes.map((l, k) => (k === i ? { ...l, ...patch } : l)) }))
  const bars = state.progression.length
  const total = bars * STEPS

  return (
    <div className="harm-panel">
      <div className="harm-controls">
        <button type="button" className="btn primary" onClick={() => change((st) => roll(st))} title="A new progression and fresh dice for every lane that isn't locked">roll</button>
        <select className="select harm-key" value={state.key} onChange={(e) => change((st) => ({ ...st, key: Number(e.target.value) }))} aria-label="Key" title="Key">
          {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
        </select>
        <select className="select harm-scale" value={state.scale} onChange={(e) => change((st) => ({ ...st, scale: e.target.value }))} aria-label="Scale" title="Scale">
          {SCALE_KEYS.map((k) => <option key={k} value={k}>{SCALES[k].label}</option>)}
        </select>
        <span className="harm-toggle" role="group" aria-label="Length in bars">
          {LENGTHS.map((n) => (
            <button key={n} type="button" className={bars === n ? 'on' : ''} aria-pressed={bars === n} onClick={() => change((st) => setLength(st, n))} title={`${n} chords, one a bar`}>{n} bars</button>
          ))}
        </span>
        <div className="harm-knobs">
          {KNOBS.map((def) => <Knob key={def.key} def={def} value={state[def.key]} onChange={(v) => change((st) => ({ ...st, [def.key]: v }))} />)}
        </div>
      </div>

      <ol className="harm-prog" aria-label="Progression">
        {state.progression.map((deg, i) => (
          <li key={i} ref={(el) => { cards.current[i] = el }} className="harm-chord">
            <button type="button" onClick={() => change((st) => ({ ...st, progression: st.progression.map((d, k) => (k === i ? ((d + 5) % 7) + 1 : d)) }))} aria-label="Previous degree">‹</button>
            <span className="harm-chord-face" onWheel={(e) => change((st) => ({ ...st, progression: st.progression.map((d, k) => (k === i ? ((d - 1 + (e.deltaY < 0 ? 1 : 6)) % 7) + 1 : d)) }))} title="Scroll or click the arrows to change this chord">
              <b>{chordName(state, i)}</b>
              <span>{numeral(state, i)}</span>
            </span>
            <button type="button" onClick={() => change((st) => ({ ...st, progression: st.progression.map((d, k) => (k === i ? (d % 7) + 1 : d)) }))} aria-label="Next degree">›</button>
          </li>
        ))}
      </ol>

      <ol className="harm-lanes">
        {state.lanes.map((l, i) => {
          const r = rolls[i]
          const lo = r.length ? Math.min(...r.map((x) => x.n)) - 1 : 0
          const hi = r.length ? Math.max(...r.map((x) => x.n)) + 1 : 1
          return (
            <li key={i} className={`harm-lane ${l.mute ? 'muted' : ''}`} style={{ '--ink': INKS[i] }}>
              <span className="harm-name">{LANES[i]}</span>
              <select className="harm-sound" value={l.sound} onChange={(e) => setLane(i, { sound: e.target.value })} aria-label={`${LANES[i]} sound`} title="Its own sound, or — to only play what its trigger fires">
                {(SOUNDS.includes(l.sound) ? SOUNDS : [l.sound, ...SOUNDS]).map((s) => <option key={s} value={s}>{s || '—'}</option>)}
              </select>
              <span className="harm-opt">
                {i === 0 && (
                  <select className="select" value={l.rhythm} onChange={(e) => setLane(i, { rhythm: e.target.value })} aria-label="Chord rhythm">
                    {Object.entries(CHORD_RHYTHMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                )}
                {i === 1 && (
                  <select className="select" value={l.rhythm} onChange={(e) => setLane(i, { rhythm: e.target.value })} aria-label="Bass rhythm">
                    {Object.entries(BASS_RHYTHMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                )}
                {i === 2 && <span className="meta">follows the chords</span>}
                {i === 3 && (
                  <>
                    <select className="select" value={l.mode} onChange={(e) => setLane(i, { mode: e.target.value })} aria-label="Arp direction">
                      {Object.entries(ARP_MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <select className="select" value={l.rate} onChange={(e) => setLane(i, { rate: Number(e.target.value) })} aria-label="Arp rate">
                      {ARP_RATES.map((n) => <option key={n} value={n}>1/{n}</option>)}
                    </select>
                  </>
                )}
              </span>
              <span className="harm-oct" title="Octave">
                <button type="button" disabled={l.octave <= -2} onClick={() => setLane(i, { octave: l.octave - 1 })} aria-label="Octave down">‹</button>
                <span>oct {l.octave > 0 ? `+${l.octave}` : l.octave}</span>
                <button type="button" disabled={l.octave >= 2} onClick={() => setLane(i, { octave: l.octave + 1 })} aria-label="Octave up">›</button>
              </span>
              <button type="button" className="harm-dice" onClick={() => change((st) => rollLane(st, i))} title={i === 0 ? 'A new progression' : `A new ${LANES[i]}`} aria-label={`Roll the ${LANES[i]}`}>⚄</button>
              <button type="button" className={`harm-lock ${l.lock ? 'on' : ''}`} aria-pressed={l.lock} onClick={() => setLane(i, { lock: !l.lock })} title="Lock: keep this lane when you roll">{l.lock ? 'locked' : 'lock'}</button>
              <button type="button" className={`led mute ${l.mute ? 'on' : ''}`} aria-pressed={l.mute} onClick={() => setLane(i, { mute: !l.mute })} title="Mute this lane">m</button>
              <svg className="harm-roll" viewBox={`0 0 ${total} ${hi - lo}`} preserveAspectRatio="none" aria-hidden>
                {Array.from({ length: bars - 1 }, (_, b) => <line key={b} x1={(b + 1) * STEPS} x2={(b + 1) * STEPS} y1={0} y2={hi - lo} className="harm-barline" />)}
                {r.map((x, k) => <rect key={k} x={x.s + 0.08} width={Math.max(0.5, x.len - 0.16)} y={hi - x.n - 1} height={1} rx={0.3} className="harm-note" style={{ opacity: 0.45 + x.vel * 0.55 }} />)}
                <rect ref={(el) => { heads.current[i] = el }} x={0} width={1} y={0} height={hi - lo} className="harm-head" style={{ opacity: 0 }} />
              </svg>
            </li>
          )
        })}
      </ol>
      <p className="harm-hint meta">Wire a lane's trigger into an instrument on a pattern node (Syrup, Physical…) and that instrument plays the lane's notes. Everything stays in {NOTE_NAMES[state.key]} {SCALES[state.scale].label}.</p>
    </div>
  )
}
