/**
 * Bouncing a track to a file.
 *
 * The song is rendered offline (faster than playing it), through the same engine you hear:
 * Strudel's voices plus this app's own reverbs, delays, eqs and mixer buses (fxbus.js,
 * stereo.js), which hook whatever audio controller is current — so pointing the engine at
 * an OfflineAudioContext gets the same sound. Knobs the app moves itself (a reverb's size,
 * a bus fader) are stepped along the render by suspending it every so often, so their
 * automation is bounced too.
 *
 * The finished audio is written with mediabunny: WAV (PCM) always, MP3 through its encoder,
 * AAC/M4A where the browser can encode it.
 */
import { evaluate } from '@strudel/core'
import { transpiler } from '@strudel/transpiler'
import { getAudioContext, getSuperdoughAudioController, initAudio, resetGlobalEffects, setAudioContext, setSuperdoughAudioController, superdough } from '@strudel/webaudio'
import { AudioBufferSource, BufferTarget, Mp3OutputFormat, Mp4OutputFormat, Output, WavOutputFormat, canEncodeAudio } from 'mediabunny'
import { registerMp3Encoder } from '@mediabunny/mp3-encoder'
import { generateCode } from './project'
import { activeAutos, appParam, autoValueFn } from './automation.js'
import { routeVoice, setFxParams, silenceFx } from './fxbus.js'
import { prepareInserts, setInsertParams } from './stereo.js'
import { ensureAudio, forgetAudio } from './audio'

let mp3Ready = false
/** MP3 isn't in WebCodecs, so mediabunny's encoder fills in. */
function withMp3() {
  if (mp3Ready) return
  registerMp3Encoder()
  mp3Ready = true
}

export const FORMATS = [
  { key: 'wav24', label: 'WAV · 24-bit', ext: 'wav', codec: 'pcm-s24' },
  { key: 'wav16', label: 'WAV · 16-bit', ext: 'wav', codec: 'pcm-s16' },
  { key: 'mp3', label: 'MP3', ext: 'mp3', codec: 'mp3', bitrates: [320, 256, 192, 128] },
  { key: 'm4a', label: 'M4A · AAC', ext: 'm4a', codec: 'aac', bitrates: [256, 192, 128] },
]

/** The formats this browser can actually write. */
export async function availableFormats() {
  const out = []
  for (const f of FORMATS) {
    if (f.key === 'mp3') withMp3()
    // PCM is built into mediabunny; the others go through the browser's encoders
    const ok = f.codec.startsWith('pcm') || (await canEncodeAudio(f.codec).catch(() => false))
    if (ok) out.push(f)
  }
  return out
}

/**
 * The generated code ends in one labelled line per lane (`out_in0: …`), which the player
 * stacks together; a plain evaluate would keep only the last one. This stacks them here,
 * leaving out the muted lanes (their labels start with an underscore).
 */
export function stackLanes(code) {
  const lanes = [...code.matchAll(/^([A-Za-z_$][\w$]*): (.+)$/gm)]
  if (!lanes.length) return code
  const heard = lanes.filter(([, name]) => !name.startsWith('_')).map(([, , expr]) => expr.trim())
  const body = code.replace(/^[A-Za-z_$][\w$]*: .+$/gm, '')
  return `${body}\nstack(${heard.length ? heard.join(', ') : 'silence'})`
}

/** What a note's value looks like to the engine (the same as playback sends). */
const hapValue = (hap) => { hap.ensureObjectValue(); return hap.value }

const STEP = 0.05 // seconds between app-side knob updates while rendering

/**
 * Render part of a project to an AudioBuffer. `from`/`to` are in bars; `tail` gives
 * reverbs and delays room to ring out after the last note.
 */
