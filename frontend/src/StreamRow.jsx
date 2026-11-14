import { useState, useSyncExternalStore } from 'react'
import { newStreamLink, streamState, streamUrl, subscribeStream, toggleStream } from './stream.js'
import './StreamRow.css'

/**
 * The output node's stream switch: on, it publishes every hit and sixty frames a second of
 * spectrum and energy for anything holding the link (see stream.js) — TouchDesigner's
 * WebSocket DAT, say. The link stays the same for this track until you ask for a new one.
 */
export default function StreamRow() {
  const s = useSyncExternalStore(subscribeStream, streamState)
  const [copied, setCopied] = useState(false)
  const url = streamUrl(s.key)
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* no clipboard */ }
  }
  const status = !s.on ? 'off' : !s.connected ? 'connecting' : s.listeners ? `${s.listeners} listening` : 'live · nobody listening yet'
  return (
    <div className={`stream-row nodrag ${s.on ? 'on' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="stream-top">
        <button type="button" className={`stream-switch ${s.on ? 'on' : ''}`} aria-pressed={s.on} onClick={toggleStream}
          title="Stream what's playing as data — every hit, plus spectrum and energy sixty times a second — over a websocket, for TouchDesigner, Max or anything else">
          <span className={`stream-dot ${s.on && s.connected ? 'live' : ''}`} aria-hidden />
          stream
        </button>
        <span className="stream-status">{status}</span>
      </div>
      {s.on && (
        <>
          <div className="stream-link">
            <input className="node-input" readOnly value={url} aria-label="Stream address" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn ghost" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
          </div>
          <p className="stream-hint">
            TouchDesigner: a <b>WebSocket DAT</b> with this as its network address, then parse the JSON
            (<code>hit</code> and <code>frame</code> messages).{' '}
            <button type="button" className="stream-new" onClick={newStreamLink} title="Make a new link: anyone with the old one stops receiving">new link</button>
          </p>
        </>
      )}
    </div>
  )
}
