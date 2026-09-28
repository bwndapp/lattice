import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './Knob.css'
import { knobBridge } from './knobBridge.js'
import { clamp, detent, dragTo, lockAxis, pastThreshold, startDrag, undetent, wheelPixels, wheelTravel } from './knobMath.js'

/*
 * One way of turning things, for every knob-like control: the knobs (Knob.jsx), the tempo,
 * Syrup's modulation rings and route amounts. The arithmetic is in knobMath.js.
 */

// reset is cmd-click on a Mac (ctrl-click there is a right-click), ctrl-click elsewhere; alt-click on both
const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
const resetClick = (e) => e.altKey || (MAC ? e.metaKey : e.ctrlKey || e.metaKey)
export const RESET_HINT = `${MAC ? 'cmd' : 'ctrl'}-click or Home to reset`
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
 *   range, fineRange   pixels of drag for the whole travel (150, 600)
 *   notch, fineNotch   travel a click of the wheel turns it (0.015, 0.003)
 *   keyStep, fineKeyStep, pageStep   travel the arrow keys and page up/down turn it
 *   onClick(e)   a click that wasn't a drag (the tempo types)   clickReset  false: no ctrl-click reset
 *   focus        false: pressing doesn't take focus            disabled   ignore the pointer and wheel
 *
 * snap(v, anchor, fine) also gets where the turn started and whether it's fine now, for a
 * control that counts in steps from there.
 *
 * While it turns, only the control redraws (`live` is the value meanwhile); the sound
 * follows at once where `live` can move it, and the project is written at most once a
 * frame, or ten times a second when the sound already follows, then once more when you let
 * go (or the scrolling or keys stop for a moment): a whole turn is one undo step.
 */
export function useKnobControl(options) {
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
  const set = (p, fine = false) => {
    const o = opts.current
    let t = turn
    if (!t) {
      t = turn = { pos: 0, value: null, pending: null, timer: 0, raf: false, wrote: 0, idle: 0, anchor: o.shown, fine }
      knobBridge.begin()
      measure()
    }
    // a control that counts in whole steps from where it was (the tempo) starts counting
    // again from where it is when fine mode comes or goes
    if (fine !== t.fine) { t.fine = fine; if (t.value !== null) t.anchor = t.value }
    t.pos = clamp(p, 0, 1) // where it is between kept values, so small turns add up
    const v = o.snap(o.fromPos(t.pos), t.anchor, fine)
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
    set(centre != null ? detent(d.raw, centre) : d.raw, e.shiftKey)
  }
  const up = (e) => {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    endDrag()
    if (d.moved) return
    if (opts.current.clickReset !== false && resetClick(e)) reset()
    else opts.current.onClick?.(e)
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
    if (e.button !== 0 || drag || opts.current.disabled) return
    const el = e.currentTarget
    e.preventDefault()
    if (opts.current.focus !== false) el.focus?.({ preventScroll: true })
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
    set(from() + wheelTravel(wheelPixels(e), { step: e.shiftKey ? o.fineNotch ?? 0.003 : o.notch ?? 0.015 }), e.shiftKey)
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
    if (dir) set(from() + dir * (e.shiftKey ? o.fineKeyStep ?? 0.01 : o.keyStep ?? 0.05), e.shiftKey)
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
export function KnobReadout({ control, text }) {
  const r = control.readout && control.rect()
  if (!r) return null
  return createPortal(<div className="knob-readout" style={{ left: r.left + r.width / 2, top: r.top }} aria-hidden>{text}</div>, document.body)
}

/** The small field for typing a value, over the control (double-click, or Enter). */
export function KnobTypeInput({ control, label }) {
  if (control.typing === null) return null
  return (
    <input
      className="knob-type nodrag"
      autoFocus
      value={control.typing}
      spellCheck={false}
      aria-label={`${label} value`}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => control.setTyping(e.target.value)}
      onBlur={() => control.endTyping(true)}
      onKeyDown={(e) => {
        e.stopPropagation() // typing isn't playing notes or shortcuts
        if (e.key === 'Enter') { e.preventDefault(); control.endTyping(true) }
        else if (e.key === 'Escape') { e.preventDefault(); control.endTyping(false) }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
