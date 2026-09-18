/**
 * One person, one face, everywhere in the app.
 *
 * The room gives everybody a short stable hash of their account (`bot`, see collab.py).
 * Everything about how they're drawn is read off it, so the same person is recognisably
 * themselves in the tray, on a browse card, in any room, tomorrow — which is the whole
 * point. Nothing here is random and nothing is stored: the same hash always produces the
 * same face, on every machine, with no lookup.
 *
 *   botLook(bot, color) → { skin, ink, ring, pupils, mouth, fx }
 *
 * `color` comes from the room rather than from here, because two people in one room have
 * to be told apart and the room is the only thing that can see both of them (it hands out
 * their own colour unless somebody already has it). Everything else is theirs alone.
 *
 * The finishes are picked from a short list rather than the full ten knobs, because the
 * job is to be recognisable at 26 pixels across, not to be a material library. A chrome
 * head and a holographic one are obviously different people at a glance; two slightly
 * different bloom amounts are not.
 */

/** A number from a slice of the hash, 0..1. Each slice is independent of the others. */
const at = (bot, i, span = 2) => parseInt(bot.slice(i, i + span) || '0', 16) / (16 ** span - 1)

/**
 * The finishes worth telling apart, each with the range it reads well over. Ordered so the
 * common ones come first: most people get something quiet, and the loud ones stay rare
 * enough to mean something.
 */
const FINISHES = [
  { gloss: 0.85 },
  { rim: 0.7 },
  { gloss: 0.6, bloom: 0.5 },
  { chrome: 0.8 },
  { holo: 0.65 },
  { glass: 0.55 },
  { scan: 0.5, bloom: 0.35 },
  { scratch: 0.6, gloss: 0.4 },
]

/** A colour pushed most of the way to black, keeping its hue — a head, not a hole. */
function dark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return '#0b0b0f'
  const n = parseInt(m[1], 16)
  const mix = (c, floor) => Math.round(c * 0.11 + floor)
  return `#${[mix((n >> 16) & 255, 7), mix((n >> 8) & 255, 7), mix(n & 255, 10)]
    .map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`
}

/**
 * How to draw one person. `color` is what the room gave them; everything else is read off
 * their hash. Safe to call every render — it only reads a string.
 */
export function botLook(bot, color) {
  const hash = typeof bot === 'string' && bot.length >= 8 ? bot : '00000000'
  const ink = color || '#e9ebec'
  return {
    skin: dark(ink), // their own hue, almost all the way down, so the head reads as theirs
    ink,
    ring: ink,
    // two coin flips they keep for good: enough to tell apart two people the palette
    // happened to give the same colour to
    pupils: at(hash, 8, 1) > 0.45,
    mouth: at(hash, 9, 1) > 0.6,
    fx: FINISHES[Math.floor(at(hash, 4) * FINISHES.length * 0.999)],
  }
}

/** The CSS custom properties bbot reads, as a style object. */
export const botStyle = (look) => ({ '--face-skin': look.skin, '--face-ink': look.ink, '--face-ring': look.ring })
