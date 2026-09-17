/**
 * The audio side of instrument engines (see index.js).
 *
 * Each instrument that uses an engine gets one processor on the audio thread that stays
 * alive, with an output per voice. Each engine is also a Strudel sound
 * (`lattice_<type>`): when Strudel plays a note of it, the host picks a voice, tells the
 * processor about the note through its AudioParams (timed to the sample), and hands
 * Strudel a tap on that voice's output. Strudel then runs the tap through the note's usual
 * chain — level, pan, filter, sends, its bus and whatever inserts sit there — so an engine
 * plays through the patch exactly like a sample would.
 *
 * Settings come from the project: generating the code declares every instrument's engine
 * settings here, and live instances follow them at once (no re-evaluating), which is also
 * how automation moves them.
 */
import { getAudioContext, registerSound } from '@strudel/webaudio'
import { noteToMidi } from '@strudel/core'
import { DSP_BASE } from './dsp.js'
import { ENGINES, engineAudio, engineAudioParams, engineData, engineSound, withKnobs } from './index.js'

// ── the module the audio thread loads ─────────────────────────────────────────
let moduleUrl = null
const loaded = new WeakMap() // audio context → the promise that adds the module to it

/**
 * Make sure the audio thread has the engines. Playback loads them as it goes; an offline
 * render has to wait, or its first notes arrive before the processors exist.
 */
export function prepareInstruments(ac = getAudioContext()) {
  if (!ac?.audioWorklet) return Promise.resolve(false)
  if (!loaded.has(ac)) {
    if (!moduleUrl) {
      const source = [DSP_BASE, ...Object.values(ENGINES).map((e) => e.dsp)].join('\n')
      moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    }
    loaded.set(ac, ac.audioWorklet.addModule(moduleUrl).then(() => true, (err) => {
      console.warn('[instruments] could not load the engines', err)
      return false
    }))
  }
  return loaded.get(ac)
}

// ── settings, from the project ────────────────────────────────────────────────
const declared = new Map() // instrument (channel) id → { type, data, cps }

/** Every instrument's engine settings, from a project (called as its code is generated). */
export function declareEngines(project) {
  const cps = (Number(project?.bpm) || 120) / (Number(project?.beats) || 4) / 60
  for (const pattern of project?.patterns ?? []) {
    for (const ch of pattern.channels) {
      if (!ch.engine || !ENGINES[ch.engine.type]) continue
      const found = { type: ch.engine.type, data: engineData(ch.engine), cps }
      declared.set(ch.id, found)
      for (const inst of live(ch.id, ch.engine.type)) inst.apply(found)
    }
  }
}

/** Move some of one instrument's knobs while it plays (automation). */
export function setEngineParams(channelId, patch) {
  const found = declared.get(channelId)
  if (!found) return
  found.data = withKnobs(ENGINES[found.type], found.data, patch)
  for (const inst of live(channelId, found.type)) inst.apply(found)
}

// ── instances ─────────────────────────────────────────────────────────────────
const instances = new WeakMap() // audio context → Map(`${channel}:${type}` → instance)
const everywhere = new Set() // every instance, to find them by instrument

function* live(channelId, type) {
  for (const inst of everywhere) {
    if (inst.ac.state === 'closed') { everywhere.delete(inst); continue }
    if (inst.channelId === channelId && inst.type === type) yield inst
  }
}

function instanceFor(ac, channelId, type) {
  if (!instances.has(ac)) instances.set(ac, new Map())
  const map = instances.get(ac)
  const key = `${channelId}:${type}`
  if (!map.has(key)) {
    const inst = createInstance(ac, channelId, type)
    map.set(key, inst)
    everywhere.add(inst)
  }
  return map.get(key)
}

