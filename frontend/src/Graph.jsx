import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, applyEdgeChanges, useNodesInitialized, useReactFlow, useUpdateNodeInternals,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { APPLY, BUS_NODES, FX_UNITS, GROUPS, NODE_TYPES, defaultData, inputsOf, makeFxUnit, makesCycle } from './graph'
import { INSTRUMENTS, INSTRUMENT_MIME, instrumentChannel, makePattern, newId } from './project'
import Knob from './Knob.jsx'
import { canAutomate, nodeTarget, unitTarget } from './automation.js'
import SoundPicker from './SoundPicker.jsx'
import { useRollDock } from './rollDock.js'
import AddMenu from './AddMenu.jsx'
import { ADD_INTO_WIRE, EDGE_TYPES } from './WireEdge.jsx'
import { copyNodes, pasteNodes, readClipboard, writeClipboard } from './nodeClipboard'
import { onSoundsChange, previewSound, soundCatalog } from './audio'
import { flowPaths, setFlowPaths, startFlow, stopFlow } from './flow.js'
import { colorFor, inkFor, nodeSrc, rgbOf } from './clipColors.js'
import { useTypingKeys } from './typingKeys.js'
import { readOctave, writeOctave } from './keyboard.js'

const NODE_MIME = 'application/x-strudel-node'
const Ctx = createContext(null)

const slotNum = (h) => Number(/^in-(\d+)$/.exec(h ?? '')?.[1] ?? -1)
const SOURCE_TYPES = new Set(Object.entries(NODE_TYPES).filter(([, s]) => s.group === 'source').map(([k]) => k))

const FLOW_KEY = 'strudel.flow'
const flowWanted = () => { try { return localStorage.getItem(FLOW_KEY) !== 'off' } catch { return true } }

/** Can this kind of node be dropped into the middle of a wire? It needs an input and an output. */
const splicable = (type) => !!NODE_TYPES[type]?.inputs && type !== 'output'
const firstInput = (type) => (NODE_TYPES[type]?.inputs === 1 ? 'in' : 'in-0')

/**
 * The wire under a screen rectangle (or near a point), found by sampling each rendered
 * edge path. `skip` (a node id, or ids) leaves out wires touching those nodes.
 */
function wireAt(box, skip = null) {
  const skips = [].concat(skip ?? [])
  for (const el of document.querySelectorAll('.graph-canvas .react-flow__edge')) {
    const id = el.getAttribute('data-id') ?? el.dataset.id
    const touches = el.dataset.touches?.split(' ') ?? []
    if (!id || skips.some((s) => touches.includes(s))) continue
    const path = el.querySelector('path.react-flow__edge-path')
    const ctm = path?.getScreenCTM()
    if (!path || !ctm) continue
    const length = path.getTotalLength()
    for (let t = 0; t <= length; t += 10) {
      const p = path.getPointAtLength(t)
      const x = ctm.a * p.x + ctm.c * p.y + ctm.e
      const y = ctm.b * p.x + ctm.d * p.y + ctm.f
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return id
    }
  }
  return null
}

/** Rewire A → B into A → node → B. Mutates the project draft. */
function spliceInto(p, edgeId, nodeId) {
  const wire = p.edges.find((e) => e.id === edgeId)
  const node = p.nodes.find((n) => n.id === nodeId)
  if (!wire || !node || !splicable(node.type) || wire.source === nodeId || wire.target === nodeId) return false
  p.edges = p.edges.filter((e) => e !== wire && e.source !== nodeId && e.target !== nodeId)
  p.edges.push({ source: wire.source, sourceHandle: wire.sourceHandle, target: nodeId, targetHandle: firstInput(node.type) })
  p.edges.push({ source: nodeId, target: wire.target, targetHandle: wire.targetHandle })
  return true
}

/**
 * A group of nodes that can drop into a wire as one: wired to nothing outside the group,
 * with one way in (a node whose first input is free) and one way out (a node whose output
 * goes nowhere in the group). Returns { head, tail } or null.
 */
function chainOf(project, ids) {
  const group = new Set(ids)
  const nodes = project.nodes.filter((n) => group.has(n.id))
  if (nodes.length < 2 || nodes.some((n) => n.type === 'output')) return null
  if (project.edges.some((e) => group.has(e.source) !== group.has(e.target))) return null
  const inner = project.edges.filter((e) => group.has(e.source) && group.has(e.target))
  const heads = nodes.filter((n) => splicable(n.type) && !inner.some((e) => e.target === n.id && e.targetHandle === firstInput(n.type)))
  const tails = nodes.filter((n) => !inner.some((e) => e.source === n.id))
  if (heads.length !== 1 || tails.length !== 1) return null
  return { head: heads[0].id, tail: tails[0].id }
}

/** Rewire A → B into A → head … tail → B for a chain of nodes. Mutates the project draft. */
function spliceChain(p, edgeId, { head, tail }) {
  const wire = p.edges.find((e) => e.id === edgeId)
  const first = p.nodes.find((n) => n.id === head)
  if (!wire || !first || [head, tail].includes(wire.source) || [head, tail].includes(wire.target)) return false
  p.edges = p.edges.filter((e) => e !== wire)
  p.edges.push({ source: wire.source, sourceHandle: wire.sourceHandle, target: head, targetHandle: firstInput(first.type) })
  p.edges.push({ source: tail, target: wire.target, targetHandle: wire.targetHandle })
  return true
}

/**
 * Ctrl/cmd + G: fold selected effect nodes (and fx racks) into one fx rack, in signal order.
 * Wired as a chain, the rack takes the chain's place: its input is the first node's input
 * and its output feeds wherever the last node fed. Unwired, they go in left to right.
 * Anything else (a source in the selection, wires branching in or out of the middle) is
 * left alone. Mutates the draft; returns the rack's id, or null.
 */
function groupIntoRack(p, ids) {
  const group = new Set(ids)
  const nodes = p.nodes.filter((n) => group.has(n.id))
  if (nodes.length < 2 || !nodes.every((n) => n.type === 'fxrack' || FX_UNITS.includes(n.type))) return null
  const inner = p.edges.filter((e) => group.has(e.source) && group.has(e.target))
  const incoming = p.edges.filter((e) => !group.has(e.source) && group.has(e.target))
  const outgoing = p.edges.filter((e) => group.has(e.source) && !group.has(e.target))
  let order
  if (!inner.length) {
    if (incoming.length || outgoing.length) return null
    order = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y)
  } else {
    // one straight line: each node has at most one wire in from the group and one out to it
    if (nodes.some((n) => inner.filter((e) => e.target === n.id).length > 1 || inner.filter((e) => e.source === n.id).length > 1)) return null
    const head = nodes.filter((n) => !inner.some((e) => e.target === n.id))
    if (head.length !== 1) return null
    order = [head[0]]
    for (let next; (next = inner.find((e) => e.source === order.at(-1).id)); ) order.push(p.nodes.find((n) => n.id === next.target))
    if (order.length !== nodes.length) return null
    const first = order[0].id
    const last = order.at(-1).id
    if (incoming.some((e) => e.target !== first) || incoming.length > 1 || outgoing.some((e) => e.source !== last)) return null
  }
  const chain = order.flatMap((n) => (n.type === 'fxrack'
    ? (n.data.chain ?? []).map((u) => ({ ...JSON.parse(JSON.stringify(u)), id: `fx${newId().slice(-7)}` }))
    : [{ id: `fx${newId().slice(-7)}`, type: n.type, on: true, data: JSON.parse(JSON.stringify(n.data ?? {})) }]))
  if (chain.length > 16) return null
  const id = `fxrack${newId().slice(-5)}`
  p.nodes = p.nodes.filter((n) => !group.has(n.id))
  p.nodes.push({ id, type: 'fxrack', x: order[0].x, y: order[0].y, data: { ...defaultData('fxrack'), chain } })
  p.edges = p.edges.filter((e) => !group.has(e.source) && !group.has(e.target))
  for (const e of incoming) p.edges.push({ source: e.source, sourceHandle: e.sourceHandle, target: id, targetHandle: 'in' })
  for (const e of outgoing) p.edges.push({ source: id, target: e.target, targetHandle: e.targetHandle })
  return id
}

