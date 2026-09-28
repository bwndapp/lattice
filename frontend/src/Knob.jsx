import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAutoLive, useAutomation } from './autoLive.js'
import { KnobMenu } from './KnobMenu.jsx'
import './Knob.css'
import { knobBridge } from './knobBridge.js'
import { clamp, detent, dragTo, fromPos, lockAxis, parseKnobValue, pastThreshold, snapValue, startDrag, stepOf, toPos, undetent, wheelPixels, wheelTravel } from './knobMath.js'

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
const hasMods = (e) => e.shiftKey || e.altKey || e.ctrlKey || e.metaKey

/**
 * Everything that turns a knob: dragging (either way, shift for fine, the pointer locked so
 * a long sweep never meets the edge of the screen), the wheel, the keys, typing a value and
 * resetting it. Options (read fresh on every event):
 *
 *   shown        the value it shows (a curve's value, while it follows one): turns start there
 *   toPos/fromPos  value ↔ 0..1 of the travel      snap(v)   a value as it's kept
 *   onChange(v)  write it to the project           live(v)   move the sound at once; true if it did
 *   resetTo      the value reset gives             parse/format   for typing a value
 *   centre       0..1 of a gentle catch while dragging (a knob that goes either way), or null
 *   step         a step's share of the travel (a knob in steps), or 0
 *
 * While it turns, only the control redraws (`live` is the value meanwhile); the sound
 * follows at once where `live` can move it, and the project is written at most once a
 * frame, or ten times a second when the sound already follows, then once more when you let
 * go (or the scrolling or keys stop for a moment): a whole turn is one undo step.
 */
function useKnobControl(options) {
  const opts = useRef(options)
  opts.current = options
  const ref = useRef(null)
  const [live, setLive] = useState(null)
  const [peek, setPeek] = useState(false) // the pointer is on it with a modifier held
  const [typing, setTyping] = useState(null)
  const ctl = useRef(null)
  if (!ctl.current) ctl.current = makeControl(opts, ref, setLive, setPeek, setTyping)
  const c = ctl.current
  c.typingText = typing
  useEffect(() => {
    const el = ref.current
    el?.addEventListener('wheel', c.wheel, { passive: false })
    return () => { el?.removeEventListener('wheel', c.wheel); c.dispose() }
  }, [c])
  return { ref, live, typing, setTyping, readout: live !== null || peek, ...c.api }
}

