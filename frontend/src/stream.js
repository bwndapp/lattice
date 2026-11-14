/**
 * The stream: what's playing, as data, for anything that wants to follow along —
 * TouchDesigner, Max, a visualiser, a lighting rig. Switched on from the output node; the
 * browser publishes to the server (src/api/stream.py) and anything holding the link listens
 * on a websocket. Data, not audio: exact, a few hundred bytes a frame, and no lag beyond
 * the network's.
 *
 * Every message is a JSON text frame with a `type`:
 *
 *   hit        a sound starting, sent the moment it's heard
 *              { t (epoch ms), cycle (where in the song, in bars), dur (s),
 *                node, nodeName, inst, instName, sound, note (midi), freq (Hz, tuned),
 *                velocity, gain, pan }
 *   frame      about sixty a second while it plays, from the master output
 *              { t, playing, bpm, beats, cycle, bar, beat,
 *                rms, peak (0 … 1, linear), db (rms in dBFS),
 *                bands { sub, bass, lowmid, mid, highmid, presence, air } (0 … 1),
 *                centroid (Hz: how bright), flux (0 … 1: how much changed since the last
 *                frame — spikes on every hit), spectrum [64 × 0 … 1, 20 Hz – 20 kHz, log] }
 *   transport  play or stop: { t, playing, bpm, beats }
 *   status     (from the server) whether anyone's publishing: { live }
 *
 * Spectrum and bands are dB mapped -100 … -10 dBFS onto 0 … 1, so a quiet hiss is near 0
 * and a loud kick's low end near 1. Frames slow down when the tab is in the background
 * (the browser does that to every page); hits don't.
 */
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio'
import { API_ROOT } from './base'
import { currentA4, midiOf } from './tuning.js'

const RATE = 60
const BINS = 64
const BANDS = [['sub', 20, 60], ['bass', 60, 250], ['lowmid', 250, 500], ['mid', 500, 2000], ['highmid', 2000, 4000], ['presence', 4000, 6000], ['air', 6000, 20000]]
const FLOOR = -100
const CEIL = -10
const norm = (db) => Math.min(1, Math.max(0, (db - FLOOR) / (CEIL - FLOOR)))
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d

let state = { on: false, key: null, connected: false, listeners: 0 }
const subs = new Set()
const set = (patch) => { state = { ...state, ...patch }; subs.forEach((fn) => fn()) }
export const subscribeStream = (fn) => { subs.add(fn); return () => subs.delete(fn) }
export const streamState = () => state

let track = 'scratch'
let names = { nodes: new Map(), insts: new Map() }
let transport = { playing: () => false, cycle: () => 0, cps: () => 0.5, beats: () => 4 }
let ws = null
let retry = 0
let retryTimer = null
let frameTimer = null
let analyser = null
let tapped = null
let time = null
let freq = null
let lastSpec = null

const storeKey = () => `lattice:stream:${track}`
const readSaved = () => { try { return JSON.parse(localStorage.getItem(storeKey())) } catch { return null } }
const writeSaved = (v) => { try { localStorage.setItem(storeKey(), JSON.stringify(v)) } catch { /* storage unavailable */ } }
const newKey = () => {
  const a = new Uint8Array(15)
  crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_')
}