/** What a node is called on wires and in lists; `from` names the port the wire left by. */
function nodeTitle(node, project, from = 'out') {
  if (!node) return '?'
  if (node.type === 'pattern' && String(from ?? '').startsWith('out-')) {
    const pat = project.patterns.find((p) => p.id === node.data.patternId)
    const chan = pat?.channels.find((c) => `out-${c.id}` === from)
    if (chan) return `${pat.name} · ${chan.name}`
  }
  if (node.data?.name) return node.data.name
  if (node.type === 'pattern') return project.patterns.find((p) => p.id === node.data.patternId)?.name ?? 'pattern'
  if (node.type === 'sound') return `${NODE_TYPES.sound.label} ${node.data.mini}`
  return NODE_TYPES[node.type]?.label ?? node.type
}

/** A text field that applies on Enter or blur. */
function CommitInput({ value, onCommit, multiline = false, ...props }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = () => { if (text !== value) onCommit(text) }
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      {...props}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); e.currentTarget.blur() }
        if (e.key === 'Escape') { setText(value ?? ''); e.currentTarget.blur() }
        e.stopPropagation()
      }}
    />
  )
}

function Stepper({ param, value, onChange }) {
  const set = (v) => onChange(Math.min(param.max, Math.max(param.min, Math.round(v))))
  return (
    <label className="stepper nodrag">
      <span className="stepper-label">{param.label}</span>
      <button type="button" onClick={() => set(value - 1)} aria-label={`${param.label} down`}>−</button>
      <input
        inputMode="numeric"
        value={value}
        aria-label={param.label}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set(v) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); set(value + 1) }
          if (e.key === 'ArrowDown') { e.preventDefault(); set(value - 1) }
          e.stopPropagation()
        }}
      />
      <button type="button" onClick={() => set(value + 1)} aria-label={`${param.label} up`}>+</button>
    </label>
  )
}

/** Drum kits Strudel has loaded, kept fresh as sample packs finish loading. */
function useKits() {
  const [kits, setKits] = useState(() => soundCatalog().kits)
  useEffect(() => onSoundsChange(() => setKits(soundCatalog().kits)), [])
  return kits
}

/** A dropdown of drum kits; picking one plays a hit from the node's rhythm in that kit. */
export function KitSelect({ node, param, value: given, onChange }) {
  const kits = useKits()
  const value = String(given ?? node.data[param.key] ?? '')
  const current = kits.find((k) => k.bank === value.toLowerCase())
  // the first sound named in the rhythm (hh*16 → hh), to audition the kit with
  const firstSound = (String(node.data.mini ?? '').match(/[a-z][\w]*/i) ?? ['bd'])[0]
  return (
    <label className="node-field wide nodrag">
      <span>{param.label}{current ? ` · ${current.sounds.length} sounds` : ''}</span>
      <select
        className="select kit-select"
        value={current ? current.bank : value ? `raw:${value}` : ''}
        onChange={(e) => {
          const bank = e.target.value.startsWith('raw:') ? e.target.value.slice(4) : e.target.value
          onChange(bank)
          previewSound({ s: firstSound, bank: bank || undefined })
        }}
      >
        <option value="">default sounds</option>
        {value && !current && <option value={`raw:${value}`}>{value}{kits.length ? ' (not loaded)' : ''}</option>}
        {kits.map((k) => <option key={k.bank} value={k.bank}>{k.bank}</option>)}
      </select>
    </label>
  )
}

/** The controls for one parameter of a node. */
function Param({ node, param, value: given, onChange, target: givenTarget }) {
  const ctx = useContext(Ctx)
  const value = given !== undefined ? given : node.data[param.key]
  // what right-click → automate moves (an fx rack's units pass their own)
  const target = givenTarget !== undefined ? givenTarget : canAutomate(node.type, param.key) ? nodeTarget(node.id, param.key) : null
  const set = onChange ?? ((v) => ctx.updateNode(node.id, (d) => { d[param.key] = v }))
  switch (param.type) {
    case 'kit':
      return <KitSelect node={node} param={param} value={value} onChange={set} />
    case 'knob':
      return <div className="nowheel"><Knob def={param} value={value} onChange={set} target={target} /></div>
    case 'int':
      return <Stepper param={param} value={value} onChange={set} />
    case 'select':
      return (
        <label className="node-field nodrag">
          <span>{param.label}</span>
          <select className="select" value={value} onChange={(e) => set(e.target.value)}>
            {param.options.map((o) => <option key={o} value={o}>{APPLY[o]?.label ?? o}</option>)}
          </select>
        </label>
      )
    case 'sound':
      return (
        <label className="node-field nodrag">
          <span>{param.label}</span>
          <button className="sound-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); ctx.pickSound(node.id, param.key, { x: r.left, y: r.bottom }) }}>
            <span className="sound-name">{value}</span><span className="sound-caret" aria-hidden>▾</span>
          </button>
        </label>
      )
    case 'code':
      return (
        <label className="node-field wide nodrag nowheel">
          <span>{param.label}</span>
          <CommitInput multiline className="node-code" value={value} spellCheck={false} rows={3} onCommit={set} title="Any Strudel pattern · ctrl/cmd + enter to apply" />
        </label>
      )
    default: // text, mini
      return (
        <label className={`node-field nodrag ${param.type === 'mini' ? 'wide' : ''}`}>
          <span>{param.label}</span>
          <CommitInput className={`node-input ${param.type === 'mini' ? 'mini' : ''}`} value={value} spellCheck={false} onCommit={set} title={param.type === 'mini' ? 'Mini-notation: "bd*4", "c3 e3 g3", "<a b>" · Enter to apply' : undefined} />
        </label>
      )
  }
}

