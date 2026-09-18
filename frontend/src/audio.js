import { getAudioContext, getSampleBuffer, getSampleInfo, getSound, getSuperdoughAudioController, initAudio, resetGlobalEffects, soundMap, superdough } from '@strudel/webaudio'
import { getFontBufferSource } from '@strudel/soundfonts'
import { getSoundIndex } from '@strudel/core'
import { auditionCode, generateCode, paramValue, paramsFor } from './project'
import { stackLanes } from './exportAudio.js'
import { GLOBAL_DELAY, GLOBAL_REVERB, routeVoice, silenceFx } from './fxbus.js'
import { evaluate } from '@strudel/core'
import { transpiler } from '@strudel/transpiler'
import { prepareInstruments, registerEngineSounds, releaseHeld } from './instruments/host.js'

// the app's own instruments are sounds like any other (instruments/)
registerEngineSounds()

/**
 * Everything Strudel has loaded, grouped for browsing: drum kits (bank → sounds),
 * single samples, synths and soundfont instruments. Kits that are only aliases of
 * another kit (tr909 → rolandtr909) are folded into the longer name.
 */
export function soundCatalog() {
  const dict = soundMap.get()
  const kits = new Map()
  const samples = []
  const synths = []
  const instruments = []
  for (const [key, entry] of Object.entries(dict)) {
    const data = entry?.data ?? {}
    const count = Array.isArray(data.samples) ? data.samples.length : data.samples ? Object.keys(data.samples).length : 1
    if (data.type === 'synth') synths.push({ key, count: 1 })
    else if (data.type === 'soundfont') instruments.push({ key, count: data.fonts?.length ?? 1 })
    else if (data.type === 'sample') {
      const cut = key.indexOf('_')
      if (cut > 0) {
        const bank = key.slice(0, cut)
        if (!kits.has(bank)) kits.set(bank, [])
        kits.get(bank).push({ key: key.slice(cut + 1), count, entry })
      } else samples.push({ key, count })
    }
  }
  // fold alias kits: same sound objects under a shorter name
  const byName = [...kits.entries()].sort((a, b) => b[0].length - a[0].length)
  const kept = []
  for (const [bank, sounds] of byName) {
    if (sounds.length < 2) continue
    const alias = kept.find((k) => k.sounds[0] && sounds.some((s) => k.sounds.some((t) => t.key === s.key && t.entry === s.entry)))
    if (alias) continue
    kept.push({ bank, sounds })
  }
  const clean = (list) => list.map(({ key, count }) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key))
  return {
    kits: kept.map(({ bank, sounds }) => ({ bank, sounds: clean(sounds) })).sort((a, b) => a.bank.localeCompare(b.bank)),
    samples: clean(samples),
    synths: clean(synths),
    instruments: clean(instruments),
  }
}

/** Call `fn` whenever the loaded sounds change (samples arrive after page load). */
export function onSoundsChange(fn) {
  return soundMap.listen(fn)
}

const PREVIEW_KEYS = { lpf: 'cutoff', lpq: 'resonance', hpf: 'hcutoff' }

/** Play one hit of a channel's sound right now, with its knob settings. */
export function previewChannel(ch, { note, n, hold = null } = {}) {
  if (!ch || ch.kind === 'code') return
  const value = { s: ch.sound, _c: ch.id } // _c: an engine instrument plays with its own settings
  if (ch.kind === 'drum' && ch.bank) value.bank = ch.bank
  if (ch.kind === 'synth') value.note = note ?? 48
  else if (ch.engine && note !== undefined) value.note = note // an engine drum takes a pitch from the keyboard
  const [sound, variation] = String(ch.sound).split(':')
  value.s = sound
  if (n !== undefined || variation !== undefined) value.n = Number(n ?? variation)
  for (const def of paramsFor(ch.kind)) {
    const v = paramValue(ch, def.key)
    if (v === def.def) continue
    if (def.key === 'crush') value.crush = Math.round(16 - v * 14)
    else if (def.key === 'room' || def.key === 'delay') (value.fxsends ??= []).push([def.key === 'room' ? GLOBAL_REVERB : GLOBAL_DELAY, v])
    else value[PREVIEW_KEYS[def.key] ?? def.key] = v
  }
  if (hold != null) value._hold = hold
  play(value, hold != null ? HOLD_MAX : ch.kind === 'synth' ? 0.4 : 0.25)
}