function makeControl(opts, ref, setLive, setPeek, setTyping) {
  const posOf = (v) => clamp(opts.current.toPos(v), 0, 1)
  let turn = null // a drag, or a burst of scrolling or key presses
  let drag = null
  let rect = null // where the control is on screen, for the readout
  const hover = { since: 0, passed: 0, at: 0, mods: false }
  let typed = false
  const c = { typingText: null }

  const flush = () => {
    const t = turn
    if (!t) return
    t.timer = 0
    if (t.pending === null) return
    const v = t.pending
    t.pending = null
    t.wrote = performance.now()
    opts.current.onChange(v)
  }
  const measure = () => { rect = ref.current?.getBoundingClientRect() ?? null }
  const set = (p) => {
    const o = opts.current
    let t = turn
    if (!t) {
      t = turn = { pos: 0, value: null, pending: null, timer: 0, raf: false, wrote: 0, idle: 0 }
      knobBridge.begin()
      measure()
    }
    t.pos = clamp(p, 0, 1) // where it is between kept values, so small turns add up
    const v = o.snap(o.fromPos(t.pos))
    if (v === t.value) return
    t.value = v
    setLive(v)
    t.pending = v
    // heard straight away where the app can move the sound itself; then the project only
    // needs to keep up for the display and the room, so ten times a second is plenty
    const heard = !!o.live?.(v)
    if (t.timer) return
    t.raf = !heard
    t.timer = heard ? setTimeout(flush, Math.max(0, 100 - (performance.now() - t.wrote))) : requestAnimationFrame(flush)
  }
  /** Let go: the value it ended on lands in the project (one undo step for the turn). */
  const finish = () => {
    const t = turn
    if (!t) return
    if (t.timer) { if (t.raf) cancelAnimationFrame(t.timer); else clearTimeout(t.timer) }
    clearTimeout(t.idle)
    flush()
    turn = null
    knobBridge.end()
    setLive(null)
  }
  /** Scrolling and keys have no letting go: the turn ends when they stop for a moment. */
  const finishSoon = () => {
    if (!turn) return
    clearTimeout(turn.idle)
    turn.idle = setTimeout(finish, 300)
  }
  const from = () => turn?.pos ?? posOf(opts.current.shown)
  const reset = () => {
    finish()
    const o = opts.current
    if (o.snap(o.resetTo) !== o.value) o.onChange(o.resetTo)
  }

  // ── dragging ──
  // The pointer is locked while dragging, so a long sweep doesn't stop at the edge of the
  // screen, and comes back where the drag started; where a lock isn't allowed, it hides.
  const hide = (d) => {
    if (d.hidden) return
    d.hidden = true
    document.body.classList.add('knob-hide-cursor')
  }
  const hold = (d) => {
    const el = d.el
    d.lockChange = () => {
      if (document.pointerLockElement === el) d.locked = true
      else if (d.locked && drag === d) endDrag() // Escape let go of the lock: the drag ends there
    }
    d.lockError = () => hide(d)
    document.addEventListener('pointerlockchange', d.lockChange)
    document.addEventListener('pointerlockerror', d.lockError)
    try {
      if (!el.requestPointerLock) hide(d)
      else el.requestPointerLock()?.catch?.(() => hide(d))
    } catch { hide(d) }
  }
  const unhold = (d) => {
    if (d.lockChange) {
      document.removeEventListener('pointerlockchange', d.lockChange)
      document.removeEventListener('pointerlockerror', d.lockError)
    }
    if (document.pointerLockElement === d.el) document.exitPointerLock()
    if (d.hidden) document.body.classList.remove('knob-hide-cursor')
  }
  const move = (e) => {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    if (document.pointerLockElement === d.el) { d.vx += e.movementX; d.vy += e.movementY } else if (!d.locked) { d.vx = e.clientX; d.vy = e.clientY }
    if (!d.moved) {
      if (!pastThreshold(d, d.vx, d.vy)) return // a click isn't a drag
      lockAxis(d, d.vx, d.vy)
      if (d.mouse) hold(d)
    }
    const centre = opts.current.centre
    d.raw = dragTo(d, d.vx, d.vy, e.shiftKey, d.raw ?? d.from)
    set(centre != null ? detent(d.raw, centre) : d.raw)
  }
  const up = (e) => {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    endDrag()
    if (!d.moved && resetClick(e)) reset()
  }
  const cancel = (e) => { if (drag && e.pointerId === drag.id) endDrag() }
  function endDrag() {
    const d = drag
    if (!d) return
    drag = null
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    unhold(d)
    try { d.el.releasePointerCapture(d.id) } catch { /* already let go */ }
    finish()
  }
  const onPointerDown = (e) => {
    if (e.button !== 0 || drag) return
    const el = e.currentTarget
    e.preventDefault()
    el.focus?.({ preventScroll: true })
    try { el.setPointerCapture(e.pointerId) } catch { /* the window listeners carry it */ }
    const o = opts.current
    const at = from()
    // from where it shows (a curve's value, while it follows one), so grabbing it doesn't jump
    const d = startDrag(e.clientX, e.clientY, o.centre != null ? undetent(at, o.centre) : at, e.shiftKey, o)
    d.el = el
    d.id = e.pointerId
    d.mouse = e.pointerType === 'mouse'
    d.vx = e.clientX
    d.vy = e.clientY
    drag = d
    // on the window, so letting go anywhere (outside the window too) still lands the value
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
  }

  // ── the wheel: only a control you mean, one with focus or the pointer rested on it;
  // scrolling past scrolls the page or zooms the canvas ──
  c.wheel = (e) => {
    const el = ref.current
    const now = performance.now()
    const meant = el?.contains(document.activeElement) || now - hover.at < 400 || (hover.since && now - hover.since >= 300 && now - hover.passed >= 300)
    if (!meant || opts.current.disabled) { hover.passed = now; return }
    e.preventDefault()
    e.stopPropagation()
    hover.at = now
    const o = opts.current
    set(from() + wheelTravel(wheelPixels(e), { step: e.shiftKey ? o.fineNotch ?? 0.003 : o.notch ?? 0.015 }))
    finishSoon()
  }

  // ── the pointer resting on it with a modifier held shows the value ──
  const mods = (e) => {
    const m = hasMods(e)
    if (m === hover.mods) return
    hover.mods = m
    if (m) measure()
    setPeek(m)
  }
  const onPointerEnter = (e) => {
    hover.since = performance.now()
    mods(e)
    window.addEventListener('keydown', mods)
    window.addEventListener('keyup', mods)
  }
  const onPointerLeave = () => {
    hover.since = 0
    window.removeEventListener('keydown', mods)
    window.removeEventListener('keyup', mods)
    hover.mods = false
    setPeek(false)
  }
  const onPointerMove = (e) => { if (!drag) mods(e) }

  // ── keys: arrows (shift for fine), page up and down, Home for the default ──
  const onKeyDown = (e) => {
    const o = opts.current
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]
    if (dir) set(from() + dir * (e.shiftKey ? o.fineKeyStep ?? 0.01 : o.keyStep ?? 0.05))
    else if (e.key === 'PageUp' || e.key === 'PageDown') set(from() + (e.key === 'PageUp' ? 1 : -1) * (o.pageStep ?? 0.2))
    else if (e.key === 'Home') { reset(); e.preventDefault(); return true }
    else return false
    e.preventDefault()
    e.stopPropagation()
    finishSoon()
    return true
  }

  // ── typing a value ──
  const startTyping = () => {
    finish()
    typed = false
    setTyping(opts.current.format(opts.current.shown))
  }
  /** The typed value, if it reads as one (clamped and snapped like a turn); else as it was. */
  const endTyping = (apply) => {
    if (typed) return
    typed = true
    const o = opts.current
    const v = apply ? o.parse(c.typingText) : null
    setTyping(null)
    ref.current?.focus?.({ preventScroll: true })
    if (v === null || !Number.isFinite(v)) return
    const next = o.snap(v)
    if (next !== o.value) o.onChange(next)
  }

  c.dispose = () => {
    endDrag()
    finish()
    onPointerLeave()
  }
  c.api = { onPointerDown, onPointerEnter, onPointerLeave, onPointerMove, onKeyDown, reset, finish, startTyping, endTyping, rect: () => rect }
  return c
}

