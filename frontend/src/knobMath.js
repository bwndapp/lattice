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