/** The longest a held note lasts if its key-up never comes. */
const HOLD_MAX = 30
let holds = 0

/**
 * Play a note for as long as a key is down: returns the function to call when it comes up.
 * An instrument engine holds the note and then plays its release; any other sound plays
 * its usual short hit.
 */
export function holdInPatch(project, patternId, ch, { note, pitched = false } = {}) {
  if (!ch?.engine) {
    previewInPatch(project, patternId, ch, { note, pitched })
    return () => {}
  }
  const id = ++holds
  previewInPatch(project, patternId, ch, { note, pitched, hold: id })
  let done = false
  return () => { if (!done) { done = true; releaseHeld(id) } }
}

/** Play a raw sound (for the sound browser). */
export function previewSound({ s, bank, n, note }) {
  const value = { s }
  if (bank) value.bank = bank
  if (n !== undefined) value.n = n
  if (note !== undefined) value.note = note
  play(value, note !== undefined ? 0.5 : 0.3)
}

function play(value, duration) {
  try {
    const ac = getAudioContext()
    if (ac.state !== 'running') ac.resume()
    Promise.resolve(superdough(routeVoice(value), ac.currentTime + 0.03, duration)).catch(() => {})
  } catch { /* audio not ready yet */ }
}

let audioReady = null
/** After an export: the context it used is gone, so the engine starts again on the next play. */
export function forgetAudio() {
  audioReady = null
}
/** Start the audio engine (context + effect worklets) once; safe to call from any gesture. */
export function ensureAudio() {
  if (!audioReady) audioReady = initAudio().then(() => prepareInstruments()).catch(() => {})
  const ac = getAudioContext()
  if (ac.state !== 'running') ac.resume().catch(() => {})
  return audioReady
}

const warmed = new Map() // sample url or font:note → loading promise
const yieldToAudio = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Start loading whatever sounds one hap needs; returns the loading promise, if any. */
function warm(v, seen) {
  if (!v || typeof v !== 'object' || typeof v.s !== 'string') return null
  const key = v.bank ? `${v.bank}_${v.s}` : v.s
  const data = getSound(key)?.data
  if (!data) return null
  if (data.type === 'engine') return seen.has('engine') ? null : (seen.add('engine'), prepareInstruments())
  try {
    let id
    let load
    if (data.type === 'sample' && data.samples) {
      const value = { ...v, s: key }
      id = getSampleInfo(value, data.samples).url
      load = () => getSampleBuffer(value, data.samples)
    } else if (data.type === 'soundfont' && data.fonts?.length) {
      const font = data.fonts[getSoundIndex(v.n, data.fonts.length)]
      id = `${font}:${v.note ?? v.freq ?? 'c3'}`
      load = () => getFontBufferSource(font, v, getAudioContext())
    } else return null
    if (seen.has(id)) return null
    seen.add(id)
    if (!warmed.has(id)) warmed.set(id, load().catch(() => warmed.delete(id)))
    return warmed.get(id)
  } catch {
    return null // an odd value: let the scheduler deal with it
  }
}

/**
 * Load every sample and instrument note a pattern plays over the next `cycles` cycles.
 * Strudel otherwise loads a sound the first time it's triggered and drops that hit if the
 * file isn't ready in time, so a fresh page starts with drums fading in one by one.
 *
 * Querying a pattern is expensive, so it goes one cycle at a time and yields in between:
 * the scheduler's clock must never be held up (a late tick skips notes). Resolves once
 * the sounds are loaded, or after `timeout` ms, whichever comes first.
 */
export async function preloadPattern(pattern, { from = 0, cycles = 16, timeout = 4000, stillWanted = () => true } = {}) {
  if (!pattern?.queryArc) return
  const jobs = []
  const seen = new Set()
  for (let c = from; c < from + cycles; c++) {
    if (!stillWanted()) return
    let haps
    try {
      haps = pattern.queryArc(c, c + 1, { _cps: 0.5 })
    } catch {
      return
    }
    for (const hap of haps) {
      if (!hap.hasOnset()) continue
      const job = warm(hap.value, seen)
      if (job) jobs.push(job)
    }
    await yieldToAudio()
  }
  if (jobs.length) await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeout))])
}

