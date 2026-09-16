import { useEffect, useRef, useState } from 'react'
import { FORMATS, availableFormats, download, encodeBuffer, normalize, renderProject } from './exportAudio.js'
import { songLength } from './song'
import './ExportDialog.css'

const clean = (name) => (name || 'track').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'track'
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * Bounce the track to a file: what to render, in what format, at what quality. The render
 * runs offline, so it's quicker than playing the track through.
 */
export default function ExportDialog({ project, title, transport, onClose, onFlash }) {
  const ref = useRef(null)
  const [formats, setFormats] = useState(FORMATS.filter((f) => f.codec.startsWith('pcm')))
  const [format, setFormat] = useState('wav24')
  const [bitrate, setBitrate] = useState(320)
  const [rate, setRate] = useState(48000)
  const [tail, setTail] = useState(2)
  const [loud, setLoud] = useState(false)
  const [bars, setBars] = useState(8)
  const [busy, setBusy] = useState(null)
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

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  useEffect(() => { availableFormats().then(setFormats).catch(() => {}) }, [])

  const run = async () => {
    setError('')
    setBusy('getting ready')
    try {
      const buffer = await renderProject(project, { ...range, tail: Number(tail), sampleRate: rate, onStage: setBusy })
      if (loud) normalize(buffer)
      setBusy('writing the file')
      const { blob, ext } = await encodeBuffer(buffer, { format: spec.key, bitrate })
      download(blob, `${clean(title)}.${ext}`)
      onFlash?.(`Exported ${clean(title)}.${ext} · ${clock(buffer.duration)}`)
      onClose()
    } catch (e) {
      setError(e.message || String(e))
      setBusy(null)
    }
  }

  return (
    <dialog
      ref={ref}
      className="export-dialog"
      aria-labelledby="export-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current && !busy) onClose() }}
    >
      <div className="ex-body">
        <div className="ex-head">
          <h2 id="export-title" className="ex-title">Export</h2>
          <span className="ex-name">{clean(title)}.{spec?.ext ?? 'wav'}</span>
        </div>

        <div className="ex-row">
          <span className="ex-label">what</span>
          <span className="ex-seg" role="group" aria-label="What to export">
            {song > 0 && <button type="button" className={what === 'song' ? 'on' : ''} onClick={() => setWhat('song')}>the song · {song} bars</button>}
            {looping && <button type="button" className={what === 'loop' ? 'on' : ''} onClick={() => setWhat('loop')}>the loop · {Math.round((transport.loop.to - transport.loop.from) * 10) / 10} bars</button>}
            <button type="button" className={what === 'bars' ? 'on' : ''} onClick={() => setWhat('bars')}>{song > 0 ? 'a few bars' : 'the patch'}</button>
          </span>
        </div>
        {what === 'bars' && (
          <div className="ex-row">
            <span className="ex-label">bars</span>
            <span className="ex-seg" role="group" aria-label="How many bars">
              {[2, 4, 8, 16, 32, 64].map((b) => (
                <button key={b} type="button" className={bars === b ? 'on' : ''} onClick={() => setBars(b)}>{b}</button>
              ))}
            </span>
          </div>
        )}

        <div className="ex-row">
          <span className="ex-label">format</span>
          <span className="ex-seg" role="group" aria-label="Format">
            {formats.map((f) => (
              <button key={f.key} type="button" className={format === f.key ? 'on' : ''} onClick={() => setFormat(f.key)}>{f.label}</button>
            ))}
          </span>
        </div>
        {spec?.bitrates && (
          <div className="ex-row">
            <span className="ex-label">bitrate</span>
            <span className="ex-seg" role="group" aria-label="Bitrate">
              {spec.bitrates.map((b) => (
                <button key={b} type="button" className={bitrate === b ? 'on' : ''} onClick={() => setBitrate(b)}>{b} kbps</button>
              ))}
            </span>
          </div>
        )}
        <div className="ex-row">
          <span className="ex-label">sample rate</span>
          <span className="ex-seg" role="group" aria-label="Sample rate">
            {[44100, 48000].map((r) => (
              <button key={r} type="button" className={rate === r ? 'on' : ''} onClick={() => setRate(r)}>{r / 1000} kHz</button>
            ))}
          </span>
        </div>
        <div className="ex-row">
          <span className="ex-label">tail</span>
          <span className="ex-seg" role="group" aria-label="Tail">
            {[0, 1, 2, 4, 8].map((t) => (
              <button key={t} type="button" className={Number(tail) === t ? 'on' : ''} onClick={() => setTail(t)}>{t === 0 ? 'none' : `${t}s`}</button>
            ))}
          </span>
          <span className="ex-note">room for reverbs and echoes to ring out</span>
        </div>
        <label className="ex-check">
          <input type="checkbox" checked={loud} onChange={(e) => setLoud(e.target.checked)} />
          <span>turn it up to just under full scale</span>
        </label>

        <p className="ex-summary">{clock(seconds)} of audio{spec ? ` · ${spec.label}` : ''}{spec?.bitrates ? ` · ${bitrate} kbps` : ''} · {rate / 1000} kHz</p>
        {error && <p className="ex-error">Couldn’t export: {error}</p>}
        <p className="ex-note">Playback stops while it renders.</p>

        <div className="ex-actions">
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>cancel</button>
          <button type="button" className="btn primary" onClick={run} disabled={!!busy || !spec}>{busy ? `${busy}…` : 'export'}</button>
        </div>
      </div>
    </dialog>
  )
}
