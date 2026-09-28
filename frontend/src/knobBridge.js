/**
 * How a turning knob reaches the sound and the undo history without rewriting the whole
 * project on every move (see Knob.jsx).
 *
 *   live(target, value)  the app moves the sound there at once, the cheap way (the app's
 *                        own reverb, delay, insert and instrument knobs, see automation.js
 *                        `appParam`); false when the knob has no such path, so its value
 *                        has to go through the project to be heard
 *   begin() / end()      one gesture (a drag, a burst of scrolling): every project write
 *                        inside it is one undo step
 */
let handler = null
export const knobBridge = {
  gesture: 0, // which gesture is going on (counts up), while `depth` > 0
  depth: 0,
  onLive(fn) {
    handler = fn
    return () => { if (handler === fn) handler = null }
  },
  live(target, value) {
    if (!target || !handler) return false
    try { return !!handler(target, value) } catch (err) { console.warn('[knob] could not move the sound', err); return false }
  },
  begin() { if (this.depth++ === 0) this.gesture += 1 },
  end() { this.depth = Math.max(0, this.depth - 1) },
  /** The gesture going on now, or 0. */
  get current() { return this.depth ? this.gesture : 0 },
}
