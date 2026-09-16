import kick from './kick.js'

/**
 * Instrument engines: sounds the app makes itself, from settings saved with the track, as
 * opposed to Strudel's samples and synths. An instrument (a channel in a pattern) that
 * uses one carries
 *
 *   engine: { type: 'kick', data: { start: 320, … } }
 *
 * and plays the engine's sound name (`lattice_kick`) like any other sound, so steps, the
 * piano roll, its knobs and the patch around it all work as they do for a sample.
 *
 * An engine definition:
 *   type, label, blurb
 *   kinds       which instruments can use it: 'drum' (steps), 'synth' (notes)
 *   processor   the name its audio-thread processor registers under
 *   voices      how many notes it can sound at once (one output each)
 *   oneShot     whether a hit plays its whole shape whatever the note's length
 *   params      its knobs: { key, group, label, min, max, def, log?, unit?, origin? }
 *   groups      [group key, title] in the order the window shows them
 *   tail(data)  seconds a note rings past its end (or, one-shot, past its start)
 *   dsp         the processor's source (see dsp.js)
 */
export const ENGINES = Object.fromEntries([kick].map((e) => [e.type, e]))

export const ENGINE_PREFIX = 'lattice_'
export const engineSound = (type) => `${ENGINE_PREFIX}${type}`
export const engineOfSound = (sound) => (String(sound ?? '').startsWith(ENGINE_PREFIX) ? ENGINES[String(sound).slice(ENGINE_PREFIX.length)] ?? null : null)

/** Every knob at its default. */
export function engineDefaults(type) {
  return Object.fromEntries((ENGINES[type]?.params ?? []).map((p) => [p.key, p.def]))
}

/** The engine's settings, complete: saved values where valid, defaults for the rest. */
export function engineData(engine) {
  const spec = ENGINES[engine?.type]
  if (!spec) return {}
  const out = {}
  for (const p of spec.params) {
    const v = Number(engine.data?.[p.key])
    out[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def
  }
  return out
}

/**
 * Clean an engine from a (possibly hand-edited) header, for an instrument of `kind`.
 * Only knobs away from their default are kept, so tracks stay small.
 */
export function normalizeEngine(raw, kind) {
  const spec = ENGINES[raw?.type]
  if (!spec || !spec.kinds.includes(kind)) return null
  const full = engineData(raw)
  const data = {}
  for (const p of spec.params) if (full[p.key] !== p.def) data[p.key] = full[p.key]
  return { type: spec.type, data }
}

/** Engines an instrument of `kind` can use. */
export const enginesFor = (kind) => Object.values(ENGINES).filter((e) => e.kinds.includes(kind))
