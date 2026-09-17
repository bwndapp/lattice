import { useCallback, useEffect, useRef, useState } from 'react'
import { useAutoLive, useAutomation } from './autoLive.js'
import { KnobMenu } from './KnobMenu.jsx'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 0..1 position of a value on a (possibly logarithmic) range, and back. */
const toPos = (v, { min, max, log }) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min))
const fromPos = (t, { min, max, log }) => (log ? min * (max / min) ** t : min + t * (max - min))

export function formatValue(v, def) {
  if (def.key === 'pan') return v === 0.5 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`
  if (def.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v < 10 ? `${v.toFixed(2)}` : `${Math.round(v)}`
  if (def.unit === 'ct') return `${v > 0.5 ? '+' : ''}${Math.round(v)}ct`
  if (def.unit === 'x') return `${v.toFixed(2)}x`
  if (def.unit === 'bar') return `${Math.round(v * 16 * 10) / 10}/16`
  if (def.unit === 's') return v < 0.1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`
  if (def.unit === 'db') return `${v > 0.05 && def.origin === 0 ? '+' : ''}${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${def.origin === 0 && v <= def.min ? ' off' : ''}`
  if (def.unit === 'ratio') return `${v < 10 ? v.toFixed(1) : Math.round(v)}:1`
  if (def.unit === 'bi') return `${v > 0.005 ? '+' : ''}${Math.round(v * 100)}`
  return `${Math.round(v * 100)}`
}

/**
 * A knob: drag up/down (shift for fine), scroll, arrow keys, double-click to reset.
 * Calls `onChange` as it turns and `onCommit` when you let go. With a `target` (see
 * automation.js), right-click offers to automate it; an automated knob wears a mark and,
 * while the song plays, turns with its curve.
 */
export default function Knob({ def, value, onChange, target = null }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [live, setLive] = useState(null) // value while dragging, so the knob moves smoothly
  const automation = useAutomation()
  const automated = !!target && !!automation?.automated.has(target)
  const following = useAutoLive(automated ? target : null) // where its curve has it, while playing
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const shown = live ?? following ?? value
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
  const origin = def.origin !== undefined ? clamp(toPos(def.origin, def), 0, 1) : def.key === 'pan' ? 0.5 : 0
  const [hx, hy] = pt(pos)

  return (
    <div
      className={`knob ${changed ? 'changed' : ''} ${automated ? 'automated' : ''} ${following !== undefined ? 'following' : ''}`}
      title={`${def.label}: ${formatValue(shown, def)}${automated ? ' · automated in the song' : ''} · drag, scroll, double-click to reset${target && automation ? ' · right-click to automate' : ''}`}
      onContextMenu={(e) => {
        if (!target || !automation) return
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
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
        aria-valuetext={formatValue(shown, def)}
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
      <span className="knob-label">{live !== null || following !== undefined ? formatValue(shown, def) : def.label}</span>
      {automated && <span className="knob-auto-mark" aria-hidden />}
      {menu && (
        <KnobMenu
          x={menu.x}
          y={menu.y}
          title={def.label}
          onClose={closeMenu}
          items={automated ? [
            ['Edit automation', () => automation.open(target, menu)],
            ['Show on the timeline', () => automation.showTimeline(target)],
            ['Remove automation', () => automation.remove(target), { danger: true }],
            null,
            ['Reset to default', () => onChange(def.def)],
          ] : [
            ['Automate on the timeline', () => automation.automate(target, menu), { accent: true }],
            null,
            ['Reset to default', () => onChange(def.def)],
          ]}
        />
      )}
    </div>
  )
}