/** The value, floating above the control while it turns (or the pointer rests on it with a modifier). */
function KnobReadout({ control, text }) {
  const r = control.readout && control.rect()
  if (!r) return null
  return createPortal(<div className="knob-readout" style={{ left: r.left + r.width / 2, top: r.top }} aria-hidden>{text}</div>, document.body)
}

/** A value with its unit, for the readout. */
export function readoutText(v, def) {
  const s = formatValue(v, def)
  if (def.choices || def.key === 'pan') return s
  if (def.unit === 'hz') return `${s}Hz`
  if (def.unit === 'db') return s.endsWith(' off') ? s : `${s} dB`
  if (!def.unit || def.unit === 'bi' || def.unit === 'c') return `${s}%`
  return s
}

/**
 * A knob: drag up/down or sideways (shift for fine), scroll, arrow keys, double-click (or
 * Enter) to type a value, ctrl/cmd-click, alt-click or Home to reset (see useKnobControl).
 * With a `target` (see automation.js), right-click offers to automate it; an automated knob
 * wears a mark and, while the song plays, turns with its curve, and the sound follows a
 * turn at once where the app can move it (knobBridge.js).
 */
export default function Knob({ def, value, onChange, target = null }) {
  const automation = useAutomation()
  const automated = !!target && !!automation?.automated.has(target)
  const following = useAutoLive(automated ? target : null) // where its curve has it, while playing
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // a knob in steps shows the step it's on, whatever an old project stored
  const resting = def.choices ? snapValue(following ?? value, def) : following ?? value
  const origin = def.origin !== undefined ? clamp(toPos(def.origin, def), 0, 1) : def.key === 'pan' ? 0.5 : 0
  const bipolar = (def.unit === 'bi' || def.key === 'pan' || def.origin !== undefined) && origin >= 0.1 && origin <= 0.9
  const step = stepOf(def)
  const control = useKnobControl({
    value,
    shown: resting,
    toPos: (v) => toPos(v, def),
    fromPos: (p) => fromPos(p, def),
    snap: (v) => snapValue(v, def),
    onChange,
    live: target ? (v) => knobBridge.live(target, v) : null,
    resetTo: def.def,
    parse: (text) => parseKnobValue(text, def),
    format: (v) => formatValue(v, def),
    centre: bipolar ? origin : null,
    notch: step || 0.015,
    fineNotch: step || 0.003,
    keyStep: step || 0.05,
    fineKeyStep: step || 0.01,
    pageStep: Math.max(step, 0.2),
  })
  const { live, typing } = control
  const shown = live ?? resting
  const pos = clamp(toPos(shown, def), 0, 1)
  const changed = Math.abs(shown - def.def) > 1e-9

  // arc from 225° (min) round to -45° (max)
  const angle = (a) => ((225 - a * 270) * Math.PI) / 180
  const r = 13
  const pt = (a) => [18 + r * Math.cos(angle(a)), 18 - r * Math.sin(angle(a))]
  const arc = (a0, a1) => {
    const [x0, y0] = pt(a0)
    const [x1, y1] = pt(a1)
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`
  }
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
        ref={control.ref}
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
        onPointerEnter={control.onPointerEnter}
        onPointerLeave={control.onPointerLeave}
        onPointerMove={control.onPointerMove}
        onPointerDown={control.onPointerDown}
        onDoubleClick={(e) => { e.stopPropagation(); control.startTyping() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); control.startTyping() }
          else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); control.reset() }
          else control.onKeyDown(e)
        }}
      >
        {/* a little room round the knob that still grabs it, without taking any space */}
        <circle cx="18" cy="18" r="21" className="knob-hit" />
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
          onChange={(e) => control.setTyping(e.target.value)}
          onBlur={() => control.endTyping(true)}
          onKeyDown={(e) => {
            e.stopPropagation() // typing isn't playing notes or shortcuts
            if (e.key === 'Enter') { e.preventDefault(); control.endTyping(true) }
            else if (e.key === 'Escape') { e.preventDefault(); control.endTyping(false) }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      <KnobReadout control={control} text={readoutText(shown, def)} />
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
