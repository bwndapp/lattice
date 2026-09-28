import { useCallback, useEffect, useRef, useState } from 'react'
import { useAutoLive, useAutomation } from './autoLive.js'
import { KnobMenu } from './KnobMenu.jsx'
import './Knob.css'
import { knobBridge } from './knobBridge.js'
import { clamp, dragTo, fromPos, parseKnobValue, pastThreshold, snapValue, startDrag, stepOf, toPos, wheelPixels, wheelTravel } from './knobMath.js'


export function formatValue(v, def) {
  if (def.choices) return def.choices[Math.round(v)] ?? ''
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

// reset is cmd-click on a Mac (ctrl-click there is a right-click), ctrl-click elsewhere; alt-click on both
const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
const resetClick = (e) => e.altKey || (MAC ? e.metaKey : e.ctrlKey || e.metaKey)
const RESET_HINT = `${MAC ? 'cmd' : 'ctrl'}-click or Home to reset`

/**
 * A knob: drag up/down (shift for fine), scroll, arrow keys, double-click (or Enter) to
 * type a value, ctrl/cmd-click, alt-click or Home to reset.
 * While it turns, only the knob redraws and the sound follows at once where the app can
 * move it directly (knobBridge.js); the project is written at most once a frame (or ten
 * times a second when the sound already follows), and once more when you let go, so a
 * whole turn is one undo step and the others in the room get where it ended. With a
 * `target` (see automation.js), right-click offers to automate it; an automated knob
 * wears a mark and, while the song plays, turns with its curve.
 */
export default function Knob({ def, value, onChange, target = null }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [live, setLive] = useState(null) // value while turning, so the knob moves smoothly
  const automation = useAutomation()
  const automated = !!target && !!automation?.automated.has(target)
  const following = useAutoLive(automated ? target : null) // where its curve has it, while playing
  const [menu, setMenu] = useState(null)
  const [typing, setTyping] = useState(null) // the text while typing a value
  const typed = useRef(false) // Enter or Escape already dealt with it (then the field blurs)
  const closeMenu = useCallback(() => setMenu(null), [])
  // a knob in steps shows the step it's on, whatever an old project stored
  const shown = def.choices ? snapValue(live ?? following ?? value, def) : live ?? following ?? value
  const step = stepOf(def)
  const pos = clamp(toPos(shown, def), 0, 1)
  const changed = Math.abs(shown - def.def) > 1e-9

  // one turn: a drag, a burst of scrolling or key presses
  const turn = useRef(null)
  const props = useRef(null)
  props.current = { onChange, target }
  const flush = () => {
    const t = turn.current
    if (!t) return
    t.timer = 0
    if (t.pending === null) return
    const v = t.pending
    t.pending = null
    t.wrote = performance.now()
    props.current.onChange(v)
  }
  const cancelFlush = (t) => {
    if (!t.timer) return
    if (t.raf) cancelAnimationFrame(t.timer)
    else clearTimeout(t.timer)
    t.timer = 0
  }
  const set = (p) => {
    const rounded = snapValue(fromPos(clamp(p, 0, 1), def), def)
    let t = turn.current
    if (!t) {
      t = turn.current = { pos: 0, value: null, pending: null, timer: 0, raf: false, wrote: 0, idle: 0 }
      knobBridge.begin()
    }
    t.pos = clamp(p, 0, 1) // where it is between rounded values, so small turns add up
    if (rounded === t.value) return
    t.value = rounded
    setLive(rounded)
    t.pending = rounded
    // heard straight away where the app can move the sound itself; then the project only
    // needs to keep up for the display and the room, so ten times a second is plenty
    const heard = knobBridge.live(props.current.target, rounded)
    if (t.timer) return
    t.raf = !heard
    t.timer = heard ? setTimeout(flush, Math.max(0, 100 - (performance.now() - t.wrote))) : requestAnimationFrame(flush)
  }
  /** Let go: the value it ended on lands in the project (one undo step for the turn). */
  const finish = () => {
    const t = turn.current
    if (!t) return
    cancelFlush(t)
    clearTimeout(t.idle)
    flush()
    turn.current = null
    knobBridge.end()
    setLive(null)
  }
  /** Scrolling and keys have no letting go: the turn ends when they stop for a moment. */
  const finishSoon = () => {
    const t = turn.current
    if (!t) return
    clearTimeout(t.idle)
    t.idle = setTimeout(finish, 300)
  }
  useEffect(() => () => finish(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { finish(); onChange(def.def) }
  const startTyping = () => {
    finish()
    typed.current = false
    setTyping(formatValue(shown, def))
  }
  /** The typed value, if it reads as one (clamped and snapped like a turn); else as it was. */
  const endTyping = (apply) => {
    if (typed.current) return
    typed.current = true
    const v = apply ? parseKnobValue(typing, def) : null
    setTyping(null)
    ref.current?.focus({ preventScroll: true })
    if (v !== null && Number.isFinite(v)) {
      const next = snapValue(v, def)
      if (next !== value) onChange(next)
    }
  }

  // The wheel only turns a knob you mean: one that has focus (you clicked it), or that the
  // pointer has rested on for a moment. Scrolling past it scrolls the page or zooms the canvas.
  const hover = useRef({ since: 0, passed: 0, at: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e) => {
      const h = hover.current
      const now = performance.now()
      const meant = document.activeElement === el || now - h.at < 400 || (h.since && now - h.since >= 300 && now - h.passed >= 300)
      if (!meant) { h.passed = now; return }
      e.preventDefault()
      e.stopPropagation()
      h.at = now
      const from = turn.current?.pos ?? toPos(shown, def)
      set(from + wheelTravel(wheelPixels(e), { fine: e.shiftKey, step }))
      finishSoon()
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
      title={`${def.label}: ${formatValue(shown, def)}${automated ? ' · automated in the song' : ''} · drag, scroll, double-click to type · ${RESET_HINT}${target && automation ? ' · right-click to automate' : ''}`}
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
        onPointerEnter={() => { hover.current.since = performance.now() }}
        onPointerLeave={() => { hover.current.since = 0 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.focus({ preventScroll: true })
          e.currentTarget.setPointerCapture(e.pointerId)
          // from where it shows (a curve's value, while it follows one), so grabbing it doesn't jump
          drag.current = startDrag(e.clientX, e.clientY, turn.current?.pos ?? toPos(shown, def), e.shiftKey)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          if (!d.moved && !pastThreshold(d, e.clientX, e.clientY)) return // a click isn't a drag
          d.moved = true
          set(dragTo(d, e.clientX, e.clientY, e.shiftKey, turn.current?.pos ?? d.from))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d && !d.moved && resetClick(e)) { reset(); return }
          finish()
        }}
        onPointerCancel={() => { drag.current = null; finish() }}
        // let go outside the window, or the capture was taken away: it still lands
        onLostPointerCapture={() => { if (drag.current) { drag.current = null; finish() } }}
        onDoubleClick={(e) => { e.stopPropagation(); startTyping() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); startTyping(); return }
          const by = step || (e.shiftKey ? 0.01 : 0.05)
          const from = turn.current?.pos ?? toPos(shown, def)
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(from + by)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(from - by)
          else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') reset()
          else return
          e.preventDefault()
          finishSoon()
        }}
      >
        <path d={arc(0, 1)} className="knob-track" />
        {Math.abs(pos - origin) > 0.004 && <path d={pos > origin ? arc(origin, pos) : arc(pos, origin)} className="knob-value" />}
        <line x1="18" y1="18" x2={hx} y2={hy} className="knob-hand" />
      </svg>
      {typing !== null && (
        <input
          className="knob-type nodrag"
          autoFocus
          value={typing}
          spellCheck={false}
          aria-label={`${def.label} value`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTyping(e.target.value)}
          onBlur={() => endTyping(true)}
          onKeyDown={(e) => {
            e.stopPropagation() // typing isn't playing notes or shortcuts
            if (e.key === 'Enter') { e.preventDefault(); endTyping(true) }
            else if (e.key === 'Escape') { e.preventDefault(); endTyping(false) }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
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
