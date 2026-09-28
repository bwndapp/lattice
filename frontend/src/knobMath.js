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

// ── typing a value ───────────────────────────────────────────────────────────
// a knob with no unit that sets a level stores it as a gain (1 = as it was), so dB converts
const LEVELISH = /gain|vol|level|amp|fader|out|mix|send/i

/**
 * What a typed value means on this knob, in what the knob stores, or null. Units are
 * optional and read the way the knob shows them: "2k" or "2 kHz" → 2000, "-6 dB" (a
 * level knob that stores a gain gets 10^(dB/20)), "250ms" or "1.5s", "40%" on a 0…1
 * knob, "L30" / "C" / "R50" on a pan, a choice by name. A bare number means what the knob
 * shows: "80" on a knob showing 80 for 0.8. Not clamped: the knob does that.
 */
export function parseKnobValue(text, def) {
  const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, '')
  if (!t) return null
  if (def.choices) {
    const i = def.choices.findIndex((c) => String(c).toLowerCase() === t)
    if (i >= 0) return i
    const n = Number(t)
    return Number.isInteger(n) ? n : null
  }
  if (def.key === 'pan') {
    if (t === 'c' || t === 'center' || t === 'centre') return 0.5
    const side = /^([lr])(\d*\.?\d+)%?$/.exec(t)
    if (side) return 0.5 + (side[1] === 'l' ? -1 : 1) * Number(side[2]) / 200
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(.*)$/.exec(t)
  if (!m) return null
  let n = Number(m[1])
  let unit = m[2]
  if (!Number.isFinite(n)) return null
  // a thousand of whatever it is: "2k", "2khz", "1.2ks"
  if (/^k(hz)?$/.test(unit)) { n *= 1000; unit = unit.slice(1) }
  if (def.key === 'pan') return unit === '' || unit === '%' ? 0.5 + n / 200 : null
  const shown = def.unit
  switch (unit) {
    case '':
      if (shown === 'hz' || shown === 'x' || shown === 'ct' || shown === 'db' || shown === 'ratio') return n
      if (shown === 's') return n > def.max ? n / 1000 : n // "250" on a knob that stops at 2s means ms
      if (shown === 'bar') return n / 16
      return n / 100 // shown as a percentage (0…1 and ±1 knobs)
    case 'hz':
      return shown === 'hz' ? n : null
    case 'ms':
      return shown === 's' ? n / 1000 : null
    case 's': case 'sec':
      return shown === 's' ? n : null
    case 'db':
      if (shown === 'db') return n
      return !shown && LEVELISH.test(`${def.key} ${def.label}`) ? 10 ** (n / 20) : null
    case '%':
      return !shown || shown === 'bi' ? n / 100 : null
    case 'x':
      return shown === 'x' ? n : null
    case 'ct': case 'c': case 'cents':
      return shown === 'ct' ? n : null
    case ':1':
      return shown === 'ratio' ? n : null
    case '/16':
      return shown === 'bar' ? n / 16 : null
    default:
      return null
  }
}