/** The inside of an fx rack: effect units that the sound passes through, top to bottom. */
function FxRack({ node }) {
  const ctx = useContext(Ctx)
  const flow = useReactFlow()
  const chain = node.data.chain ?? []
  const edit = (fn) => ctx.updateNode(node.id, (d) => { d.chain = d.chain ?? []; fn(d.chain) })
  const at = (list, unitId) => list.findIndex((u) => u.id === unitId)

  // drag an effect up or down the chain. Where it would land is only drawn until you let
  // go: moving it for real on every frame would rebuild the sound as you dragged.
  const listRef = useRef(null)
  const [drag, setDrag] = useState(null) // { id, from, to, dy, ... }
  const dragRef = useRef(null)
  dragRef.current = drag
  const grab = (e, unit, i) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({
      id: unit.id,
      from: i,
      to: i,
      dy: 0,
      startY: e.clientY,
      // where the rows sit now: the one being dragged moves with the pointer, so
      // measuring live would have it forever finding itself
      rows: [...(listRef.current?.children ?? [])].map((el) => el.getBoundingClientRect()),
      zoom: flow.getZoom() || 1,
    })
  }
  const moveTo = (e) => {
    const held = dragRef.current
    if (!held) return
    const found = held.rows.findIndex((r) => e.clientY < r.bottom)
    const to = found === -1 ? Math.max(0, held.rows.length - 1) : found
    // the canvas may be zoomed, so what the pointer moved isn't what the node moved
    setDrag({ ...held, to, dy: (e.clientY - held.startY) / held.zoom })
  }
  const drop = () => {
    const held = dragRef.current
    setDrag(null)
    if (!held || held.to === held.from) return
    edit((c) => {
      const j = at(c, held.id)
      if (j < 0) return
      const [unit] = c.splice(j, 1)
      c.splice(Math.min(c.length, held.to), 0, unit)
    })
  }

  return (
    <div className="fx-rack">
      <span className="fx-io">in</span>
      {chain.length === 0 && <p className="node-hint fx-empty">No effects yet. Add some below; the sound runs through them top to bottom.</p>}
      <ol className="fx-units" ref={listRef}>
        {chain.map((unit, i) => {
          const spec = NODE_TYPES[unit.type]
          const held = drag?.id === unit.id
          const landing = drag && drag.to === i && drag.to !== drag.from
          return (
            <li
              key={unit.id}
              className={`fx-unit ${unit.on ? '' : 'bypassed'} ${held ? 'held' : ''} ${landing ? (drag.to > drag.from ? 'land-after' : 'land-before') : ''}`}
              style={held ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              <div
                className="fx-unit-head nodrag"
                title="Drag to move it along the chain"
                onPointerDown={(e) => grab(e, unit, i)}
                onPointerMove={moveTo}
                onPointerUp={drop}
                onPointerCancel={drop}
              >
                <span className="fx-dots" aria-hidden />
                <span className="fx-grip" aria-hidden>{i + 1}</span>
                <span className="fx-unit-name">{spec.label}</span>
                <button
                  className={`fx-toggle nodrag ${unit.on ? 'on' : ''}`}
                  aria-pressed={unit.on}
                  title={unit.on ? 'Bypass this effect' : 'Turn this effect back on'}
                  onClick={() => edit((c) => { const j = at(c, unit.id); if (j >= 0) c[j].on = !c[j].on })}
                >{unit.on ? 'on' : 'off'}</button>
                <button className="node-btn nodrag" disabled={i === 0} title="Move up (earlier)" aria-label={`Move ${spec.label} up`}
                  onClick={() => edit((c) => { const j = at(c, unit.id); if (j > 0) [c[j - 1], c[j]] = [c[j], c[j - 1]] })}>up</button>
                <button className="node-btn nodrag" disabled={i === chain.length - 1} title="Move down (later)" aria-label={`Move ${spec.label} down`}
                  onClick={() => edit((c) => { const j = at(c, unit.id); if (j >= 0 && j < c.length - 1) [c[j + 1], c[j]] = [c[j], c[j + 1]] })}>dn</button>
                <button className="node-btn nodrag" title="Remove" aria-label={`Remove ${spec.label}`}
                  onClick={() => edit((c) => { const j = at(c, unit.id); if (j >= 0) c.splice(j, 1) })}>×</button>
              </div>
              <div className="node-params">
                {spec.params.map((p) => (
                  <Param
                    key={p.key}
                    node={node}
                    param={p}
                    value={unit.data[p.key]}
                    target={canAutomate(unit.type, p.key) ? unitTarget(node.id, unit.id, p.key) : null}
                    onChange={(v) => edit((c) => { const j = at(c, unit.id); if (j >= 0) c[j].data[p.key] = v })}
                  />
                ))}
              </div>
            </li>
          )
        })}
      </ol>
      <label className="node-field wide nodrag fx-add">
        <span className="sr-only">Add an effect</span>
        <select
          className="select"
          value=""
          onChange={(e) => {
            const type = e.target.value
            if (type) edit((c) => { c.push(makeFxUnit(type, `fx${newId().slice(-7)}`)) })
          }}
        >
          <option value="">+ add effect</option>
          {FX_UNITS.map((t) => <option key={t} value={t}>{NODE_TYPES[t].label}</option>)}
        </select>
      </label>
      <span className="fx-io">out</span>
    </div>
  )
}

