/**
 * The arithmetic behind knobs (Knob.jsx) and the other controls that turn like one: no
 * DOM here, so it can be tested on its own (test/knob.test.mjs).
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── the wheel ────────────────────────────────────────────────────────────────
export const NOTCH_PX = 100 // one click of a mouse wheel, in pixels (Chrome, Safari)
const LINE_PX = NOTCH_PX / 3 // Firefox counts lines, three a click
const PAGE_PX = 800

/**
 * A wheel event as pixels along the knob, positive for turning down (the way deltaY
 * scrolls). Whichever axis moved more counts (shift + wheel scrolls sideways); one event
 * never counts for more than three clicks.
 */
export function wheelPixels({ deltaX = 0, deltaY = 0, deltaMode = 0 }) {
  const d = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
  const px = deltaMode === 1 ? d * LINE_PX : deltaMode === 2 ? d * PAGE_PX : d
  return clamp(px, -3 * NOTCH_PX, 3 * NOTCH_PX)
}

/**
 * How far (a share of the whole travel) `px` of wheel turns a knob: about 1.5% a click,
 * a fifth of that fine; a knob in steps moves a step a click (`step`, a share of the travel).
 * Trackpads send many small deltas; they add up the same way, so a flick glides rather
 * than slamming to the end.
 */
export function wheelTravel(px, { fine = false, step = 0 } = {}) {
  return (-px / NOTCH_PX) * (step || (fine ? 0.003 : 0.015))
}

// ── values ───────────────────────────────────────────────────────────────────
/** 0..1 position of a value on a (possibly logarithmic) range, and back. */
export const toPos = (v, { min, max, log }) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min))
export const fromPos = (t, { min, max, log }) => (log ? min * (max / min) ** t : min + t * (max - min))

/** How much of the travel one step is, for a knob that only takes some values (else 0). */
export function stepOf(def) {
  const step = def.choices ? 1 : def.step
  return step && !def.log ? Math.min(1, step / (def.max - def.min)) : 0
}

/**
 * A value as the knob keeps it: in range, on a step for a knob in steps (a choice is a
 * whole index), otherwise to a sensible number of places.
 */
export function snapValue(v, def) {
  const x = Math.min(def.max, Math.max(def.min, v))
  const step = def.choices ? 1 : def.step
  if (step) return Math.min(def.max, Math.max(def.min, Math.round((Math.round((x - def.min) / step) * step + def.min) * 1e6) / 1e6))
  return def.log ? Math.round(x * 100) / 100 : Math.round(x * 1000) / 1000
}

// ── dragging ─────────────────────────────────────────────────────────────────
/**
 * A drag from pointer (x, y) with the knob at `pos` (0..1 of its travel). `range` is the
 * pixels for the whole travel, `fineRange` with shift held.
 */
export function startDrag(x, y, pos, fine = false, { range = 150, fineRange = 600 } = {}) {
  return { x0: x, y0: y, x, y, from: pos, fine, moved: false, range, fineRange }
}

/**
 * Where the drag has the knob now (unclamped), the pointer at (x, y): up adds. `now` is
 * where the knob is; switching fine mode on or off re-anchors there, at the pointer, so the
 * knob carries on from where it is instead of jumping.
 */
export function dragTo(d, x, y, fine, now) {
  if (fine !== d.fine) {
    d.fine = fine
    d.x = x
    d.y = y
    d.from = now
    return now
  }
  return d.from + (d.y - y) / (fine ? d.fineRange : d.range)
}

/** Has the pointer moved far enough from where it went down to be a drag, not a click? */
export const pastThreshold = (d, x, y, px = 3) => Math.max(Math.abs(x - d.x0), Math.abs(y - d.y0)) >= px
