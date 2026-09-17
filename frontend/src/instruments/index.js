import kick from './kick.js'
import phyllo from './phyllo/index.js'

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
 *   keyOctave   (optional) where the typing keyboard starts in its window
 *   params      its knobs: { key, group, label, min, max, def, log?, unit?, origin? }
 *   groups      [group key, title] in the order the window shows them
 *   tail(data)  seconds a note rings past its end (or, one-shot, past its start)
 *   dsp         the processor's source (see dsp.js)
 *   width       (optional) how wide its window opens, in CSS pixels
 *
 * An engine whose settings are more than a list of knobs (layers, routes…) also has
 *   normalize(raw)        anything → complete settings
 *   encode(data, {cps})   settings → { audio param key: number }
 *   audioParams           the processor's params, { key, min, max, def } (instead of `params`)
 *   knobAt(data, key)     a knob by automation key → { def, value, label, set(data, v) }
 *   voicesFor(data)       (optional) how many voices notes may use (1 for mono)
 */
export const ENGINES = Object.fromEntries([kick, phyllo].map((e) => [e.type, e]))

export const ENGINE_PREFIX = 'lattice_'
export const engineSound = (type) => `${ENGINE_PREFIX}${type}`
export const engineOfSound = (sound) => (String(sound ?? '').startsWith(ENGINE_PREFIX) ? ENGINES[String(sound).slice(ENGINE_PREFIX.length)] ?? null : null)

/** The engine's settings, complete: saved values where valid, defaults for the rest. */
export function engineData(engine) {
  const spec = ENGINES[engine?.type]
  if (!spec) return {}
  if (spec.normalize) return spec.normalize(engine.data)
  const out = {}
  for (const p of spec.params) {
    const v = Number(engine.data?.[p.key])
    out[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def
  }
  return out
}

/**
 * Clean an engine from a (possibly hand-edited) header, for an instrument of `kind`.
 * A list of knobs keeps only those away from their default, so tracks stay small.
 */
export function normalizeEngine(raw, kind) {
  const spec = ENGINES[raw?.type]
  if (!spec || !spec.kinds.includes(kind)) return null
  if (spec.normalize) return { type: spec.type, data: spec.normalize(raw.data) }
  const full = engineData(raw)
  const data = {}
  for (const p of spec.params) if (full[p.key] !== p.def) data[p.key] = full[p.key]
  return { type: spec.type, data }
}

/** The processor's params for an engine. */
export const engineAudioParams = (spec) => spec.audioParams ?? spec.params

/** Settings → the numbers its processor reads. */
export const engineAudio = (spec, data, ctx = {}) => (spec.encode ? spec.encode(data, ctx) : data)

/** One knob by its automation key: { def, value, label }, or null. */
export function engineKnob(spec, data, key) {
  if (spec?.knobAt) return spec.knobAt(data, key)
  const def = spec?.params.find((p) => p.key === key)
  return def ? { def, value: data[key] ?? def.def, label: def.label } : null
}

/** Settings with some knobs moved: { key: value } by automation key. */
export function withKnobs(spec, data, patch) {
  if (!spec?.knobAt) return { ...data, ...patch }
  const next = JSON.parse(JSON.stringify(data))
  for (const [key, v] of Object.entries(patch)) spec.knobAt(next, key)?.set(next, v)
  return next
}

/** Engines an instrument of `kind` can use. */
export const enginesFor = (kind) => Object.values(ENGINES).filter((e) => e.kinds.includes(kind))