function createInstance(ac, channelId, type) {
  const spec = ENGINES[type]
  const settings = declared.get(channelId)?.type === type ? declared.get(channelId) : { data: engineData({ type }), cps: 0.5 }
  const params = engineAudioParams(spec)
  const first = engineAudio(spec, settings.data, settings)
  const node = new AudioWorkletNode(ac, spec.processor, {
    numberOfInputs: 0,
    numberOfOutputs: spec.voices,
    outputChannelCount: Array.from({ length: spec.voices }, () => 2),
    parameterData: Object.fromEntries(params.filter((p) => Number.isFinite(first[p.key])).map((p) => [`p_${p.key}`, first[p.key]])),
    processorOptions: spec.message ? { data: spec.message(settings.data) } : {},
  })
  let said = spec.message ? JSON.stringify(spec.message(settings.data)) : ''
  const param = (name) => node.parameters.get(name)
  const voices = Array.from({ length: spec.voices }, () => ({ until: 0, started: 0, note: null }))
  let trig = 0
  let current = settings.data
  let sent = first
  return {
    ac,
    channelId,
    type,
    get data() { return current },
    apply({ data, cps }) {
      current = data
      const next = engineAudio(spec, data, { cps })
      for (const p of params) {
        const v = next[p.key]
        if (!Number.isFinite(v) || v === sent[p.key]) continue
        // a switch (a wave, a mode) jumps; a knob glides a few milliseconds
        if (Number.isInteger(v) && Number.isInteger(sent[p.key]) && p.max - p.min <= 64) param(`p_${p.key}`).setValueAtTime(v, ac.currentTime)
        else param(`p_${p.key}`).setTargetAtTime(v, ac.currentTime, 0.005)
      }
      sent = next
      if (spec.message) {
        const data = spec.message(current)
        const text = JSON.stringify(data)
        if (text !== said) { said = text; node.port.postMessage({ data }) }
      }
    },
    /** Start a note: which voice, and the note's handle. */
    play(t, { midi, vel, duration }) {
      // a free voice, else the one that started longest ago (a mono engine has one to use)
      const usable = voices.slice(0, Math.max(1, Math.min(voices.length, spec.voicesFor?.(current) ?? voices.length)))
      let slot = usable.findIndex((v) => v.until <= t)
      if (slot < 0) slot = usable.reduce((best, v, i) => (v.started < usable[best].started ? i : best), 0)
      const voice = voices[slot]
      voice.note?.cut(t)
      // the note it takes over from mustn't let go of the key in the middle of this one
      param(`v${slot}_gate`).cancelScheduledValues(t)
      trig = (trig % 1e6) + 1
      param(`v${slot}_note`).setValueAtTime(midi ?? -1, t)
      param(`v${slot}_vel`).setValueAtTime(vel, t)
      param(`v${slot}_gate`).setValueAtTime(1, t)
      param(`v${slot}_trig`).setValueAtTime(trig, t)
      const gateOff = t + Math.max(0.001, duration)
      param(`v${slot}_gate`).setValueAtTime(0, gateOff)
      const tail = Math.max(0.01, spec.tail(current))
      const end = spec.oneShot ? t + tail : gateOff + tail
      const note = tapNote(ac, node, slot, t, end, () => { if (voice.note === note) { voice.note = null; voice.until = 0 } })
      voice.note = note
      voice.started = t
      voice.until = end
      note.gateOff = (at) => { param(`v${slot}_gate`).cancelScheduledValues(at); param(`v${slot}_gate`).setValueAtTime(0, at) }
      /** Let go of the key at `at`: the release plays out, then the voice is free. */
      note.release = (at) => {
        const from = Math.max(at, t + 0.02, ac.currentTime)
        note.gateOff(from)
        if (spec.oneShot) return // a one-shot plays its whole shape anyway
        const done = from + Math.max(0.01, spec.tail(current))
        if (done < end) {
          note.cut(done)
          if (voice.note === note) voice.until = done
        }
      }
      return note
    },
  }
}

/**
 * A tap on one voice's output for one note: open from `t`, closed at `end` or when cut
 * (the voice went to a newer note), and `onended` once it's closed.
 */
function tapNote(ac, node, slot, t, end, release) {
  const tap = new GainNode(ac, { gain: 0 })
  node.connect(tap, slot)
  tap.gain.setValueAtTime(1, t)
  tap.gain.setValueAtTime(0, end)
  let timer = null
  let done = false
  let listener = null
  const finish = () => {
    if (done) return
    done = true
    try { node.disconnect(tap, slot) } catch { /* already gone */ }
    release()
    listener?.()
  }
  const at = (when) => {
    if (timer) { timer.onended = null; try { timer.stop() } catch { /* not started */ } }
    timer = new ConstantSourceNode(ac, { offset: 0 })
    timer.connect(ac.destination) // some browsers only end sources that are connected; it's silent
    timer.onended = () => { timer.disconnect(); finish() }
    timer.start(Math.max(t, ac.currentTime))
    timer.stop(Math.max(when, ac.currentTime) + 0.01)
  }
  at(end)
  return {
    tap,
    onEnded(fn) { listener = fn },
    /** Stop sounding at `when`: a newer note took the voice, or Strudel stopped this one. */
    cut(when) {
      if (done) return
      const from = Math.max(when, t)
      tap.gain.cancelScheduledValues(from)
      tap.gain.setValueAtTime(0, from)
      at(from)
    },
  }
}

// ── held notes (a key down on the computer keyboard) ─────────────────────────
const RELEASED = Symbol('released')
const held = new Map() // hold id → the note, or RELEASED if the key came up before it started

/** A key came up: let go of the note it started. */
export function releaseHeld(id) {
  const note = held.get(id)
  if (note && note !== RELEASED) { note.release(getAudioContext().currentTime); held.delete(id) } else held.set(id, RELEASED)
  // a key-up that never finds its note is forgotten after a while
  if (held.size > 256) held.delete(held.keys().next().value)
}

// ── Strudel sounds ────────────────────────────────────────────────────────────
const toMidi = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { try { return noteToMidi(v) } catch { return null } }
  return null
}

let registered = false
/** Make every engine playable as a Strudel sound. Safe to call more than once. */
export function registerEngineSounds() {
  if (registered) return
  registered = true
  for (const spec of Object.values(ENGINES)) {
    registerSound(engineSound(spec.type), async (t, value, onended) => {
      const ac = getAudioContext()
      if (!(await prepareInstruments(ac))) return null
      // the instrument this note came from (project.js marks every note with it); code
      // written by hand gets one shared instance per engine, at the engine's defaults
      const channelId = typeof value._c === 'string' ? value._c : '_'
      const inst = instanceFor(ac, channelId, spec.type)
      let midi = toMidi(value.note)
      if (midi == null && value.freq > 0) midi = 69 + 12 * Math.log2(value.freq / 440)
      const note = inst.play(t, {
        midi: midi == null ? null : Math.min(127, Math.max(0, midi)),
        vel: Math.min(1, Math.max(0, Number(value.velocity ?? 1))),
        duration: Number(value.duration) || 0.1,
      })
      note.onEnded(onended)
      // played from a key that's still down: it lasts until the key comes up
      if (value._hold != null) {
        if (held.get(value._hold) === RELEASED) { held.delete(value._hold); note.release(t) } else held.set(value._hold, note)
      }
      return {
        node: note.tap,
        stop: (when) => { note.gateOff(when); if (spec.oneShot) note.cut(when) },
      }
    }, { type: 'engine', prebake: true })
  }
}