/**
 * Cut every sound now: notes still ringing or already queued, reverb and delay tails. A
 * quick fade (no click), then the audio buses are rebuilt empty; the next notes make new
 * ones (stereo inserts re-mount themselves on the fresh buses).
 */
let previewRun = 0
let previewTimer = 0

/** Stop a track preview. Voices already started ring out; nothing new is scheduled. */
export function stopPreview() {
  previewRun += 1
  clearTimeout(previewTimer)
}

/**
 * Play a track without loading it: its notes go straight to the engine, a cycle at a time,
 * the way auditioning a single hit does. Nothing touches the editor, the transport or what
 * you have open — so listening to someone else's track costs you nothing you were working
 * on. Its effects are added alongside yours rather than replacing them.
 */
export async function previewTrack(project, { cycles = 8, onEnd } = {}) {
  stopPreview()
  const run = previewRun
  if (!project) return
  ensureAudio()
  const code = generateCode(project, { audition: true }).replace(/^setcpm\(.*$/gm, '')
  const { pattern } = await evaluate(stackLanes(code), transpiler)
  if (run !== previewRun || !pattern?.queryArc) return
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
  const ac = getAudioContext()
  const start = ac.currentTime + 0.12
  // a quarter of a cycle at a time: far enough ahead to stay smooth, close enough that
  // stopping stops within a beat instead of playing out whatever was already queued
  const SLICE = 0.25
  let at = 0
  const push = () => {
    if (run !== previewRun) return
    if (at >= cycles) {
      // it plays to the end on its own; say so once the last of it has actually sounded
      previewTimer = setTimeout(() => { if (run === previewRun) onEnd?.() },
                                Math.max(0, (start + cycles / cps - ac.currentTime) * 1000))
      return
    }
    for (const hap of pattern.queryArc(at, Math.min(at + SLICE, cycles))) {
      if (!hap.hasOnset()) continue
      const begin = hap.whole.begin.valueOf()
      const length = hap.whole.end.valueOf() - begin
      Promise.resolve(superdough(routeVoice(hap.value), start + begin / cps, length / cps, cps, begin)).catch(() => {})
    }
    at += SLICE
    previewTimer = setTimeout(push, (SLICE * 0.8 / cps) * 1000)
  }
  push()
}

export function silenceNow() {
  try {
    const ac = getAudioContext()
    const gain = getSuperdoughAudioController()?.output?.destinationGain?.gain
    if (gain) {
      gain.cancelScheduledValues(ac.currentTime)
      gain.setTargetAtTime(0, ac.currentTime, 0.006)
    }
    setTimeout(() => {
      try { resetGlobalEffects() } catch { /* nothing playing yet */ }
      silenceFx() // reverb and delay tails too
    }, 45)
  } catch { /* audio not started */ }
}

/**
 * Play one hit of a channel through the patch it's wired into (its effects, buses and
 * sidechains), so auditioning a note or a step sounds like the track. Falls back to the
 * raw sound when the channel isn't in the patch yet, or the patch code can't run.
 */
let auditionRun = 0
export async function previewInPatch(project, patternId, ch, { note, n, pitched = false, hold = null } = {}) {
  const code = project && patternId && auditionCode(project, patternId, ch?.id, { midi: note ?? 48, pitched })
  if (!code) return previewChannel(ch, { note, n, hold })
  // held notes each play (a chord is several keys); a plain hit gives way to a newer one
  const run = hold != null ? auditionRun : ++auditionRun
  try {
    ensureAudio()
    const { pattern } = await evaluate(code, transpiler)
    if ((hold == null && run !== auditionRun) || !pattern?.queryArc) return // a newer audition took over
    const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
    const ac = getAudioContext()
    const t0 = ac.currentTime + 0.03
    for (const hap of pattern.queryArc(0, 1)) {
      if (!hap.hasOnset()) continue
      const begin = hap.whole.begin.valueOf()
      const length = hap.whole.end.valueOf() - begin
      const value = hold != null ? { ...hap.value, _hold: hold } : hap.value
      Promise.resolve(superdough(routeVoice(value), t0 + begin / cps, hold != null ? HOLD_MAX : length / cps, cps, begin)).catch(() => {})
    }
  } catch {
    previewChannel(ch, { note, n, hold })
  }
}
