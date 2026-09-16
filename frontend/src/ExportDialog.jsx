import { useEffect, useRef, useState } from 'react'
import { FORMATS, availableFormats, download, encodeBuffer, measure, renderProject, trimTo } from './exportAudio.js'
import { songLength } from './song'
import GlassSwitch from './GlassSwitch.jsx'
import './ExportDialog.css'

const clean = (name) => (name || 'track').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'track'
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const size = (bytes) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`)

/** The peaks of a rendered take, for the picture of it. */
function peaksOf(buffer, count = 320) {
  const data = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(data.length / count))
  const peaks = []
  for (let i = 0; i < count; i++) {
    let peak = 0
    for (let j = i * step; j < Math.min((i + 1) * step, data.length); j += 2) peak = Math.max(peak, Math.abs(data[j]))
    peaks.push(peak)
  }
  return peaks
}

/**
 * Bouncing the track to a file: choose what and how, watch it render, hear it back, save it.
 * The render is offline, so it's quicker than playing the track through.
 */
export default function ExportDialog({ project, title, transport, onClose, onFlash }) {
  const ref = useRef(null)
  const audioRef = useRef(null) // { ctx, source } while the take is playing back
  const [formats, setFormats] = useState(FORMATS.filter((f) => f.codec.startsWith('pcm')))
  const [format, setFormat] = useState('wav24')
  const [bitrate, setBitrate] = useState(320)
  const [rate, setRate] = useState(48000)
  const [tail, setTail] = useState(2)

  const [bars, setBars] = useState(8)
  const [stage, setStage] = useState(null) // what the render is doing
  const [take, setTake] = useState(null) // { buffer, peaks, blob, ext, name, level }
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')

  const song = Math.ceil(songLength(project.song ?? { clips: [] }) - 1e-9)
  const looping = transport.loop.to > transport.loop.from
  const [what, setWhat] = useState(song > 0 ? 'song' : 'bars')
  const range = what === 'song' ? { from: 0, to: Math.max(1, song) }
    : what === 'loop' ? { from: transport.loop.from, to: transport.loop.to }
      : { from: 0, to: Math.max(1, bars) }
  const cps = (Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60
  const seconds = (range.to - range.from) / cps + Number(tail)
  const spec = formats.find((f) => f.key === format) ?? formats[0]
  const bytes = spec?.bitrates ? (seconds * bitrate * 1000) / 8 : seconds * rate * 2 * (spec?.codec === 'pcm-s24' ? 3 : 2)
  const fileName = `${clean(title)}.${spec?.ext ?? 'wav'}`

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  useEffect(() => { availableFormats().then(setFormats).catch(() => {}) }, [])
  useEffect(() => () => { try { audioRef.current?.source.stop() } catch { /* already stopped */ } }, [])

  const render = async () => {
    setError('')
    setStage('getting ready')
    try {
      const buffer = await renderProject(project, { ...range, tail: Number(tail), sampleRate: rate, onStage: setStage })
      setStage('listening to what came out')
      const level = measure(buffer)
      setStage('writing the file')
      const { blob, ext } = await encodeBuffer(buffer, { format: spec.key, bitrate })
      setTake({ buffer, peaks: peaksOf(buffer), blob, ext, level, name: `${clean(title)}.${ext}` })
      setStage(null)
    } catch (e) {
      setError(e.message || String(e))
      setStage(null)
    }
  }

  const hear = () => {
    if (playing) {
      try { audioRef.current?.source.stop() } catch { /* already stopped */ }
      return
    }
    const ctx = new AudioContext()
    const source = ctx.createBufferSource()
    source.buffer = take.buffer
    source.connect(ctx.destination)
    source.onended = () => { setPlaying(false); ctx.close().catch(() => {}); audioRef.current = null }
    source.start()
    audioRef.current = { ctx, source }
    setPlaying(true)
  }

  /** Only when it clipped: one gain change so the loudest moment sits at −1 dB. */
  const pullDown = async () => {
    setStage('pulling it down')
    trimTo(take.buffer, -1)
    const { blob, ext } = await encodeBuffer(take.buffer, { format: spec.key, bitrate })
    setTake((t) => ({ ...t, blob, ext, peaks: peaksOf(t.buffer), level: measure(t.buffer) }))
    setStage(null)
  }

  const save = () => {
    download(take.blob, take.name)
    onFlash?.(`Exported ${take.name} · ${clock(take.buffer.duration)}`)
    onClose()
  }

  const whatOptions = [
    ...(song > 0 ? [['song', `song · ${song} bars`]] : []),
    ...(looping ? [['loop', `loop · ${Math.round((transport.loop.to - transport.loop.from) * 10) / 10} bars`]] : []),
    ['bars', song > 0 ? 'some bars' : 'the patch'],
  ]

  return (
    <dialog
      ref={ref}
      className="export-dialog"
      aria-labelledby="export-title"
      onCancel={(e) => { e.preventDefault(); if (!stage) onClose() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current && !stage) onClose() }}
    >
      <div className="ex-body">
        <div className="ex-head">
          <h2 id="export-title" className="ex-title">Export</h2>
          <span className="ex-file">{take?.name ?? fileName}</span>
        </div>

        {take ? (
          <div className="ex-done">
            <div className="ex-wave" aria-hidden>
              {take.peaks.map((p, i) => <span key={i} style={{ height: `${Math.max(2, p * 100)}%` }} />)}
            </div>
            <p className="ex-summary">{clock(take.buffer.duration)} · {size(take.blob.size)} · {spec?.label}{spec?.bitrates ? ` · ${bitrate} kbps` : ''} · {rate / 1000} kHz</p>
            <p className="ex-level">
              peak <b>{take.level.peakDb === -Infinity ? '−∞' : take.level.peakDb.toFixed(1)} dB</b>
              {take.level.lufs !== null && <> · loudness <b>{take.level.lufs.toFixed(1)} LUFS</b></>}
              {take.level.lufs !== null && <span className="ex-note"> (streaming sits around −14)</span>}
            </p>
            {take.level.clipped > 0 && (
              <p className="ex-warn">
                It clips: {take.level.clipped.toLocaleString()} samples hit the ceiling. Turn something down in the patch, or
                {' '}<button type="button" className="linkish" onClick={pullDown}>pull the whole bounce to −1 dB</button>.
              </p>
            )}
            <div className="ex-actions">
              <button type="button" className="btn" onClick={() => { try { audioRef.current?.source.stop() } catch { /* stopped */ } setTake(null) }}>back</button>
              <button type="button" className="btn" onClick={hear}>{playing ? 'stop' : 'hear it'}</button>
              <button type="button" className="btn primary" onClick={save}>save the file</button>
            </div>
          </div>
        ) : stage ? (
          <div className="ex-working" role="status">
            <div className="ex-bars" aria-hidden>{Array.from({ length: 28 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 45}ms` }} />)}</div>
            <p className="ex-stage">{stage}…</p>
            <p className="ex-note">rendering {clock(seconds)} of audio · playback is paused</p>
          </div>
        ) : (
          <>
            <div className="ex-row">
              <span className="ex-label">what</span>
              <GlassSwitch label="What to export" options={whatOptions} value={what} onChange={setWhat} />
            </div>
            {what === 'bars' && (
              <div className="ex-row">
                <span className="ex-label">how many</span>
                <GlassSwitch size="sm" label="How many bars" options={[2, 4, 8, 16, 32, 64].map((b) => [b, String(b)])} value={bars} onChange={setBars} />
              </div>
            )}
            <div className="ex-row">
              <span className="ex-label">format</span>
              <GlassSwitch label="Format" options={formats.map((f) => [f.key, f.label.replace(' · ', ' ')])} value={format} onChange={setFormat} />
            </div>
            {spec?.bitrates && (
              <div className="ex-row">
                <span className="ex-label">bitrate</span>
                <GlassSwitch size="sm" label="Bitrate" options={spec.bitrates.map((b) => [b, `${b}k`])} value={bitrate} onChange={setBitrate} />
              </div>
            )}
            <div className="ex-row">
              <span className="ex-label">sample rate</span>
              <GlassSwitch size="sm" label="Sample rate" options={[[44100, '44.1 kHz'], [48000, '48 kHz']]} value={rate} onChange={setRate} />
            </div>
            <div className="ex-row">
              <span className="ex-label">ring out</span>
              <GlassSwitch size="sm" label="How long tails ring out" options={[[0, 'none'], [1, '1s'], [2, '2s'], [4, '4s'], [8, '8s']]} value={Number(tail)} onChange={setTail} />
              <span className="ex-note">room at the end for reverbs and echoes</span>
            </div>
            <p className="ex-summary">{clock(seconds)} · about {size(bytes)}{spec ? ` · ${spec.label}` : ''}{spec?.bitrates ? ` · ${bitrate} kbps` : ''}</p>
            {error && <p className="ex-error">Couldn’t export: {error}</p>}
            <div className="ex-actions">
              <button type="button" className="btn" onClick={onClose}>cancel</button>
              <button type="button" className="btn primary" onClick={render} disabled={!spec}>render</button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
