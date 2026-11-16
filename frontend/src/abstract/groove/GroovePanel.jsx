import { useEffect, useMemo, useRef } from 'react'
import Knob from '../../Knob.jsx'
import { BANKS } from '../../project.js'
import { LANES, LENGTHS, STEPS, STYLES, STYLE_KEYS, laneBars, roll, rollLane } from './model.js'
import './groove.css'

// '' first: no sound of its own (play what's wired in)
const SOUNDS = ['', 'bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
const INKS = ['#ffb347', '#ff8fa3', '#86d8cc', '#c8a2ff']
const KNOBS = [
  { key: 'density', label: 'density', min: 0, max: 1, def: 0.5 },
  { key: 'swing', label: 'swing', min: 0, max: 1, def: 0 },
  { key: 'ghosts', label: 'ghosts', min: 0, max: 1, def: 0.4 },
  { key: 'fills', label: 'fills', min: 0, max: 1, def: 0.5 },
]

/**
 * The groove engine's window: styles along the top, four knobs, and a lane a drum with its
 * bars laid out in steps — a playhead runs along them while the song plays.
 */
export default function GroovePanel({ state, change, position, playing }) {
  const heads = useRef([])
  const live = useRef({ state, position, playing })
  live.current = { state, position, playing }

  // the playheads move every frame without React
  useEffect(() => {
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const { state: st, position: pos, playing: on } = live.current
      const p = on?.() ? pos?.() ?? 0 : null
      const total = st.bars * STEPS
      heads.current.forEach((el) => {
        if (!el) return
        if (p == null) { el.style.opacity = '0'; return }
        const step = Math.floor(Math.max(0, p) * STEPS + 1e-6) % total
        el.style.left = `${(step / total) * 100}%`
        el.style.width = `${100 / total}%`
        el.style.opacity = '1'
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const lanes = useMemo(() => state.lanes.map((_, i) => laneBars(state, i)), [state])
  const setLane = (i, patch) => change((st) => ({ ...st, lanes: st.lanes.map((l, k) => (k === i ? { ...l, ...patch } : l)) }))

  return (
    <div className="groove-panel">
      <div className="groove-styles" role="group" aria-label="Style">
        {STYLE_KEYS.map((k) => (
          <button key={k} type="button" className={state.style === k ? 'on' : ''} aria-pressed={state.style === k} onClick={() => change((st) => ({ ...st, style: k }))}>{STYLES[k].label}</button>
        ))}
      </div>

      <div className="groove-controls">
        <button type="button" className="btn primary" onClick={() => change((st) => roll(st))} title="A new groove in this style: fresh dice for every lane that isn't locked">new groove</button>
        <div className="groove-knobs">
          {KNOBS.map((def) => (
            <Knob key={def.key} def={def} value={state[def.key]} onChange={(v) => change((st) => ({ ...st, [def.key]: v }))} />
          ))}
        </div>
        <span className="groove-toggle" role="group" aria-label="Length in bars">
          {LENGTHS.map((n) => (
            <button key={n} type="button" className={state.bars === n ? 'on' : ''} aria-pressed={state.bars === n} onClick={() => change((st) => ({ ...st, bars: n }))} title={`${n} bar${n === 1 ? '' : 's'}${n > 1 ? ', the last can end in a fill' : ''}`}>{n} bar{n === 1 ? '' : 's'}</button>
          ))}
        </span>
        <select className="select groove-kit" value={state.bank} onChange={(e) => change((st) => ({ ...st, bank: e.target.value }))} aria-label="Drum kit" title="Drum kit">
          {(BANKS.includes(state.bank) ? BANKS : [state.bank, ...BANKS]).map((b) => <option key={b} value={b}>{b || 'default sounds'}</option>)}
        </select>
      </div>

      <ol className="groove-lanes">
        {state.lanes.map((l, i) => (
          <li key={i} className={`groove-lane ${l.mute ? 'muted' : ''}`} style={{ '--ink': INKS[i] }}>
            <span className="groove-name">{LANES[i]}</span>
            <select className="groove-sound" value={l.sound} onChange={(e) => setLane(i, { sound: e.target.value })} aria-label={`${LANES[i]} sound`}>
              {(SOUNDS.includes(l.sound) ? SOUNDS : [l.sound, ...SOUNDS]).map((s) => <option key={s} value={s}>{s || '—'}</option>)}
            </select>
            <button type="button" className="groove-dice" onClick={() => change((st) => rollLane(st, i))} title={`A new ${LANES[i]} part`} aria-label={`Roll the ${LANES[i]}`}>⚄</button>
            <button type="button" className={`groove-lock ${l.lock ? 'on' : ''}`} aria-pressed={l.lock} onClick={() => setLane(i, { lock: !l.lock })} title="Lock: keep this lane when you roll a new groove">{l.lock ? 'locked' : 'lock'}</button>
            <button type="button" className={`led mute ${l.mute ? 'on' : ''}`} aria-pressed={l.mute} onClick={() => setLane(i, { mute: !l.mute })} title="Mute this lane">m</button>
            <span className="groove-strip" aria-hidden>
              {lanes[i].map((bar, b) => (
                <span key={b} className="groove-bar">
                  {bar.map((v, s) => <i key={s} className={`v${v} ${s % 4 === 0 ? 'beat' : ''}`} />)}
                </span>
              ))}
              <span ref={(el) => { heads.current[i] = el }} className="groove-head" style={{ opacity: 0 }} />
            </span>
          </li>
        ))}
      </ol>
      <p className="groove-hint meta">Brighter is louder: dim dots are ghost notes, split dots are rolls. Wire Syrup or a melody into a lane's input on the node to play it on that lane's rhythm.</p>
    </div>
  )
}