export async function renderProject(project, { from = 0, to = 4, tail = 2, sampleRate = 48000, onStage } = {}) {
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
  const seconds = (to - from) / cps + Math.max(0, tail)
  if (!(seconds > 0)) throw new Error('nothing to render')

  onStage?.('working out the notes')
  const { pattern } = await evaluate(stackLanes(generateCode(project)), transpiler)
  if (!pattern?.queryArc) throw new Error("the track's code didn't make a pattern")
  const haps = pattern.queryArc(from, to, { _cps: cps })
    .filter((h) => h.hasOnset())
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf())

  // The live engine lets go of the speakers before the offline one starts. This resets it
  // here and now: stopping normally resets a moment later, which would land in the middle of
  // the render and pull the notes we just scheduled back out.
  resetGlobalEffects()
  forgetAudio()
  const live = getAudioContext()
  try { await live?.close?.() } catch { /* already closed */ }

  const offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  setAudioContext(offline)
  setSuperdoughAudioController(null)
  getSuperdoughAudioController() // built for the offline context
  silenceFx() // effects belong to the context they were built in
  await initAudio({})
  await prepareInserts() // the offline render can't wait for the worklet by itself

  onStage?.(`${haps.length} notes`)
  let failed = 0
  let firstError = null
  for (const hap of haps) {
    const at = (hap.whole.begin.valueOf() - from) / cps
    const value = routeVoice(hapValue(hap))
    try {
      await superdough(value, at, hap.duration / cps, cps, hap.whole.begin.valueOf())
    } catch (err) {
      // the engine keeps a pool of audio nodes; one left over from the live context throws
      // when it's used here, and is dropped from the pool as it goes, so a second go works
      try {
        await superdough(value, at, hap.duration / cps, cps, hap.whole.begin.valueOf())
      } catch (again) {
        failed++
        firstError = firstError ?? again
      }
    }
  }
  if (failed) console.warn(`[export] ${failed} of ${haps.length} notes didn't render`, firstError)
  if (failed === haps.length && haps.length) throw new Error(`nothing would play: ${firstError?.message ?? firstError}`)

  // knobs the app moves itself: step them along the render
  const moving = (project.song?.on ? activeAutos(project) : [])
    .map((a) => ({ app: appParam(project, a.target), value: autoValueFn(project, a) }))
    .filter((a) => a.app && a.value)
  if (moving.length) {
    for (let t = 0; t < seconds; t += STEP) {
      offline.suspend(t).then(() => {
        const bar = from + t * cps
        for (const a of moving) {
          const patch = { [a.app.param]: a.value(bar) * (a.app.scale ?? 1) }
          if (a.app.where === 'fx') setFxParams(a.app.key, patch)
          else setInsertParams(a.app.key, patch)
        }
        offline.resume()
      })
    }
  }

  onStage?.('rendering')
  const buffer = await offline.startRendering()
  console.log(`[export] ${haps.length} notes, ${failed} failed, ${buffer.duration.toFixed(2)}s rendered`)

  // back to playing: the next play builds a fresh live context
  silenceFx()
  setAudioContext(null)
  setSuperdoughAudioController(null)
  forgetAudio() // the next play builds the engine again, worklets and all
  try { ensureAudio() } catch { /* the next click will start it */ }
  return buffer
}

