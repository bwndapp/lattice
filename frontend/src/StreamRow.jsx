import { useState, useSyncExternalStore } from 'react'
import { newStreamLink, streamAudioUrl, streamGuideUrl, streamState, streamUrl, subscribeStream, toggleStream } from './stream.js'
import './StreamRow.css'

/** One address with a copy button. */
function Link({ label, url, open = false, note }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* no clipboard */ }
  }
  return (
    <div className="stream-field">
      <span className="stream-label">{label}</span>
      <div className="stream-link">
        <input className="node-input" readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn ghost" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
        {open && <a className="btn ghost" href={url} target="_blank" rel="noreferrer" title="Open the guide">↗</a>}
      </div>
      {note && <span className="stream-note">{note}</span>}
    </div>
  )
}

/**
 * The stream node's face: on/off, who's listening, where to listen, and the guide — one
 * page that explains every message, made to hand to an agent (or a person) as it is.
 * Its settings (frames a second, spectrum bins, audio on or off) are ordinary params above this.
 */
export default function StreamPanel({ audio = false }) {
  const s = useSyncExternalStore(subscribeStream, streamState)
  const status = !s.on ? 'off' : !s.connected ? 'connecting…' : s.listeners ? `${s.listeners} listening` : 'live · nobody listening yet'
  return (
    <div className={`stream-row nodrag ${s.on ? 'on' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="stream-top">
        <button type="button" className={`stream-switch ${s.on ? 'on' : ''}`} aria-pressed={s.on} onClick={toggleStream}
          title={s.on ? 'Stop streaming' : 'Start streaming'}>
          <span className={`stream-dot ${s.on && s.connected ? 'live' : ''}`} aria-hidden />
          {s.on ? 'on' : 'off'}
        </button>
        <span className="stream-status">{status}</span>
      </div>
      {s.on && (
        <>
          <Link label="listen" url={streamUrl(s.key)} note="a websocket: TouchDesigner's WebSocket DAT, Max, Python…" />
          {audio && <Link label="audio" url={streamAudioUrl(s.key)} note="the sound, lossless: an endless WAV for VLC, ffmpeg, OBS (raw frames too: see the guide)" />}
          <Link label="guide" url={streamGuideUrl(s.key)} open note="everything it sends, how to use it: give this to an agent" />
          <p className="stream-sends"><code>hit</code> every sound · <code>frame</code> spectrum, bands, energy, beat · <code>transport</code> play / stop</p>
          <button type="button" className="stream-new" onClick={newStreamLink} title="Anyone with the old link stops receiving">new link</button>
        </>
      )}
    </div>
  )
}