/** Where to listen: the websocket URL for this stream. */
export function streamUrl(key = state.key) {
  if (!key) return ''
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${API_ROOT}/stream/${key}`
}

/** The open track: each has its own stream, remembered in this browser. */
export function setStreamTrack(id) {
  const next = id || 'scratch'
  if (next === track) return
  stop()
  track = next
  const saved = readSaved()
  set({ key: saved?.key ?? null, on: false, connected: false, listeners: 0 })
  if (saved?.on && saved.key) start()
}

/** The names behind the ids, so a listener reads "kick", not "c8f2a". */
export function setStreamProject(project) {
  const nodes = new Map()
  const insts = new Map()
  for (const p of project?.patterns ?? []) for (const c of p.channels ?? []) insts.set(c.id, c.name)
  for (const n of project?.nodes ?? []) {
    const pattern = n.type === 'pattern' ? project.patterns?.find((p) => p.id === n.data?.patternId) : null
    nodes.set(n.id, n.data?.name || pattern?.name || n.type)
  }
  names = { nodes, insts }
}

/** How to ask where the song is: { playing(), cycle(), cps(), beats() }. */
export function setStreamTransport(getters) { transport = { ...transport, ...getters } }

export function toggleStream() { (state.on ? stop : start)(true) }

/** A new link: anyone with the old one stops hearing it. */
export function newStreamLink() {
  const was = state.on
  stop(true)
  set({ key: newKey() })
  writeSaved({ key: state.key, on: false })
  if (was) start(true)
}

function start(save = false) {
  const key = state.key ?? newKey()
  set({ on: true, key })
  if (save) writeSaved({ key, on: true })
  connect()
  clearInterval(frameTimer)
  frameTimer = setInterval(frame, 1000 / RATE)
}

function stop(save = false) {
  clearTimeout(retryTimer)
  clearInterval(frameTimer)
  frameTimer = null
  const old = ws
  ws = null
  try { old?.close() } catch { /* already closed */ }
  set({ on: false, connected: false, listeners: 0 })
  if (save && state.key) writeSaved({ key: state.key, on: false })
}

function connect() {
  if (!state.on || !state.key) return
  const sock = new WebSocket(streamUrl().replace(`/stream/${state.key}`, `/stream/pub/${state.key}`))
  ws = sock
  sock.onopen = () => { retry = 0; set({ connected: true }); send({ type: 'transport', t: Date.now(), playing: !!transport.playing(), bpm: bpm(), beats: transport.beats() }) }
  sock.onmessage = (e) => {
    try { const m = JSON.parse(e.data); if (m.type === 'listeners') set({ listeners: m.n }) } catch { /* not ours */ }
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    set({ connected: false, listeners: 0 })
    if (e.code === 4409) { stop(); return } // another tab took over this stream
    if (state.on) retryTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry++))
  }
}

const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
const bpm = () => round((transport.cps() || 0.5) * 60 * (transport.beats() || 4), 2)

/** A sound about to start (`deadline` seconds from now): sent when it's heard. */
export function streamHit(value, deadline, duration, cycle) {
  if (!state.on || !state.connected || !value) return
  const at = Date.now() + Math.max(0, deadline) * 1000
  // the note as written, whatever the tuning moved its frequency to
  const midi = typeof value.freq === 'number' ? 69 + 12 * Math.log2(value.freq / currentA4()) : value.note != null ? midiOf(value.note) : null
  const msg = {
    type: 'hit',
    t: Math.round(at),
    cycle: round(Number(cycle) || 0),
    dur: round(Number(duration) || 0),
    node: value._n ?? null,
    nodeName: names.nodes.get(value._n) ?? null,
    inst: value._c ?? null,
    instName: names.insts.get(value._c) ?? null,
    sound: value.s ?? null,
    note: midi == null ? null : round(midi, 2),
    freq: typeof value.freq === 'number' ? round(value.freq, 3) : null,
    velocity: round(Number(value.velocity ?? 1)),
    gain: round(Number(value.gain ?? 1)),
    pan: round(Number(value.pan ?? 0.5)),
  }
  setTimeout(() => send(msg), Math.max(0, deadline) * 1000)
}

/** Play or stop. */
export function streamTransport(playing) {
  if (!state.on) return
  send({ type: 'transport', t: Date.now(), playing: !!playing, bpm: bpm(), beats: transport.beats() })
}

// ── the master, measured ──────────────────────────────────────────────────

function tap() {
  const ac = getAudioContext()
  const master = getSuperdoughAudioController()?.output?.destinationGain
  if (!ac || !master) return null
  if (analyser && tapped === master && analyser.context === ac) return analyser
  try { tapped?.disconnect(analyser) } catch { /* gone with its context */ }
  analyser = new AnalyserNode(ac, { fftSize: 4096, smoothingTimeConstant: 0.5, minDecibels: FLOOR, maxDecibels: CEIL })
  master.connect(analyser)
  tapped = master
  time = new Float32Array(analyser.fftSize)
  freq = new Float32Array(analyser.frequencyBinCount)
  lastSpec = null
  return analyser
}

// the FFT bins each log-spaced bin and band covers, worked out once per sample rate
let layout = null
function layoutFor(rate, n) {
  if (layout?.rate === rate && layout.n === n) return layout
  const hz = rate / 2 / n
  const bin = (f) => Math.min(n - 1, Math.max(1, Math.round(f / hz)))
  const edges = Array.from({ length: BINS + 1 }, (_, i) => 20 * 1000 ** (i / BINS)) // 20 Hz … 20 kHz
  layout = {
    rate,
    n,
    hz,
    bins: edges.slice(0, -1).map((lo, i) => [bin(lo), Math.max(bin(lo), bin(edges[i + 1]) - 1)]),
    bands: BANDS.map(([k, lo, hi]) => [k, bin(lo), Math.max(bin(lo), bin(hi) - 1)]),
  }
  return layout
}

const powerDb = (a, b) => {
  let p = 0
  for (let i = a; i <= b; i++) p += 10 ** (freq[i] / 10)
  return 10 * Math.log10(p / (b - a + 1) + 1e-20)
}

function frame() {
  if (!state.connected) return
  const playing = !!transport.playing()
  const cycle = Number(transport.cycle()) || 0
  const beats = transport.beats() || 4
  const msg = { type: 'frame', t: Date.now(), playing, bpm: bpm(), beats, cycle: round(cycle), bar: Math.floor(cycle) + 1, beat: Math.floor((cycle % 1) * beats) + 1 }
  const an = tap()
  if (an) {
    an.getFloatTimeDomainData(time)
    let sum = 0
    let peak = 0
    for (let i = 0; i < time.length; i++) { const x = time[i]; sum += x * x; const a = x < 0 ? -x : x; if (a > peak) peak = a }
    const rms = Math.sqrt(sum / time.length)
    an.getFloatFrequencyData(freq)
    const L = layoutFor(an.context.sampleRate, freq.length)
    const spectrum = L.bins.map(([a, b]) => round(norm(powerDb(a, b)), 3))
    let num = 0
    let den = 0
    for (let i = 1; i < freq.length; i++) { const p = 10 ** (freq[i] / 10); num += p * i * L.hz; den += p }
    let flux = 0
    if (lastSpec) for (let i = 0; i < BINS; i++) flux += Math.max(0, spectrum[i] - lastSpec[i])
    lastSpec = spectrum
    Object.assign(msg, {
      rms: round(rms),
      peak: round(peak),
      db: round(20 * Math.log10(rms + 1e-9), 1),
      bands: Object.fromEntries(L.bands.map(([k, a, b]) => [k, round(norm(powerDb(a, b)), 3)])),
      centroid: den > 0 ? Math.round(num / den) : 0,
      flux: round(Math.min(1, flux / 8), 3),
      spectrum,
    })
  }
  send(msg)
}
