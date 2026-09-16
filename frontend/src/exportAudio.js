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
import { getAudioContext, getSuperdoughAudioController, initAudio, setAudioContext, setSuperdoughAudioController, superdough } from '@strudel/webaudio'
import { AudioBufferSource, BufferTarget, Mp3OutputFormat, Mp4OutputFormat, Output, WavOutputFormat, canEncodeAudio } from 'mediabunny'
import { registerMp3Encoder } from '@mediabunny/mp3-encoder'
import { generateCode } from './project'
import { activeAutos, appParam, autoValueFn } from './automation.js'
import { routeVoice, setFxParams, silenceFx } from './fxbus.js'
import { setInsertParams } from './stereo.js'
import { ensureAudio, forgetAudio, silenceNow } from './audio'

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
  const { pattern } = await evaluate(generateCode(project), transpiler)
  if (!pattern?.queryArc) throw new Error("the track's code didn't make a pattern")
  const haps = pattern.queryArc(from, to, { _cps: cps })
    .filter((h) => h.hasOnset())
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf())

  // the live engine has to let go of the speakers while the offline one renders
  silenceNow()
  forgetAudio()
  const live = getAudioContext()
  try { await live?.close?.() } catch { /* already closed */ }

  const offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  setAudioContext(offline)
  setSuperdoughAudioController(null)
  getSuperdoughAudioController() // built for the offline context
  silenceFx() // effects belong to the context they were built in
  await initAudio({})

  onStage?.(`${haps.length} notes`)
  for (const hap of haps) {
    const at = (hap.whole.begin.valueOf() - from) / cps
    try {
      await superdough(routeVoice(hapValue(hap)), at, hap.duration / cps, cps, hap.whole.begin.valueOf())
    } catch { /* one note that won't play shouldn't lose the render */ }
  }

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

  // back to playing: the next play builds a fresh live context
  silenceFx()
  setAudioContext(null)
  setSuperdoughAudioController(null)
  forgetAudio() // the next play builds the engine again, worklets and all
  try { ensureAudio() } catch { /* the next click will start it */ }
  return buffer
}

/** Peak-normalise to just under full scale, in place. */
export function normalize(buffer, ceiling = 0.89) {
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  }
  if (peak < 1e-6 || peak <= ceiling) return peak
  const gain = ceiling / peak
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) data[i] *= gain
  }
  return peak
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
