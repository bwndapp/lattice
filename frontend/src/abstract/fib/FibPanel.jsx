import { useEffect, useMemo, useRef } from 'react'
import { BANKS } from '../../project.js'
import { FIB, MAX_LAYERS, addLayer, layerSteps, removeLayer, roll } from './model.js'
import './fib.css'

// '' first: no sound of its own (play what's wired in)
const SOUNDS = ['', 'bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
const STEPS = [2, 3, 5, 8, 13, 21, 34, 55]
// the rings share the space between these, layer one innermost, however many there are
const INNER = 34
const OUTER = 166
const radius = (i, n) => INNER + ((OUTER - INNER) * (i + (n === 1 ? 1 : 0.5))) / Math.max(1, n === 1 ? 2 : n)
// each loop's colour, the same on its ring and its row (round again past eight)
const INKS = ['#ffb347', '#86d8cc', '#c8a2ff', '#ff8fa3', '#9fb4ff', '#b9c96a', '#ffd23f', '#5ad1ff']
const inkOf = (i) => INKS[i % INKS.length]
const PHI = (1 + Math.sqrt(5)) / 2

/** A golden spiral, the faint ground the rings sit on: r grows by φ every quarter turn. */
function spiralPath() {
  const pts = []
  for (let t = 0; t <= Math.PI * 7; t += 0.05) {
    const r = 1.2 * PHI ** ((2 * t) / Math.PI)
    if (r > 178) break
    pts.push(`${(r * Math.cos(t - Math.PI / 2)).toFixed(1)},${(r * Math.sin(t - Math.PI / 2)).toFixed(1)}`)
  }
  return `M${pts.join(' L')}`
}
const SPIRAL = spiralPath()
const at = (r, i, n) => {
  const a = -Math.PI / 2 + (i / n) * Math.PI * 2
  return [r * Math.cos(a), r * Math.sin(a)]
}

/**
 * The Fibonacci machine's window: its four loops as rings round a golden spiral, each with
 * its own playhead going round at its own pace — in drift they come apart and meet again.
 * The controls beside it pick each loop's length, hits and rotation.
 */
export default function FibPanel({ state, change, position, playing }) {
  const heads = useRef([])
  const live = useRef({ state, position, playing })
  live.current = { state, position, playing }

  // the playheads move every frame without React: just their place on the ring
  useEffect(() => {
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const { state: st, position: pos, playing: on } = live.current
      const p = on?.() ? pos?.() ?? 0 : null
      st.layers.forEach((l, i) => {
        const el = heads.current[i]
        if (!el) return
        if (p == null) { el.style.opacity = '0'; return }
        const step = st.timing === 'drift'
          ? Math.floor(p * 16 + 1e-6) % l.steps
          : Math.floor((((p % 1) + 1) % 1) * l.steps)
        const [x, y] = at(radius(i, st.layers.length), step, l.steps)
        el.setAttribute('cx', x.toFixed(1))
        el.setAttribute('cy', y.toFixed(1))
        el.style.opacity = l.mute ? '0.25' : '1'
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const loops = useMemo(() => state.layers.map(layerSteps), [state])
  const setLayer = (i, patch) => change((st) => ({
    ...st,
    layers: st.layers.map((l, k) => {
      if (k !== i) return l
      const next = { ...l, ...patch }
      next.hits = Math.min(next.hits, next.steps)
      return next
    }),
  }))

  return (
    <div className="fib-panel">
      <svg className="fib-stage" viewBox="-180 -180 360 360" role="img" aria-label="The four loops as rings">
        <path d={SPIRAL} className="fib-spiral" />
        {loops.map((vals, i) => {
          const r = radius(i, loops.length)
          // dots shrink as rings crowd in, and as a ring fills up with steps
          const k = Math.min(1, Math.sqrt(4 / loops.length), (2 * Math.PI * r) / vals.length / 13)
          return (
            <g key={i} className={`fib-ring ${state.layers[i].mute ? 'muted' : ''}`} style={{ '--ink': inkOf(i) }}>
              <circle r={r} className="fib-track" />
              {vals.map((v, s) => {
                const [x, y] = at(r, s, vals.length)
                return <circle key={s} cx={x} cy={y} r={(v === 2 ? 6.5 : v ? 5 : 2) * k} className={`fib-dot v${v}`} />
              })}
              <circle ref={(el) => { heads.current[i] = el }} r={10 * k} className="fib-head" style={{ opacity: 0 }} />
            </g>
          )
        })}
      </svg>

      <div className="fib-side">
        <div className="fib-actions">
          <button type="button" className="btn primary" onClick={() => change((st) => roll(st))} title="Roll every loop: new Fibonacci lengths, hits and rotations">roll</button>
          <span className="fib-toggle" role="group" aria-label="Timing">
            {[['drift', 'Every loop in sixteenths: loops of different lengths drift apart and meet again'], ['bar', 'Each loop squeezed into one bar: 5 steps become quintuplets']].map(([t, tip]) => (
              <button key={t} type="button" className={state.timing === t ? 'on' : ''} aria-pressed={state.timing === t} onClick={() => change((st) => ({ ...st, timing: t }))} title={tip}>{t}</button>
            ))}
          </span>
          <select className="select fib-kit" value={state.bank} onChange={(e) => change((st) => ({ ...st, bank: e.target.value }))} aria-label="Drum kit" title="Drum kit">
            {(BANKS.includes(state.bank) ? BANKS : [state.bank, ...BANKS]).map((b) => <option key={b} value={b}>{b || 'default sounds'}</option>)}
          </select>
        </div>

        <ol className="fib-layers">
          {state.layers.map((l, i) => {
            const golden = l.mode === 'golden'
            return (
              <li key={i} className={`fib-layer ${l.mute ? 'muted' : ''}`} style={{ '--ink': inkOf(i) }}>
                <span className="fib-badge" aria-hidden>{i + 1}</span>
                <select className="fib-sound" value={l.sound} onChange={(e) => setLayer(i, { sound: e.target.value })} aria-label={`Loop ${i + 1}'s sound`}>
                  {(SOUNDS.includes(l.sound) ? SOUNDS : [l.sound, ...SOUNDS]).map((s) => <option key={s} value={s}>{s || '—'}</option>)}
                </select>
                <span className="fib-ratio">
                  {golden
                    ? <span className="fib-word" title="Hits from the Fibonacci word">φ</span>
                    : <Cycle list={FIB.filter((n) => n <= l.steps)} value={l.hits} onChange={(v) => setLayer(i, { hits: v })} label="hits" />}
                  <span className="fib-in">in</span>
                  <Cycle list={STEPS} value={l.steps} onChange={(v) => setLayer(i, { steps: v })} label="steps" />
                </span>
                <span className="fib-rot" title={golden ? 'Slide the window along the Fibonacci word' : 'Turn the loop round'}>
                  <button type="button" onClick={() => setLayer(i, { rotate: Math.max(0, l.rotate - 1) })} aria-label="Rotate back">‹</button>
                  <span>rot {l.rotate}</span>
                  <button type="button" onClick={() => setLayer(i, { rotate: l.rotate + 1 })} aria-label="Rotate on">›</button>
                </span>
                <button type="button" className={`fib-mode ${golden ? 'on' : ''}`} onClick={() => setLayer(i, { mode: golden ? 'even' : 'golden' })} title={golden ? 'Golden: a window onto the Fibonacci word · click for even' : 'Even: hits spread as evenly as they go · click for golden'}>{golden ? 'golden' : 'even'}</button>
                <button type="button" className={`led mute ${l.mute ? 'on' : ''}`} aria-pressed={l.mute} onClick={() => setLayer(i, { mute: !l.mute })} title="Mute this loop">m</button>
                <button type="button" className="fib-remove" disabled={state.layers.length <= 1} onClick={() => change((st) => removeLayer(st, i), { removed: i })} title="Remove this loop (and its wires)" aria-label={`Remove loop ${i + 1}`}>×</button>
                <span className={`fib-strip ${loops[i].length > 21 ? 'long' : ''}`} aria-hidden>
                  {loops[i].map((v, s) => <i key={s} className={`v${v}`} />)}
                </span>
              </li>
            )
          })}
        </ol>
        <button type="button" className="fib-add" disabled={state.layers.length >= MAX_LAYERS} onClick={() => change(addLayer)} title="Another loop, one step further along the Fibonacci numbers">+ layer</button>
        <p className="fib-hint meta">Wire Syrup or a melody into a loop's input on the node to play it on that loop's rhythm.</p>
      </div>
    </div>
  )
}

/** A number you step through a list of: click the arrows, or scroll over it. */
function Cycle({ list, value, onChange, label }) {
  const i = Math.max(0, list.indexOf(value))
  const go = (d) => onChange(list[Math.min(list.length - 1, Math.max(0, i + d))])
  return (
    <span className="fib-cycle" onWheel={(e) => go(e.deltaY < 0 ? 1 : -1)} title={`${label}: scroll or click the arrows`}>
      <button type="button" disabled={i <= 0} onClick={() => go(-1)} aria-label={`Fewer ${label}`}>‹</button>
      <b>{value}</b>
      <button type="button" disabled={i >= list.length - 1} onClick={() => go(1)} aria-label={`More ${label}`}>›</button>
    </span>
  )
}
