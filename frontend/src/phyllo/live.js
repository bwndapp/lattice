/**
 * Live knobs. Strudel fixes a voice's filter, volume and so on when the note starts, so
 * turning a knob would only be heard on the next note. Phyllo adds a bus modulator
 * (`.bmod`) to the few controls you sweep by hand: every voice adds a bus signal to its
 * value for as long as it sounds, and this module sets that signal to
 * (knob now − value the voice started with). Voices that started with different values
 * listen to different buses (the bus number includes the value), so every voice, old or
 * new, ends up exactly at the knob.
 *
 * Without this module (say, the code pasted into strudel.cc) the buses are silent and the
 * code plays as written.
 */
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio'

const buses = new Map() // bus id → { key, base, scale, at }
const knobs = new Map() // `${nodeId}|${param}` → the knob's value now
const audio = new Map() // bus id → { bus, src } once a voice has asked for it
let controller = null
let armed = false

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The bus a voice starting with `base` should listen to for this knob. */
export function liveBus(nodeId, param, base, scale = 1) {
  const key = `${nodeId}|${param}`
  const id = 1_000_000 + (hash(`${key}|${base}`) % 8_000_000)
  buses.set(id, { key, base, scale, at: Date.now() })
  knobs.set(key, base) // the code is generated from the knobs, so this is where the knob is now
  sync(key)
  return id
}

function offset(id) {
  const b = buses.get(id)
  const now = knobs.get(b.key)
  return now === undefined ? 0 : (now - b.base) * b.scale
}

function sync(key) {
  if (!install()) return
  const ac = getAudioContext()
  for (const [id, node] of audio) {
    const b = buses.get(id)
    if (!b || (key && b.key !== key)) continue
    if (controller.buses[id] !== node.bus) { forget(id); continue } // the controller was reset
    node.src.offset.setTargetAtTime(offset(id), ac.currentTime, 0.012)
  }
  collect()
}

/** Hook into the audio controller once the page may make sound. */
function install() {
  const ctl = controller
  if (ctl && ctl === safeController()) return true
  if (!navigator.userActivation?.hasBeenActive) {
    if (!armed) {
      armed = true
      const go = () => { window.removeEventListener('pointerdown', go, true); window.removeEventListener('keydown', go, true); sync() }
      window.addEventListener('pointerdown', go, true)
      window.addEventListener('keydown', go, true)
    }
    return false
  }
  const next = safeController()
  if (!next) return false
  controller = next
  audio.clear()
  const getBus = next.getBus.bind(next)
  next.getBus = (id) => (buses.has(id) ? ownBus(id) : getBus(id))
  return true
}

function safeController() {
  try { return getSuperdoughAudioController() } catch { return null }
}

function ownBus(id) {
  const have = audio.get(id)
  if (have && controller.buses[id] === have.bus) return have.bus
  if (have) forget(id)
  const ac = getAudioContext()
  const bus = new GainNode(ac, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
  // Each voice connects the bus into a node of its own and disconnects that node when it
  // ends; cut the bus's side of the wire then too, or finished voices pile up on the bus.
  const connect = bus.connect.bind(bus)
  bus.connect = (target, ...rest) => {
    const out = connect(target, ...rest)
    if (target instanceof AudioNode) {
      const disconnect = target.disconnect.bind(target)
      target.disconnect = (...args) => {
        target.disconnect = disconnect
        try { bus.disconnect(target) } catch { /* already gone */ }
        return disconnect(...args)
      }
    }
    return out
  }
  const src = new ConstantSourceNode(ac, { offset: offset(id) })
  src.connect(bus)
  src.start()
  controller.buses[id] = bus
  audio.set(id, { bus, src })
  return bus
}

function forget(id) {
  const node = audio.get(id)
  if (!node) return
  try { node.src.stop(); node.src.disconnect(); node.bus.disconnect() } catch { /* already gone */ }
  if (controller?.buses[id] === node.bus) delete controller.buses[id]
  audio.delete(id)
}

/** Drop buses no voice can still be using: not generated for a while, and not the current one. */
let lastCollect = 0
function collect() {
  const now = Date.now()
  if (now - lastCollect < 5000) return
  lastCollect = now
  const current = new Map()
  for (const [id, b] of buses) if (!current.has(b.key) || buses.get(current.get(b.key)).at < b.at) current.set(b.key, id)
  const live = new Set(current.values())
  for (const [id, b] of buses) {
    if (live.has(id) || now - b.at < 30_000) continue
    forget(id)
    buses.delete(id)
  }
}