/** One biquad, run over a copy of a channel (for the loudness weighting). */
function biquad(data, { b0, b1, b2, a1, a2 }) {
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0
  for (let i = 0; i < data.length; i++) {
    const x = data[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    data[i] = y
  }
}

/** The two filters ITU-R BS.1770 hears loudness through, for this sample rate. */
function kWeighting(rate) {
  // a high shelf for the head's response, then a high-pass
  const shelfF = 1681.974450955533
  const shelfG = 3.999843853973347
  const shelfQ = 0.7071752369554196
  const A = 10 ** (shelfG / 40)
  const w = (2 * Math.PI * shelfF) / rate
  const alpha = Math.sin(w) / (2 * shelfQ)
  const cos = Math.cos(w)
  const sq = 2 * Math.sqrt(A) * alpha
  const a0s = (A + 1) - (A - 1) * cos + sq
  const shelf = {
    b0: (A * ((A + 1) + (A - 1) * cos + sq)) / a0s,
    b1: (-2 * A * ((A - 1) + (A + 1) * cos)) / a0s,
    b2: (A * ((A + 1) + (A - 1) * cos - sq)) / a0s,
    a1: (2 * ((A - 1) - (A + 1) * cos)) / a0s,
    a2: ((A + 1) - (A - 1) * cos - sq) / a0s,
  }
  const hpF = 38.13547087602444
  const hpQ = 0.5003270373238773
  const wh = (2 * Math.PI * hpF) / rate
  const ah = Math.sin(wh) / (2 * hpQ)
  const ch = Math.cos(wh)
  const a0h = 1 + ah
  const highpass = {
    b0: ((1 + ch) / 2) / a0h,
    b1: (-(1 + ch)) / a0h,
    b2: ((1 + ch) / 2) / a0h,
    a1: (-2 * ch) / a0h,
    a2: (1 - ah) / a0h,
  }
  return [shelf, highpass]
}

/**
 * What came out: the loudest peak, how loud it is overall (LUFS, the scale streaming
 * services level to), and whether anything clipped. Nothing is changed.
 */
export function measure(buffer) {
  const rate = buffer.sampleRate
  let peak = 0
  let clipped = 0
  const channels = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
      if (v >= 0.9995) clipped++
    }
    const copy = Float32Array.from(data)
    for (const stage of kWeighting(rate)) biquad(copy, stage)
    channels.push(copy)
  }
  // mean square over 400 ms blocks, every 100 ms, gated as BS.1770 says
  const block = Math.round(rate * 0.4)
  const hop = Math.round(rate * 0.1)
  const blocks = []
  for (let start = 0; start + block <= (channels[0]?.length ?? 0); start += hop) {
    let sum = 0
    for (const data of channels) {
      let s = 0
      for (let i = start; i < start + block; i++) s += data[i] * data[i]
      sum += s / block
    }
    blocks.push(-0.691 + 10 * Math.log10(Math.max(1e-12, sum)))
  }
  const loud = blocks.filter((b) => b > -70)
  let lufs = null
  if (loud.length) {
    const mean = 10 * Math.log10(loud.reduce((a, b) => a + 10 ** (b / 10), 0) / loud.length)
    const kept = loud.filter((b) => b > mean - 10)
    const list = kept.length ? kept : loud
    lufs = 10 * Math.log10(list.reduce((a, b) => a + 10 ** (b / 10), 0) / list.length)
  }
  return { peak, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity, clipped, lufs }
}

/** Pull the whole bounce down so its loudest moment sits at `db` (only used when it clips). */
export function trimTo(buffer, db = -1) {
  const { peak } = measure(buffer)
  const target = 10 ** (db / 20)
  if (peak <= target || peak <= 0) return 1
  const gain = target / peak
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) data[i] *= gain
  }
  return gain
}

/** Write an AudioBuffer as a file, and hand back a blob to download. */
export async function encodeBuffer(buffer, { format = 'wav24', bitrate = 320 } = {}) {
  const spec = FORMATS.find((f) => f.key === format) ?? FORMATS[0]
  if (spec.codec === 'mp3') withMp3()
  const output = new Output({
    format: spec.ext === 'wav' ? new WavOutputFormat() : spec.ext === 'mp3' ? new Mp3OutputFormat() : new Mp4OutputFormat(),
    target: new BufferTarget(),
  })
  const source = new AudioBufferSource({
    codec: spec.codec,
    ...(spec.bitrates ? { bitrate: bitrate * 1000 } : {}),
  })
  output.addAudioTrack(source)
  await output.start()
  await source.add(buffer)
  await source.close()
  await output.finalize()
  return { blob: new Blob([output.target.buffer], { type: output.format.mimeType }), ext: spec.ext }
}

/** Save a blob as a file. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
