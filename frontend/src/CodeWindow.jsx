import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import CodeBox from './CodeBox.jsx'
import { closeSynth, raiseSynth } from './instruments/windows.js'
import './instruments/SynthWindow.css'
import './CodeBox.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const places = new Map() // window id → where it was, for when it opens again

/**
 * Code, in a window of its own — the same kind of window an engine gets, because it's the
 * same kind of thing: one piece of the track, open while you work on everything else.
 * Drag it by the title bar, leave it open, put it behind something; what you apply in it
 * is on the patch at once, and closing applies what's in it.
 */
export default function CodeWindow({ window: win, project, order, front, onUpdateProject }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const pattern = win.patternId ? project.patterns.find((p) => p.id === win.patternId) : null
  const channel = win.channelId ? pattern?.channels.find((c) => c.id === win.channelId) : null
  const node = win.nodeId ? project.nodes.find((n) => n.id === win.nodeId) : null
  const value = String((channel ? channel.code : node?.data?.[win.key]) ?? '')
  const gone = win.channelId ? !channel : !node
  const close = () => closeSynth(win.id)

  const [pos, setPos] = useState(() => places.get(win.id)
    ?? { x: Math.max(16, globalThis.innerWidth / 2 - 420) + order * 28, y: 96 + order * 28 })
  useEffect(() => { places.set(win.id, pos) }, [win.id, pos])

  // what it belongs to was deleted while its window was open
  useEffect(() => { if (gone) close() }, [gone]) // eslint-disable-line react-hooks/exhaustive-deps

  // always reachable: the title bar stays on screen
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const fit = () => setPos((p) => {
      const next = { x: clamp(p.x, 8 - el.offsetWidth + 120, globalThis.innerWidth - 120), y: clamp(p.y, 8, globalThis.innerHeight - 48) }
      return next.x === p.x && next.y === p.y ? p : next
    })
    fit()
    globalThis.addEventListener('resize', fit)
    return () => globalThis.removeEventListener('resize', fit)
  }, [])

  const startDrag = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }
  const moveDrag = (e) => {
    const d = drag.current
    if (!d) return
    setPos({
      x: clamp(e.clientX - d.x, 8 - ref.current.offsetWidth + 120, globalThis.innerWidth - 120),
      y: clamp(e.clientY - d.y, 8, globalThis.innerHeight - 48),
    })
  }
  const endDrag = () => { drag.current = null }

  if (gone) return null
  const name = channel ? channel.name : (node?.data?.name || 'code')
  const where = channel ? pattern?.name : null

  return (
    <div
      ref={ref}
      className={`synth-window code-window ${front ? 'front' : ''}`}
      data-surface={`panel:${win.id}`}
      role="dialog"
      aria-labelledby={`cw-title-${win.id}`}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, zIndex: 50 + order }}
      onPointerDownCapture={() => raiseSynth(win.id)}
      onFocusCapture={() => raiseSynth(win.id)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return }
        e.stopPropagation() // typing here is typing, not shortcuts for what's behind it
      }}
    >
      <header
        className="sw-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => { if (!e.target.closest('button')) setPos({ x: Math.max(16, globalThis.innerWidth / 2 - (ref.current?.offsetWidth ?? 840) / 2), y: 90 }) }}
        title="Drag to move · double-click to centre"
      >
        <h2 id={`cw-title-${win.id}`} className="sw-title">{name}</h2>
        <span className="sw-kind">code</span>
        {where && where.trim().toLowerCase() !== name.trim().toLowerCase() && <span className="sw-where">{where}</span>}
        <span className="sw-spacer" />
        <span className="cw-keys">ctrl/cmd ⏎ applies</span>
        <button type="button" className="sw-close" onClick={close} title="Close (Esc)" aria-label="Close the code window">×</button>
      </header>
      <div className="sw-body cw-body">
        <CodeBox
          value={value}
          numbers
          autoFocus
          onCommit={(text) => onUpdateProject((p) => {
            if (win.channelId) {
              const ch = p.patterns.find((x) => x.id === win.patternId)?.channels.find((c) => c.id === win.channelId)
              if (ch) ch.code = text
            } else {
              const n = p.nodes.find((x) => x.id === win.nodeId)
              if (n) n.data = { ...n.data, [win.key]: text }
            }
          })}
        />
      </div>
    </div>
  )
}
