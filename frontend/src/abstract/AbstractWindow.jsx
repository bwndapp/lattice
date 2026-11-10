import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closeSynth, raiseSynth } from '../instruments/windows.js'
import { abstractOf, packState } from './index.js'
import { PANELS } from './panels.js'
import '../instruments/SynthWindow.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const places = new Map() // window id → where it was, for when it opens again
const panels = new Map() // type → its lazily loaded window body

function panelFor(def) {
  if (!panels.has(def.type)) panels.set(def.type, lazy(PANELS[def.type]))
  return panels.get(def.type)
}

/**
 * An abstract instrument's window (see abstract/index.js): the same floating plugin window
 * an engine or a code window is, holding whatever face the instrument draws for itself.
 * Its body gets the node's state and `change(fn)`, a function from state to new state that
 * lands on the track at once (and in undo, and with everyone in the room).
 */
export default function AbstractWindow({ window: win, project, order, front, onUpdateProject, transport }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const node = project.nodes.find((n) => n.id === win.nodeId)
  const def = abstractOf(node?.type)
  const close = () => closeSynth(win.id)

  const [pos, setPos] = useState(() => places.get(win.id)
    ?? { x: Math.max(16, globalThis.innerWidth / 2 - (def?.width ?? 720) / 2) + order * 28, y: 90 + order * 28 })
  useEffect(() => { places.set(win.id, pos) }, [win.id, pos])
  // what it belongs to was deleted while its window was open
  useEffect(() => { if (!def) close() }, [def]) // eslint-disable-line react-hooks/exhaustive-deps
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
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])

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

  if (!def) return null
  const state = def.normalize(node.data?.state)
  const change = (fn) => onUpdateProject((p) => {
    const n = p.nodes.find((x) => x.id === win.nodeId)
    if (!n) return
    n.data = { ...n.data, state: packState(n.type, fn(def.normalize(n.data?.state))) }
  })
  const Panel = PANELS[def.type] ? panelFor(def) : () => <p className="meta" style={{ padding: '1rem' }}>no window yet</p>
  const name = node.data?.name || def.label

  return (
    <div
      ref={ref}
      className={`synth-window sw-abstract sw-${def.type} ${front ? 'front' : ''} ${def.width ? 'wide' : ''}`}
      data-surface={`panel:${win.id}`}
      role="dialog"
      aria-labelledby={`aw-title-${win.id}`}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, zIndex: 50 + order, width: def.width ? `min(${def.width}px, calc(100vw - 32px))` : undefined }}
      onPointerDownCapture={() => raiseSynth(win.id)}
      onFocusCapture={() => raiseSynth(win.id)}
      onKeyDown={(e) => {
        e.stopPropagation() // keys stay in here: Delete must not delete nodes behind the window
        if (e.key === 'Escape' && !e.target.closest?.('input, textarea, select')) close()
      }}
    >
      <header
        className="sw-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => { if (!e.target.closest('button')) setPos({ x: Math.max(16, globalThis.innerWidth / 2 - (ref.current?.offsetWidth ?? 720) / 2), y: 90 }) }}
        title="Drag to move · double-click to centre"
      >
        <h2 id={`aw-title-${win.id}`} className="sw-title">{name}</h2>
        {name.toLowerCase() !== def.label.toLowerCase() && <span className="sw-kind">{def.label}</span>}
        <span className="sw-spacer" />
        <button type="button" className="sw-close" onClick={close} title="Close (Esc)" aria-label={`Close ${def.label}`}>×</button>
      </header>
      <div className="sw-body">
        <Suspense fallback={<p className="meta" style={{ padding: '1rem' }}>loading…</p>}>
          <Panel
            state={state}
            change={change}
            cps={(Number(project.bpm) || 140) / (Number(project.beats) || 4) / 60}
            position={() => transport?.position() ?? 0}
            playing={() => !!transport?.playing()}
          />
        </Suspense>
      </div>
    </div>
  )
}