/** One card on the canvas. Everything reads the project through context, so it's never stale. */
function StudioNode({ id, selected }) {
  const ctx = useContext(Ctx)
  const node = ctx.project.nodes.find((n) => n.id === id)
  const updateInternals = useUpdateNodeInternals()
  const spec = node && NODE_TYPES[node.type]
  const wires = node ? inputsOf(ctx.project.edges, id) : []
  const patternOf = node?.type === 'pattern' && ctx.project.patterns.find((p) => p.id === node.data.patternId)
  // the ports move when inputs or instruments come and go, so react flow has to re-measure
  const slotKey = `${wires.map((w) => w.targetHandle).join(',')}|${(patternOf ? patternOf.channels : []).map((c) => c.id).join(',')}`
  useEffect(() => { updateInternals(id) }, [id, slotKey, updateInternals])
  if (!node || !spec) return null

  const multi = spec.inputs === 'many'
  const offMain = node?.data?.offMain ?? {}
  const heldBack = Object.values(offMain).filter(Boolean).length
  const nextSlot = `in-${wires.reduce((m, w) => Math.max(m, slotNum(w.targetHandle)), -1) + 1}`
  const soloing = ctx.solo === id
  const pattern = patternOf
  // with instruments listed down the side, the main out joins them as the last row rather
  // than floating at the node's middle, where it landed on top of one of them
  const outInList = !!pattern && pattern.channels.length > 0

  // a part wears the same colour here as its clips do on the timeline
  const tint = spec.group === 'source' ? colorFor(nodeSrc(node, ctx.project), ctx.project.song?.colors) : null

  return (
    <div
      className={`gnode g-${spec.group} t-${node.type} ${selected ? 'selected' : ''} ${soloing ? 'soloing' : ''} ${node.type !== 'output' && !ctx.heard.has(id) ? 'unheard' : ''}`}
      style={tint ? { '--tint': tint, '--tint-ink': inkFor(tint) } : undefined}
    >
      {spec.inputs === 1 && <Handle type="target" position={Position.Left} id="in" className="port in" />}
      <div className="node-head">
        <span className="node-kind">{spec.label}</span>
        {BUS_NODES.has(node.type) && (
          <span className="node-bus" title="Runs on the bus: it works on everything mixed into it, after every per-note effect in the patch">bus</span>
        )}
        <span className="node-title">{node.type === 'pattern' ? pattern?.name ?? 'no pattern' : node.data.name ?? ''}</span>
        {node.type !== 'output' && (
          <button
            className={`node-btn nodrag ${soloing ? 'on' : ''}`}
            onClick={() => ctx.setSolo(soloing ? null : id)}
            title={soloing ? 'Stop auditioning; play the output again' : 'Hear only this node'}
            aria-pressed={soloing}
          >solo</button>
        )}
        <button className="node-btn nodrag" onClick={() => ctx.removeNode(id)} title="Delete node" aria-label={`Delete ${spec.label}`}>×</button>
      </div>

      <div className="node-body">
        {node.type !== 'output' && !ctx.heard.has(id) && (
          <p className="node-warn">
            {spec.inputs && wires.length === 0
              ? 'not heard · drop it on a wire, or wire it between a sound and the output'
              : 'not heard · wire its right dot on toward the output'}
          </p>
        )}
        {node.type === 'pattern' && (
          <>
            <label className="node-field wide nodrag">
              <span>pattern</span>
              <select
                className="select"
                value={node.data.patternId ?? ''}
                onChange={(e) => {
                  if (e.target.value === '__new') return ctx.newPatternFor(id)
                  ctx.updateNode(id, (d) => { d.patternId = e.target.value })
                }}
              >
                {ctx.project.patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="__new">+ new pattern</option>
              </select>
            </label>
            {pattern && (
              pattern.channels.length ? (
                <ul className="node-chans">
                  {pattern.channels.map((c) => {
                    const wired = ctx.project.edges.some((e) => e.source === id && e.sourceHandle === `out-${c.id}`)
                    const onMain = !offMain[c.id]
                    return (
                      <li key={c.id} className={`chan ${c.mute ? 'muted' : ''} ${wired ? 'wired' : ''} ${onMain ? '' : 'held'}`} data-flow={`${id}|${c.id}`}>
                        <span className="chan-name">{c.name}</span>
                        {wired && (
                          <button
                            className={`chan-main nodrag ${onMain ? 'on' : ''}`}
                            aria-pressed={onMain}
                            title={onMain
                              ? `${c.name} plays out the main port as well as its own wire · click to take it off the main`
                              : `${c.name} only leaves by its own wire · click to put it back on the main`}
                            onClick={() => ctx.updateNode(id, (d) => { d.offMain = { ...(d.offMain ?? {}), [c.id]: onMain } })}
                          >main</button>
                        )}
                        <Handle
                          type="source"
                          position={Position.Right}
                          id={`out-${c.id}`}
                          className={`port out chan-port ${wired ? '' : 'free'}`}
                          title={`Wire ${c.name} somewhere of its own`}
                        />
                      </li>
                    )
                  })}
                  <li className="chan mix">
                    <span className="chan-name">{heldBack > 0 ? 'rest' : 'all'}</span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id="out"
                      className="port out"
                      title={heldBack > 0 ? 'Every instrument except the ones held back' : 'Every instrument in the pattern'}
                    />
                  </li>
                </ul>
              ) : <div className="node-chans"><span className="node-hint">empty: add instruments</span></div>
            )}
            <div className="node-actions nodrag">
              <button className="btn primary" onClick={(e) => ctx.editPattern(node.data.patternId, e)} disabled={!pattern} title="Open the rack (or double-click the node)">edit steps &amp; notes</button>
            </div>
          </>
        )}

        {node.type === 'fxrack' && <FxRack node={node} />}

        {Array.isArray(spec.inputs) && (
          <ul className="node-inputs named">
            {spec.inputs.map((role, i) => {
              const handle = `in-${i}`
              const wire = wires.find((w) => w.targetHandle === handle)
              const src = wire && ctx.project.nodes.find((n) => n.id === wire.source)
              return (
                <li key={handle} className={`slot ${wire ? '' : 'free'}`}>
                  <Handle type="target" position={Position.Left} id={handle} className={`port in ${wire ? '' : 'free'}`} />
                  <span className="slot-role">{role}</span>
                  <span className="slot-name">{wire ? nodeTitle(src, ctx.project, wire.sourceHandle) : 'connect'}</span>
                </li>
              )
            })}
          </ul>
        )}

        {spec.params.length > 0 && (
          <div className="node-params">
            {spec.params.map((p) => <Param key={p.key} node={node} param={p} />)}
          </div>
        )}

        {multi && (
          <ul className="node-inputs">
            {wires.map((w) => {
              const src = ctx.project.nodes.find((n) => n.id === w.source)
              const muted = node.data.muted?.[w.targetHandle]
              const solo = node.data.solo === w.targetHandle
              return (
                <li key={w.targetHandle} className={`slot ${node.type === 'output' && (muted || (node.data.solo && !solo)) ? 'off' : ''}`}>
                  <Handle type="target" position={Position.Left} id={w.targetHandle} className="port in" />
                  <span className="slot-name">{nodeTitle(src, ctx.project, w.sourceHandle)}</span>
                  {node.type === 'arrange' && (
                    <Stepper
                      param={{ ...spec.slotParam, label: 'bars' }}
                      value={node.data.bars?.[w.targetHandle] ?? spec.slotParam.def}
                      onChange={(v) => ctx.updateNode(id, (d) => { d.bars = { ...(d.bars ?? {}), [w.targetHandle]: v } })}
                    />
                  )}
                  {node.type === 'output' && (
                    <span className="slot-ctl nodrag">
                      <button className={`led mute ${muted ? 'on' : ''}`} aria-pressed={!!muted} title="mute" onClick={() => ctx.updateNode(id, (d) => { d.muted = { ...(d.muted ?? {}), [w.targetHandle]: !muted } })}>m</button>
                      <button className={`led solo ${solo ? 'on' : ''}`} aria-pressed={solo} title="solo" onClick={() => ctx.updateNode(id, (d) => { d.solo = solo ? null : w.targetHandle })}>s</button>
                    </span>
                  )}
                </li>
              )
            })}
            <li className="slot free">
              <Handle type="target" position={Position.Left} id={nextSlot} className="port in free" />
              <span className="slot-name">{wires.length ? 'connect another' : node.type === 'output' ? 'connect what you want to hear' : 'connect inputs'}</span>
            </li>
          </ul>
        )}
      </div>

      {node.type !== 'output' && !outInList && <Handle type="source" position={Position.Right} id="out" className="port out" />}
    </div>
  )
}

const nodeTypes = { studio: StudioNode }

/** Everyday words people search for, per node type. */
const SEARCH_WORDS = {
  pattern: 'steps drums notes sequencer piano roll beat loop',
  sound: 'rhythm drum sample mini notation beat hits kit',
  notes: 'melody synth chords notes mini notation',
  code: 'strudel custom javascript expression write',
  fast: 'speed tempo faster slower double half time',
  every: 'alternate change cycle variation every few',
  sometimes: 'random chance probability maybe',
  euclid: 'rhythm polyrhythm spread hits pattern',
  thin: 'random drop degrade probability sparse fewer',
  echo: 'delay repeat stutter ghost',
  shape: 'reverse jux stereo swing palindrome iter ply shuffle',
  transpose: 'pitch key semitones octave up down',
  filter: 'lpf low pass high pass hpf cutoff resonance eq tone muffle',
  djfilter: 'filter sweep dj low high one knob',
  space: 'reverb delay room echo ambience wet',
  level: 'volume gain pan loudness mix quiet loud',
  drive: 'distortion saturation crush bitcrush overdrive dirt',
  phaser: 'modulation swirl sweep jet',
  chorus: 'modulation chorus ensemble thick thicken wide width doubler detune lush pad lfo',
  flanger: 'modulation flange flanging jet whoosh sweep comb metallic feedback lfo',
  tremolo: 'modulation volume pulse lfo wobble',
  vowel: 'formant voice talk mouth',
  lofi: 'coarse bitcrush downsample grit crush retro',
  eq3: 'eq equalizer equaliser three band 3 bass low mid high boost cut tone mixing',
  saturator: 'saturation distortion warm tape tube harmonics drive grit bass mixing',
  clipper: 'clip clipping limiter loud ceiling hard peaks mastering bass mixing',
  limiter: 'limiter limit brickwall maximizer maximiser loud loudness ceiling peaks master mastering true peak lufs mixing',
  compressor: 'compression comp dynamics glue squash level even punch bass mixing',
  punch: 'transient shaper attack snap punch tail sustain drums',
  bus: 'mixer bus track insert group submix route send null merge combine channel fader sum',
  haas: 'stereo wide width delay precedence double doubler spread left right ms',
  widener: 'stereo wide width imager spread mid side ms mono bass imaging',
  utility: 'utility tool gain trim volume db mono width balance pan swap left right channel phase polarity invert flip mixing',
  fxrack: 'effects chain multiple fx rack bus insert',
  reverb: 'reverb verb room hall plate space tail ambience wet size',
  delay: 'delay echo ping pong repeat feedback tape dotted eighth sync',
  sidechain: 'duck ducking pump pumping compression compressor side chain kick bass edm',
  stack: 'layer mix together combine sum',
  sequence: 'cat order alternate chain one after another',
  arrange: 'song structure sections order bars intro verse',
  output: 'master out hear speakers main',
}

function paletteItems() {
  const nodes = Object.entries(NODE_TYPES).map(([type, s]) => ({
    id: `node:${type}`, kind: 'node', key: type, group: s.group, label: s.label, blurb: s.blurb,
    words: `${type} ${s.group} ${SEARCH_WORDS[type] ?? ''}`,
  }))
  const instruments = INSTRUMENTS.map((inst) => ({
    id: `instrument:${inst.key}`, kind: 'instrument', key: inst.key, group: 'instruments', label: inst.label,
    blurb: inst.kind === 'code' ? 'a pattern with a line of code' : `a pattern with a ${inst.kind === 'drum' ? 'drum' : 'synth'} (${inst.patch.sound})`,
    words: `instrument ${inst.kind} ${inst.patch.sound ?? ''} pattern`,
  }))
  return [...nodes, ...instruments]
}

/** How well an item matches a search: higher is better, 0 is no match. Every word must hit. */
function matchScore(item, tokens) {
  let score = 0
  const label = item.label.toLowerCase()
  const hay = `${label} ${item.blurb} ${item.words}`.toLowerCase()
  for (const t of tokens) {
    if (label.startsWith(t)) score += 30
    else if (label.includes(t)) score += 20
    else if (item.words.toLowerCase().split(/\s+/).some((w) => w.startsWith(t))) score += 10
    else if (hay.includes(t)) score += 4
    else return 0
  }
  return score
}

const PAL_GROUPS = [['recent', 'recent'], ...GROUPS, ['instruments', 'instruments']]
const PAL_MIN = 150
const PAL_MAX = 460

function readPalPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writePalPref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/**
 * The add pane: every node and instrument, searchable. Drag its right edge to resize,
 * collapse it to a rail, fold groups away. Type to search (press / to jump to the box),
 * arrow keys move through results, Enter adds.
 */
function Palette({ onAdd }) {
  const items = useMemo(() => paletteItems(), [])
  const [width, setWidth] = useState(() => Math.min(PAL_MAX, Math.max(PAL_MIN, readPalPref('strudel:palette:width', 200))))
  const [collapsed, setCollapsed] = useState(() => readPalPref('strudel:palette:collapsed', false))
  const [closed, setClosed] = useState(() => new Set(readPalPref('strudel:palette:closed', [])))
  const [recent, setRecent] = useState(() => readPalPref('strudel:palette:recent', []))
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const searchRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => writePalPref('strudel:palette:width', width), [width])
  useEffect(() => writePalPref('strudel:palette:collapsed', collapsed), [collapsed])
  useEffect(() => writePalPref('strudel:palette:closed', [...closed]), [closed])
  useEffect(() => writePalPref('strudel:palette:recent', recent), [recent])

  // "/" jumps to the search box from anywhere that isn't a text field
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      setCollapsed(false)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = tokens.length
    ? items.map((it) => ({ it, score: matchScore(it, tokens) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).map((r) => r.it)
    : null
  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.pal-item.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const add = (item) => {
    if (item.kind === 'instrument') onAdd('pattern', null, item.key)
    else onAdd(item.key)
    setRecent((r) => [item.id, ...r.filter((x) => x !== item.id)].slice(0, 6))
  }

  const wide = width >= 230
  const Item = ({ item, index }) => (
    <button
      className={`pal-item pal-${item.group} ${index === cursor && results ? 'cursor' : ''}`}
      draggable
      title={item.blurb}
      onDragStart={(e) => {
        if (item.kind === 'instrument') e.dataTransfer.setData(INSTRUMENT_MIME, item.key)
        else e.dataTransfer.setData(NODE_MIME, item.key)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => add(item)}
    >
      <span className="pal-item-label">{item.label}</span>
      {wide && <span className="pal-item-blurb">{item.blurb}</span>}
    </button>
  )

  const startResize = (e) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    const move = (ev) => setWidth(Math.min(PAL_MAX, Math.max(PAL_MIN, w0 + ev.clientX - x0)))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing-x') }
    document.body.classList.add('resizing-x')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (collapsed) {
    return (
      <aside className="palette graph-palette collapsed" aria-label="Add nodes">
        <button className="pal-rail" onClick={() => setCollapsed(false)} title="Open the add pane (/ to search)" aria-expanded="false">
          <span>add</span>
        </button>
      </aside>
    )
  }

  const byGroup = (group) => (group === 'recent'
    ? recent.map((id) => items.find((it) => it.id === id)).filter(Boolean)
    : items.filter((it) => it.group === group).sort((a, b) => (b.key === 'fxrack') - (a.key === 'fxrack')))

  return (
    <aside className={`palette graph-palette ${wide ? 'wide' : ''}`} aria-label="Add nodes" style={{ width }}>
      <div className="pal-head">
        <span className="palette-title">add</span>
        <button className="node-btn" onClick={() => setCollapsed(true)} title="Collapse the pane" aria-label="Collapse the add pane">«</button>
      </div>
      <div className="pal-search">
        <input
          ref={searchRef}
          className="node-input"
          type="search"
          placeholder="search  ( / )"
          value={query}
          aria-label="Search nodes and instruments"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!results) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
            else if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); add(results[cursor]) }
            else if (e.key === 'Escape') { e.preventDefault(); setQuery('') }
            e.stopPropagation()
          }}
        />
      </div>
      <div className="pal-list" ref={listRef}>
        {results ? (
          <>
            <span className="pal-count" aria-live="polite">{results.length ? `${results.length} match${results.length === 1 ? '' : 'es'} · enter adds the highlighted one` : `nothing matches “${query}”`}</span>
            {results.map((item, index) => <Item key={item.id} item={item} index={index} />)}
          </>
        ) : (
          PAL_GROUPS.map(([group, label]) => {
            const list = byGroup(group)
            if (!list.length) return null
            const open = !closed.has(group)
            return (
              <section key={group} className="pal-group">
                <button
                  className="pal-group-head"
                  aria-expanded={open}
                  onClick={() => setClosed((s) => { const next = new Set(s); next.has(group) ? next.delete(group) : next.add(group); return next })}
                >
                  <span className="pal-caret" aria-hidden>{open ? '−' : '+'}</span>
                  <span className="pal-label">{label}</span>
                  <span className="pal-n">{list.length}</span>
                </button>
                {open && list.map((item) => <Item key={item.id} item={item} index={-1} />)}
              </section>
            )
          })
        )}
      </div>
      <div
        className="pal-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the add pane"
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => setCollapsed(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setWidth((w) => Math.min(PAL_MAX, w + 20))
          if (e.key === 'ArrowLeft') setWidth((w) => Math.max(PAL_MIN, w - 20))
        }}
        title="Drag to resize · double-click to collapse"
      />
    </aside>
  )
}

