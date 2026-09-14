/**
 * Song position, seeking and looping on top of Strudel's scheduler.
 *
 * The scheduler only counts cycles up from 0 when it starts and can't seek. So the
 * transport reshapes the evaluated pattern (through the repl's `editPattern` hook) and
 * keeps the arithmetic that maps scheduler time `s` to song time:
 *
 *   no loop:  played(c) = song(c + k)                       position = s + k
 *   loop:     played(c) = song(from + (c + k) mod len)      position = from + (s + k) mod len
 *
 * Seeking changes k and re-sets the pattern; the scheduler never stops. Bars are cycles.
 */
const mod = (a, n) => ((a % n) + n) % n

export function createTransport() {
  const listeners = new Set()
  const t = {
    scheduler: null,
    raw: null, // the pattern as evaluated, in song time
    k: 0,
    start: 0, // where playback begins (the cue), in cycles
    loop: { on: false, from: 0, to: 4 },
    beats: 4, // beats per bar, for display, snapping and BPM

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    loopLength() {
      return Math.max(0, t.loop.to - t.loop.from)
    },
    looping() {
      return t.loop.on && t.loopLength() > 0
    },

    /** repl editPattern hook: remember the song-time pattern, return what should play. */
    edit(pattern) {
      t.raw = pattern
      return t.shape(pattern)
    },
    shape(pattern) {
      let p = pattern
      if (t.looping()) p = p.ribbon(t.loop.from, t.loopLength())
      return t.k ? p.early(t.k) : p
    },

    playing() {
      return !!t.scheduler?.started
    },

    /** Song position in cycles (bars). While stopped: the cue. */
    position() {
      if (!t.playing()) return t.start
      const s = t.scheduler.now() + t.k
      return t.looping() ? t.loop.from + mod(s, t.loopLength()) : s
    },

    /** Point k at song position p for scheduler time s. */
    aim(p, s) {
      t.k = t.looping() ? mod(p - t.loop.from - s, t.loopLength()) : p - s
    },

    /** Call just before starting from stopped: the scheduler will count up from 0. */
    cue() {
      t.aim(t.start, 0)
    },

    /** Jump to song position p (cycles). A jump outside an active loop turns the loop off. */
    seek(p) {
      p = Math.max(0, p)
      if (t.looping() && (p < t.loop.from || p >= t.loop.to)) t.loop = { ...t.loop, on: false }
      if (t.playing()) {
        t.aim(p, t.scheduler.now())
        t.apply()
      } else {
        t.start = p
      }
      t.emit()
    },

    setLoop(loop) {
      const pos = t.position()
      t.loop = { ...t.loop, ...loop }
      if (t.loop.to <= t.loop.from) t.loop.to = t.loop.from + 1 / t.beats
      if (t.playing()) {
        const inside = pos >= t.loop.from && pos < t.loop.to
        t.aim(t.looping() && !inside ? t.loop.from : pos, t.scheduler.now())
        t.apply()
      } else if (t.looping() && (t.start < t.loop.from || t.start >= t.loop.to)) {
        t.start = t.loop.from
      }
      t.emit()
    },

    setBeats(beats) {
      t.beats = beats
      t.emit()
    },

    /** Stop and remember where we were, so play resumes there. */
    pausedAt(position) {
      t.start = position
      t.emit()
    },

    /** Re-set the reshaped pattern on the running scheduler. */
    apply() {
      if (t.raw && t.scheduler) t.scheduler.setPattern(t.shape(t.raw), false)
    },

    emit() {
      listeners.forEach((fn) => fn())
    },
  }
  return t
}

/** "3.2" → song position of bar 3, beat 2 (both 1-based). Null if it doesn't parse. */
export function parseBarBeat(text, beats) {
  const m = String(text).trim().match(/^(\d+)(?:[.:](\d+))?$/)
  if (!m) return null
  const bar = Number(m[1])
  const beat = m[2] === undefined ? 1 : Number(m[2])
  if (bar < 1 || beat < 1 || beat > beats) return null
  return bar - 1 + (beat - 1) / beats
}

/** Song position → "003.2" (bar and beat, 1-based). */
export function formatBarBeat(position, beats) {
  const bar = Math.floor(position + 1e-9)
  const beat = Math.floor((position - bar) * beats + 1e-6)
  return `${String(bar + 1).padStart(3, '0')}.${Math.min(beat, beats - 1) + 1}`
}
