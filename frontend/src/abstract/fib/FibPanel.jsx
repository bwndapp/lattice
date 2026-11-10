import { useEffect, useMemo, useRef } from 'react'
import { BANKS } from '../../project.js'
import { FIB, layerSteps, roll } from './model.js'
import './fib.css'

const SOUNDS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
const STEPS = [2, 3, 5, 8, 13, 21]
const RADII = [58, 92, 126, 160] // layer one innermost
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
        const [x, y] = at(RADII[i], step, l.steps)
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
        {loops.map((vals, i) => (
          <g key={i} className={`fib-ring ${state.layers[i].mute ? 'muted' : ''}`}>
            <circle r={RADII[i]} className="fib-track" />
            {vals.map((v, s) => {
              const [x, y] = at(RADII[i], s, vals.length)
              return <circle key={s} cx={x} cy={y} r={v === 2 ? 6.5 : v ? 5 : 2.2} className={`fib-dot v${v}`} />
            })}
            <circle ref={(el) => { heads.current[i] = el }} r={9} className="fib-head" style={{ opacity: 0 }} />
          </g>
        ))}
      </svg>

      <div className="fib-side">
        <div className="fib-actions">
          <button type="button" className="btn primary" onClick={() => change((st) => roll(st))} title="Roll every loop: new Fibonacci lengths, hits and rotations">roll</button>
          <span className="seg" role="group" aria-label="Timing">
            <button type="button" className={`btn ${state.timing === 'drift' ? 'on' : ''}`} aria-pressed={state.timing === 'drift'} onClick={() => change((st) => ({ ...st, timing: 'drift' }))} title="Every loop in sixteenths: loops of different lengths drift apart and meet again">drift</button>
            <button type="button" className={`btn ${state.timing === 'bar' ? 'on' : ''}`} aria-pressed={state.timing === 'bar'} onClick={() => change((st) => ({ ...st, timing: 'bar' }))} title="Each loop squeezed into one bar: 5 steps become quintuplets">bar</button>
          </span>
          <label className="fib-kit">
            <span className="meta">kit</span>
            <select className="select" value={state.bank} onChange={(e) => change((st) => ({ ...st, bank: e.target.value }))}>
              {(BANKS.includes(state.bank) ? BANKS : [state.bank, ...BANKS]).map((b) => <option key={b} value={b}>{b || 'default sounds'}</option>)}
            </select>
          </label>
        </div>

        <ol className="fib-layers">
          {state.layers.map((l, i) => (
            <li key={i} className={`fib-layer ${l.mute ? 'muted' : ''}`}>
              <div className="fib-layer-top">
                <select className="select" value={l.sound} onChange={(e) => setLayer(i, { sound: e.target.value })} aria-label={`Loop ${i + 1}'s sound`}>
                  {(SOUNDS.includes(l.sound) ? SOUNDS : [l.sound, ...SOUNDS]).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="select" value={l.mode} onChange={(e) => setLayer(i, { mode: e.target.value })} aria-label="How the hits are spread" title="even: hits spread as evenly as they go · golden: a window onto the Fibonacci word">
                  <option value="even">even</option>
                  <option value="golden">golden</option>
                </select>
                {l.mode === 'even' && (
                  <select className="select" value={l.hits} onChange={(e) => setLayer(i, { hits: Number(e.target.value) })} aria-label="Hits">
                    {FIB.filter((n) => n <= l.steps).map((n) => <option key={n} value={n}>{n} hit{n === 1 ? '' : 's'}</option>)}
                  </select>
                )}
                <select className="select" value={l.steps} onChange={(e) => setLayer(i, { steps: Number(e.target.value) })} aria-label="Loop length">
                  {STEPS.map((n) => <option key={n} value={n}>in {n}</option>)}
                </select>
                <span className="fib-rot" title={l.mode === 'golden' ? 'Slide the window along the Fibonacci word' : 'Turn the loop round'}>
                  <button type="button" onClick={() => setLayer(i, { rotate: Math.max(0, l.rotate - 1) })} aria-label="Rotate back">−</button>
                  <span>{l.rotate}</span>
                  <button type="button" onClick={() => setLayer(i, { rotate: l.rotate + 1 })} aria-label="Rotate on">+</button>
                </span>
                <button type="button" className={`led mute ${l.mute ? 'on' : ''}`} aria-pressed={l.mute} onClick={() => setLayer(i, { mute: !l.mute })} title="Mute this loop">m</button>
              </div>
              <span className="fib-strip" style={{ gridTemplateColumns: `repeat(${loops[i].length}, 1fr)` }} aria-hidden>
                {loops[i].map((v, s) => <i key={s} className={`v${v}`} />)}
              </span>
            </li>
          ))}
        </ol>
        <p className="fib-hint meta">Wire a sound (Syrup, a melody…) into a loop's input on the node and it plays on that loop's rhythm.</p>
      </div>
    </div>
  )
}