function Canvas({ project, onUpdateProject, started, solo, onSolo, transport }) {
  const flow = useReactFlow()
  const wrapRef = useRef(null)
  const dock = useRollDock() // the pattern's rack and notes live along the bottom
  // frame the whole patch once the nodes have been measured (fitting earlier zooms to max)
  const initialized = useNodesInitialized()
  // what feeds what, so a hit anywhere lights its way to the output (flow.js)
  const litPaths = useMemo(() => flowPaths(project, {
    sourceTypes: SOURCE_TYPES,
    splitOf: (nodeId) => new Set(Object.entries(project.nodes.find((n) => n.id === nodeId)?.data?.offMain ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k)),
  }), [project])
  // what colour each source glows: the one its clips wear on the timeline
  const litColors = useMemo(() => {
    const map = new Map()
    for (const n of project.nodes) {
      if (!SOURCE_TYPES.has(n.type)) continue
      const rgb = rgbOf(colorFor(nodeSrc(n, project), project.song?.colors))
      for (const k of litPaths.nodes.get(n.id) ?? []) map.set(k, rgb)
    }
    return map
  }, [project, litPaths])
  useEffect(() => setFlowPaths(litPaths, litColors), [litPaths, litColors])
  const [lighting, setLighting] = useState(flowWanted)
  useEffect(() => {
    if (!started || !lighting) return undefined
    const sch = () => transport?.scheduler
    startFlow({ pattern: () => sch()?.pattern, now: () => sch()?.now?.(), cps: () => sch()?.cps })
    return stopFlow
  }, [started, lighting, transport])
  const fitted = useRef(false)
  useEffect(() => {
    if (!initialized || fitted.current) return
    fitted.current = true
    requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1 }))
  }, [initialized, flow])
  const [picking, setPicking] = useState(null) // { nodeId, key, x, y }
  const [menu, setMenu] = useState(null) // right-click add menu: { x, y, at (flow position), wire (edge id or null) }
  const menuItems = useMemo(() => paletteItems(), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const pointerRef = useRef(null) // last pointer position over the canvas, for shift + A

  // Shift + A (as in Blender): the add menu at the pointer, ready to search
  useEffect(() => {
    const onMove = (e) => { pointerRef.current = { x: e.clientX, y: e.clientY } }
    const onKey = (e) => {
      if (e.code !== 'KeyA' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"], dialog, .pattern-pop, .add-menu')) return
      const canvas = wrapRef.current?.querySelector('.react-flow')
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      const p = pointerRef.current
      const inside = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
      const x = inside ? p.x : r.left + r.width / 2
      const y = inside ? p.y : r.top + r.height / 2
      e.preventDefault()
      setMenu({ x, y, at: flow.screenToFlowPosition({ x: x - 20, y: y - 20 }), wire: null })
    }
    const el = wrapRef.current
    el?.addEventListener('pointermove', onMove)
    // a wire's + button: the add menu there, adding into that wire, the new node centred on it
    const onWirePlus = (e) => {
      const { edgeId, x, y } = e.detail
      setMenu({ x: x + 14, y: y - 14, at: flow.screenToFlowPosition({ x: x - 100, y: y - 40 }), wire: edgeId })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(ADD_INTO_WIRE, onWirePlus)
    return () => { el?.removeEventListener('pointermove', onMove); window.removeEventListener('keydown', onKey); window.removeEventListener(ADD_INTO_WIRE, onWirePlus) }
  }, [flow])

  // React Flow keeps its own copy for dragging and selection; the project stays the source.
  // Existing nodes keep their object (and so their measured size): a fresh object makes
  // React Flow treat the node as unmeasured and hide it for a frame, which blanks the
  // canvas on every knob turn. Only a moved position makes a new object.
  const toRf = useCallback((prev) => {
    const old = new Map(prev.map((n) => [n.id, n]))
    return project.nodes.map((n) => {
      const was = old.get(n.id)
      // no dragHandle: grab a node anywhere; its controls opt out with the nodrag class
      if (!was) return { id: n.id, type: 'studio', position: { x: n.x, y: n.y }, data: {}, selected: false }
      if (was.dragging || (was.position.x === n.x && was.position.y === n.y)) return was
      return { ...was, position: { x: n.x, y: n.y } }
    })
  }, [project.nodes])
  const [nodes, setNodes] = useState(() => toRf([]))
  const selectNext = useRef(null) // a node just added from the pane becomes the selection
  useEffect(() => setNodes((prev) => {
    const next = toRf(prev)
    const pick = selectNext.current == null ? null : new Set([].concat(selectNext.current)) // an id, or ids (a paste)
    if (!pick || !next.some((n) => pick.has(n.id))) return next
    selectNext.current = null
    return next.map((n) => (n.selected === pick.has(n.id) ? n : { ...n, selected: pick.has(n.id) }))
  }), [toRf])
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const [spliceTarget, setSpliceTarget] = useState(null) // wire a dragged node would drop into
  const [detaching, setDetaching] = useState(null) // wire being pulled off its input (for its look)
  const detachRef = useRef(null) // the same, for the drop handler, which must not read stale state
  const spliceRef = useRef(null)
  const rfEdges = useMemo(() => project.edges.map((e) => ({
    ...e,
    type: 'wire', // with a + in the middle to add a node into it
    sourceHandle: e.sourceHandle ?? 'out',
    animated: started,
    className: e.id === spliceTarget ? 'splice-target' : e.id === detaching ? 'detaching' : '',
    domAttributes: { 'data-touches': `${e.source} ${e.target}` },
  })), [project.edges, started, spliceTarget, detaching])
  const [edges, setEdges] = useState(rfEdges)
  useEffect(() => setEdges((prev) => {
    const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id))
    return rfEdges.map((e) => ({ ...e, selected: sel.has(e.id) }))
  }), [rfEdges])

  const updateNode = useCallback((id, fn) => onUpdateProject((p) => {
    const n = p.nodes.find((x) => x.id === id)
    if (n) fn(n.data, n)
  }), [onUpdateProject])

  const removeNodes = useCallback((ids) => {
    const gone = new Set(ids)
    onUpdateProject((p) => {
      // Taking a node out of a line keeps the line: whatever fed it now feeds what it fed.
      // Only for a node with a single wire in (through any other removed nodes in a row);
      // a node mixing several inputs has no one thing to pass on, so its wires just go.
      const feed = (id, seen = new Set()) => {
        if (seen.has(id)) return null
        seen.add(id)
        const ins = p.edges.filter((e) => e.target === id)
        if (ins.length !== 1) return null
        return gone.has(ins[0].source) ? feed(ins[0].source, seen) : ins[0].source
      }
      const bridges = p.edges
        .filter((e) => gone.has(e.source) && !gone.has(e.target))
        .map((e) => { const from = feed(e.source); return { source: from, sourceHandle: p.edges.find((x) => x.source === from && gone.has(x.target))?.sourceHandle, target: e.target, targetHandle: e.targetHandle } })
        .filter((b) => b.source)
      p.nodes = p.nodes.filter((n) => !gone.has(n.id))
      p.edges = p.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))
      for (const b of bridges) {
        const taken = p.edges.some((e) => e.target === b.target && e.targetHandle === b.targetHandle)
        if (!taken && !makesCycle(p.edges, b.source, b.target)) p.edges.push(b)
      }
    })
    if (gone.has(solo)) onSolo(null)
  }, [onUpdateProject, solo, onSolo])

  const addNode = useCallback((type, position, instrument, intoWire = null) => {
    const id = `${type}${newId().slice(-5)}`
    const rect = wrapRef.current?.getBoundingClientRect()
    let at = position
    if (!at) {
      // middle of the view, stepping down-right past any node already sitting there
      at = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2 - 110, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 60 })
      const taken = (p) => project.nodes.some((n) => Math.abs(n.x - p.x) < 120 && Math.abs(n.y - p.y) < 80)
      for (let i = 0; i < 20 && taken(at); i++) at = { x: at.x + 40, y: at.y + 60 }
    }
    // Clicked in the pane (not dropped somewhere): wire it up so it's heard straight away.
    // A sound goes into the output; an effect or transform goes after the selected node,
    // taking over that node's wires, so clicking effects one by one builds a chain.
    const clicked = !position && !intoWire
    const selectedIds = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    const after = clicked && selectedIds.length === 1 && splicable(type) ? project.nodes.find((n) => n.id === selectedIds[0] && n.type !== 'output') : null
    const output = project.nodes.find((n) => n.type === 'output')
    if (after) at = { x: after.x + 300, y: after.y }
    else if (clicked && output && NODE_TYPES[type]?.group === 'source') {
      // left of the output, below the sounds already going into it
      const feeding = project.edges.filter((e) => e.target === output.id).map((e) => project.nodes.find((n) => n.id === e.source)).filter(Boolean)
      at = { x: Math.min(output.x - 360, ...feeding.map((n) => n.x)), y: feeding.length ? Math.max(...feeding.map((n) => n.y)) + 230 : output.y }
    }
    onUpdateProject((p) => {
      const data = defaultData(type)
      if (type === 'pattern') {
        const pattern = makePattern(`pattern ${p.patterns.length + 1}`)
        if (instrument) { pattern.channels.push(instrumentChannel(instrument, pattern)); pattern.name = instrument }
        p.patterns.push(pattern)
        data.patternId = pattern.id
      }
      p.nodes.push({ id, type, x: Math.round(at.x), y: Math.round(at.y), data })
      if (intoWire) spliceInto(p, intoWire, id)
      if (after) {
        for (const e of p.edges) if (e.source === after.id) e.source = id
        p.edges.push({ source: after.id, target: id, targetHandle: firstInput(type) })
        // move whatever sat to the right of it along, so the chain reads left to right
        for (const n of p.nodes) if (n.id !== id && n.id !== after.id && n.x > after.x && Math.abs(n.y - after.y) < 160) n.x += 300
      } else if (clicked && NODE_TYPES[type]?.group === 'source') {
        const out = p.nodes.find((n) => n.type === 'output')
        if (out) {
          const used = p.edges.filter((e) => e.target === out.id).map((e) => Number(/^in-(\d+)$/.exec(e.targetHandle)?.[1] ?? -1))
          p.edges.push({ source: id, target: out.id, targetHandle: `in-${Math.max(-1, ...used) + 1}` })
        }
      }
    })
    if (clicked) selectNext.current = id
    return id
  }, [flow, onUpdateProject, project.nodes])

  // nodes with a path of wires to an output: everything else is silent
  const heard = useMemo(() => {
    const set = new Set(project.nodes.filter((n) => n.type === 'output').map((n) => n.id))
    for (let grew = true; grew;) {
      grew = false
      for (const e of project.edges) if (set.has(e.target) && !set.has(e.source)) { set.add(e.source); grew = true }
    }
    return set
  }, [project.nodes, project.edges])

  // Copy and paste nodes: ctrl/cmd + C, X, V, and D to duplicate. A paste lands at the
  // pointer (or just below the copied nodes), keeps the wires between the pasted nodes,
  // selects what it pasted, and is one undo. Copies work across tracks.
  const projectRef = useRef(project)
  projectRef.current = project
  const lastPaste = useRef(null)
  const pasteClip = useCallback((clip, at) => {
    let ids = []
    onUpdateProject((p) => { ids = pasteNodes(p, clip, at) })
    selectNext.current = ids
  }, [onUpdateProject])
  const pasteAt = useCallback((clip) => {
    const canvas = wrapRef.current?.querySelector('.react-flow')
    const r = canvas?.getBoundingClientRect()
    const ptr = pointerRef.current
    let at = r && ptr && ptr.x >= r.left && ptr.x <= r.right && ptr.y >= r.top && ptr.y <= r.bottom
      ? flow.screenToFlowPosition({ x: ptr.x - 20, y: ptr.y - 20 })
      : { x: (clip.origin?.x ?? 0) + 40, y: (clip.origin?.y ?? 0) + 60 }
    // pasting again without moving the pointer steps down-right instead of stacking exactly
    const last = lastPaste.current
    if (last && Math.abs(last.from.x - at.x) < 1 && Math.abs(last.from.y - at.y) < 1) at = { x: last.at.x + 40, y: last.at.y + 40 }
    lastPaste.current = { from: last && Math.abs(last.from.x - at.x) < 41 ? last.from : at, at }
    pasteClip(clip, at)
  }, [flow, pasteClip])
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (!['c', 'x', 'v', 'd', 'g'].includes(key)) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"], .pattern-pop, .add-menu')) return
      if (key === 'c' && window.getSelection()?.toString()) return // copying text on the page
      const selected = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (key === 'g') {
        e.preventDefault() // (the browser's find-next otherwise)
        let rack = null
        onUpdateProject((p) => { rack = groupIntoRack(p, selected) })
        if (rack) { selectNext.current = rack; if (selected.includes(solo)) onSolo(null) }
        return
      }
      if (key === 'v') {
        const clip = readClipboard()
        if (!clip) return
        e.preventDefault()
        pasteAt(clip)
        return
      }
      const clip = copyNodes(projectRef.current, selected)
      if (!clip) return
      e.preventDefault()
      if (key === 'd') return pasteClip(clip, { x: clip.origin.x + 40, y: clip.origin.y + 60 })
      writeClipboard(clip)
      lastPaste.current = null
      if (key === 'x') removeNodes(clip.nodes.map((n) => n.id))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pasteAt, pasteClip, removeNodes, onUpdateProject, solo, onSolo])

  const ctx = useMemo(() => ({
    project,
    heard,
    solo,
    setSolo: onSolo,
    updateNode,
    removeNode: (id) => removeNodes([id]),
    editPattern: (patternId) => dock?.open(patternId, null, 'rack'),
    pickSound: (nodeId, key, at) => setPicking({ nodeId, key, ...at }),
    newPatternFor: (nodeId) => {
      const patternId = newId()
      onUpdateProject((p) => {
        p.patterns.push(makePattern(`pattern ${p.patterns.length + 1}`, { id: patternId }))
        const n = p.nodes.find((x) => x.id === nodeId)
        if (n) n.data.patternId = patternId
      })
      dock?.open(patternId, null, 'rack')
    },
  }), [project, heard, solo, onSolo, updateNode, removeNodes, onUpdateProject])

  const isValidConnection = useCallback((c) => {
    if (c.source === c.target) return false
    const target = project.nodes.find((n) => n.id === c.target)
    if (!target || !NODE_TYPES[target.type]?.inputs) return false
    return !makesCycle(project.edges, c.source, c.target)
  }, [project])

  const onConnect = useCallback((c) => {
    detachRef.current = null // a pulled wire that lands on an output is rewired, not deleted
    setDetaching(null)
    onUpdateProject((p) => {
      const target = p.nodes.find((n) => n.id === c.target)
      const handle = NODE_TYPES[target?.type]?.inputs === 1 ? 'in' : c.targetHandle
      p.edges = p.edges.filter((e) => !(e.target === c.target && e.targetHandle === handle)) // an input takes one wire; the new one wins
      p.edges.push({ source: c.source, sourceHandle: c.sourceHandle ?? 'out', target: c.target, targetHandle: handle })
    })
  }, [onUpdateProject])

  const selected = project.nodes.find((n) => nodes.find((r) => r.id === n.id && r.selected))

  // Select a pattern node holding one instrument and the keyboard plays it, without having
  // to open the dock first. With more than one there's nothing to say which you meant, and
  // the dock's own keyboard wins whenever it's open, so a key can never play twice.
  const lone = selected?.type === 'pattern' && !dock?.at
    ? project.patterns.find((p) => p.id === selected.data.patternId)
    : null
  const loneChannel = lone?.channels.length === 1 && lone.channels[0].kind !== 'code' ? lone.channels[0] : null
  const [octave, setOctave] = useState(() => readOctave())
  useTypingKeys({
    enabled: !!loneChannel,
    project,
    pattern: lone,
    channel: loneChannel,
    octave,
    onOctave: (next) => { setOctave(next); writeOctave(next) },
  })
  const soundNode = picking && project.nodes.find((n) => n.id === picking.nodeId)

  return (
    <Ctx.Provider value={ctx}>
      <div className="graph" ref={wrapRef}>
        <Palette onAdd={(type, pos, instrument) => addNode(type, pos, instrument)} />
        <div
          className={`graph-canvas ${lighting ? '' : 'flow-off'}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(NODE_MIME) && !e.dataTransfer.types.includes(INSTRUMENT_MIME)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            // the node type isn't readable during dragover, so any node lights wires; the drop decides
            if (e.dataTransfer.types.includes(NODE_MIME)) {
              const r = 14
              const wire = wireAt({ left: e.clientX - r, right: e.clientX + r, top: e.clientY - r, bottom: e.clientY + r })
              if (wire !== spliceTarget) setSpliceTarget(wire)
            }
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setSpliceTarget(null) }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData(NODE_MIME)
            const instrument = e.dataTransfer.getData(INSTRUMENT_MIME)
            if (!type && !instrument) return
            e.preventDefault()
            setSpliceTarget(null)
            const at = flow.screenToFlowPosition({ x: e.clientX - 20, y: e.clientY - 20 })
            const r = 14
            const wire = type && splicable(type) ? wireAt({ left: e.clientX - r, right: e.clientX + r, top: e.clientY - r, bottom: e.clientY + r }) : null
            addNode(type || 'pattern', at, instrument || null, wire)
          }}
        >
          <button
            type="button"
            className={`flow-toggle nodrag ${lighting ? 'on' : ''}`}
            aria-pressed={lighting}
            title={lighting ? 'Stop lighting the patch as it plays' : 'Light the patch as it plays'}
            onClick={() => setLighting((was) => {
              try { localStorage.setItem(FLOW_KEY, was ? 'off' : 'on') } catch { /* storage unavailable */ }
              return !was
            })}
          >
            <span className="flow-dot" aria-hidden />
            flow
          </button>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            onPaneContextMenu={(e) => {
              // right-click empty canvas: add something here (into the wire under the pointer, if any)
              e.preventDefault()
              const r = 10
              const wire = wireAt({ left: e.clientX - r, right: e.clientX + r, top: e.clientY - r, bottom: e.clientY + r })
              setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX - 20, y: e.clientY - 20 }), wire })
            }}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX - 20, y: e.clientY - 20 }), wire: edge.id })
            }}
            onNodeDoubleClick={(e, n) => {
              // double-click a pattern node (not its controls) to open its rack
              const node = project.nodes.find((x) => x.id === n.id)
              if (node?.type !== 'pattern' || e.target.closest('input, select, textarea, button')) return
              if (project.patterns.some((p) => p.id === node.data.patternId)) ctx.editPattern(node.data.patternId, e)
              else ctx.newPatternFor(node.id)
            }}
            onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns))}
            onEdgesChange={(changes) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), es))}
            onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
              // one handler for both: the wires React Flow deletes along with nodes must still be
              // there when removeNodes bridges the line around them
              const gone = new Set(deletedNodes.map((n) => n.id))
              const wires = new Set(deletedEdges.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => e.id))
              if (wires.size) onUpdateProject((p) => { p.edges = p.edges.filter((e) => !wires.has(e.id)) })
              if (gone.size) removeNodes([...gone])
            }}
            onNodeDrag={(_, node, dragged) => {
              // a lone, unwired node that has an input and an output can drop into a wire, and so
              // can a selected group wired up as a chain (one way in, one way out, nothing outside)
              const ids = dragged.map((d) => d.id)
              const model = project.nodes.find((n) => n.id === node.id)
              const wired = project.edges.some((e) => e.source === node.id || e.target === node.id)
              const ok = dragged.length === 1 ? model && splicable(model.type) && !wired : !!chainOf(project, ids)
              if (!ok) {
                if (spliceRef.current) { spliceRef.current = null; setSpliceTarget(null) }
                return
              }
              const el = document.querySelector(`.graph-canvas .react-flow__node[data-id="${node.id}"]`)
              const wire = el ? wireAt(el.getBoundingClientRect(), ids) : null
              if (wire !== spliceRef.current) { spliceRef.current = wire; setSpliceTarget(wire) }
            }}
            onNodeDragStop={(_, __, dragged) => {
              const into = spliceRef.current
              spliceRef.current = null
              setSpliceTarget(null)
              onUpdateProject((p) => {
                for (const d of dragged) {
                  const n = p.nodes.find((x) => x.id === d.id)
                  if (n) { n.x = Math.round(d.position.x); n.y = Math.round(d.position.y) }
                }
                if (into && dragged.length === 1) spliceInto(p, into, dragged[0].id)
                const chain = into && dragged.length > 1 && chainOf(p, dragged.map((d) => d.id))
                if (chain) spliceChain(p, into, chain)
              })
            }}
            onConnectStart={(_, { nodeId, handleId, handleType }) => {
              // grabbing a connected input pulls its wire off
              if (handleType !== 'target') return
              const wire = project.edges.find((e) => e.target === nodeId && e.targetHandle === (handleId ?? 'in'))
              detachRef.current = wire?.id ?? null
              setDetaching(detachRef.current)
            }}
            onConnectEnd={() => {
              const wire = detachRef.current
              detachRef.current = null
              setDetaching(null)
              // dropped anywhere but an output: the pulled wire goes away (a successful onConnect already replaced it)
              if (wire) onUpdateProject((p) => { p.edges = p.edges.filter((e) => e.id !== wire) })
            }}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            deleteKeyCode={['Backspace', 'Delete']}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            minZoom={0.2}
            maxZoom={2}
            edgeTypes={EDGE_TYPES}
            defaultEdgeOptions={{ type: 'wire' }}
          >
            <Background gap={24} size={1.2} color="#34342f" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ({ source: '#e4ff1a', output: '#e4ff1a', transform: '#f2f0e6', effect: '#a3a39a', mixing: '#a3a39a', combine: '#6b6b63' })[NODE_TYPES[project.nodes.find((x) => x.id === n.id)?.type]?.group] ?? '#555'} maskColor="rgba(0,0,0,0.6)" />
          </ReactFlow>
          <div className="graph-tip" aria-live="polite">
            {solo
              ? <>auditioning <b>{nodeTitle(project.nodes.find((n) => n.id === solo), project)}</b> · <button className="linkish" onClick={() => onSolo(null)}>back to the output</button></>
              : selected ? <>{NODE_TYPES[selected.type]?.blurb}{selected.type !== 'output' && <> · click an effect in the pane to chain it after this</>}</>
              : project.nodes.length === 1 && project.nodes[0].type === 'output'
                ? <>empty patch · click a sound in the pane (<b>pattern</b>, <b>rhythm</b>, <b>melody</b>) and it wires itself into the output · with it selected, click effects to chain them after it</>
                : 'double-click a pattern to open its rack · wire: drag right dot → left dot · pull a wire off an input to remove it · drop a node on a wire to insert it'}
          </div>
        </div>
      </div>
      {menu && (
        <AddMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          groups={PAL_GROUPS}
          score={matchScore}
          intoWire={!!menu.wire}
          onPick={(item) => {
            if (item.kind === 'instrument') return addNode('pattern', menu.at, item.key)
            const into = menu.wire && splicable(item.key) ? project.edges.find((e) => e.id === menu.wire) : null
            const src = into && project.nodes.find((n) => n.id === into.source)
            const dst = into && project.nodes.find((n) => n.id === into.target)
            if (!src || !dst) return addNode(item.key, menu.at, null, null)
            // into a wire: the new node sits between its two ends; when they're too close, the far
            // end and what's right of it in that row move over a column (and anything they'd land on)
            const room = dst.x - src.x >= 560
            if (!room) {
              onUpdateProject((p) => {
                const moved = new Set(p.nodes.filter((n) => n.id !== src.id && n.x >= dst.x - 20 && Math.abs(n.y - dst.y) < 160).map((n) => n.id))
                for (let pass = 0; pass < 6; pass++) {
                  const hit = p.nodes.filter((n) => !moved.has(n.id) && n.id !== src.id && p.nodes.some((m) => moved.has(m.id) && Math.abs(m.x + 300 - n.x) < 270 && Math.abs(m.y - n.y) < 160))
                  if (!hit.length) break
                  hit.forEach((n) => moved.add(n.id))
                }
                for (const n of p.nodes) if (moved.has(n.id)) n.x += 300
              })
            }
            addNode(item.key, room ? { x: (src.x + dst.x) / 2, y: (src.y + dst.y) / 2 } : { x: src.x + 300, y: src.y }, null, into.id)
          }}
          onClose={closeMenu}
        />
      )}
      {soundNode && (
        <SoundPicker
          kind="synth"
          sound={soundNode.data[picking.key]}
          anchor={picking}
          onPick={({ sound }) => updateNode(soundNode.id, (d) => { d[picking.key] = sound })}
          onClose={() => setPicking(null)}
        />
      )}
    </Ctx.Provider>
  )
}

/** The patch: nodes wired from sources, through transforms and effects, to the output. */
export default function Graph(props) {
  return (
    <section className="graph-view" aria-label="Patch">
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </section>
  )
}
