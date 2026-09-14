import { useEffect, useRef, useState } from 'react'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 0..1 position of a value on a (possibly logarithmic) range, and back. */
const toPos = (v, { min, max, log }) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min))
const fromPos = (t, { min, max, log }) => (log ? min * (max / min) ** t : min + t * (max - min))

function format(v, def) {
  if (def.key === 'pan') return v === 0.5 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`
  if (def.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`
  if (def.unit === 'x') return `${v.toFixed(2)}x`
  if (def.unit === 's') return `${v.toFixed(2)}s`
  return `${Math.round(v * 100)}`
}

/**
 * A knob: drag up/down (shift for fine), scroll, arrow keys, double-click to reset.
 * Calls `onChange` as it turns and `onCommit` when you let go.
 */
export default function Knob({ def, value, onChange }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [live, setLive] = useState(null) // value while dragging, so the knob moves smoothly
  const shown = live ?? value
  const pos = clamp(toPos(shown, def), 0, 1)
  const changed = Math.abs(shown - def.def) > 1e-9

  const set = (t) => {
    const next = fromPos(clamp(t, 0, 1), def)
    const rounded = def.log ? Math.round(next * 100) / 100 : Math.round(next * 1000) / 1000
    setLive(rounded)
    onChange(rounded)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      set(toPos(live ?? value, def) - Math.sign(e.deltaY) * (e.shiftKey ? 0.01 : 0.04))
      clearTimeout(onWheel.t)
      onWheel.t = setTimeout(() => setLive(null), 300)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // arc from 225° (min) round to -45° (max)
  const angle = (a) => ((225 - a * 270) * Math.PI) / 180
  const r = 13
  const pt = (a) => [18 + r * Math.cos(angle(a)), 18 - r * Math.sin(angle(a))]
  const arc = (a0, a1) => {
    const [x0, y0] = pt(a0)
    const [x1, y1] = pt(a1)
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`
  }
  const origin = def.key === 'pan' ? 0.5 : 0
  const [hx, hy] = pt(pos)

  return (
    <div className={`knob ${changed ? 'changed' : ''}`} title={`${def.label}: ${format(shown, def)} · drag, scroll, double-click to reset`}>
      <svg
        ref={ref}
        className="nodrag"
        width="36"
        height="36"
        viewBox="0 0 36 36"
        role="slider"
        tabIndex={0}
        aria-label={def.label}
        aria-valuemin={def.min}
        aria-valuemax={def.max}
        aria-valuenow={Math.round(shown * 1000) / 1000}
        aria-valuetext={format(shown, def)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, t: toPos(value, def) }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          set(d.t + (d.y - e.clientY) / (e.shiftKey ? 600 : 150))
        }}
        onPointerUp={() => { drag.current = null; setLive(null) }}
        onPointerCancel={() => { drag.current = null; setLive(null) }}
        onDoubleClick={() => { setLive(null); onChange(def.def) }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.01 : 0.05
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(toPos(value, def) + step)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(toPos(value, def) - step)
          else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') onChange(def.def)
          else return
          e.preventDefault()
          setTimeout(() => setLive(null), 200)
        }}
      >
        <path d={arc(0, 1)} className="knob-track" />
        {Math.abs(pos - origin) > 0.004 && <path d={pos > origin ? arc(origin, pos) : arc(pos, origin)} className="knob-value" />}
        <line x1="18" y1="18" x2={hx} y2={hy} className="knob-hand" />
      </svg>
      <span className="knob-label">{live !== null ? format(shown, def) : def.label}</span>
    </div>
  )
}
