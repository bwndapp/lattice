import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, applyEdgeChanges, useNodesInitialized, useReactFlow, useUpdateNodeInternals,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { APPLY, FX_UNITS, GROUPS, NODE_TYPES, defaultData, inputsOf, makeFxUnit, makesCycle } from './graph'
import { INSTRUMENTS, INSTRUMENT_MIME, instrumentChannel, makePattern, newId } from './project'
import Knob from './Knob.jsx'
import SoundPicker from './SoundPicker.jsx'
import PatternEditor from './PatternEditor.jsx'
import { onSoundsChange, previewSound, soundCatalog } from './audio'

const NODE_MIME = 'application/x-strudel-node'
const Ctx = createContext(null)

const slotNum = (h) => Number(/^in-(\d+)$/.exec(h ?? '')?.[1] ?? -1)

/** Can this kind of node be dropped into the middle of a wire? It needs an input and an output. */
const splicable = (type) => !!NODE_TYPES[type]?.inputs && type !== 'output'
const firstInput = (type) => (NODE_TYPES[type]?.inputs === 1 ? 'in' : 'in-0')

/**
 * The wire under a screen rectangle (or near a point), found by sampling each rendered
 * edge path. `skip` leaves out wires touching a node.
 */
function wireAt(box, skip = null) {
  for (const el of document.querySelectorAll('.graph-canvas .react-flow__edge')) {
    const id = el.getAttribute('data-id') ?? el.dataset.id
    if (!id || (skip && el.dataset.touches?.split(' ').includes(skip))) continue
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
  p.edges.push({ source: wire.source, target: nodeId, targetHandle: firstInput(node.type) })
  p.edges.push({ source: nodeId, target: wire.target, targetHandle: wire.targetHandle })
  return true
}

/** What a node is called on wires and in lists. */
function nodeTitle(node, project) {
  if (!node) return '?'
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
function KitSelect({ node, param, value: given, onChange }) {
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
function Param({ node, param, value: given, onChange }) {
  const ctx = useContext(Ctx)
  const value = given !== undefined ? given : node.data[param.key]
  const set = onChange ?? ((v) => ctx.updateNode(node.id, (d) => { d[param.key] = v }))
  switch (param.type) {
    case 'kit':
      return <KitSelect node={node} param={param} value={value} onChange={set} />
    case 'knob':
      return <div className="nodrag nowheel"><Knob def={param} value={value} onChange={set} /></div>
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
  const chain = node.data.chain ?? []
  const edit = (fn) => ctx.updateNode(node.id, (d) => { d.chain = d.chain ?? []; fn(d.chain) })
  const at = (list, unitId) => list.findIndex((u) => u.id === unitId)
  return (
    <div className="fx-rack">
      <span className="fx-io">in</span>
      {chain.length === 0 && <p className="node-hint fx-empty">No effects yet. Add some below; the sound runs through them top to bottom.</p>}
      <ol className="fx-units">
        {chain.map((unit, i) => {
          const spec = NODE_TYPES[unit.type]
          return (
            <li key={unit.id} className={`fx-unit ${unit.on ? '' : 'bypassed'}`}>
              <div className="fx-unit-head">
                <span className="fx-order" aria-hidden>{i + 1}</span>
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
  const slotKey = wires.map((w) => w.targetHandle).join(',')
  useEffect(() => { updateInternals(id) }, [id, slotKey, updateInternals])
  if (!node || !spec) return null

  const multi = spec.inputs === 'many'
  const nextSlot = `in-${wires.reduce((m, w) => Math.max(m, slotNum(w.targetHandle)), -1) + 1}`
  const soloing = ctx.solo === id
  const pattern = node.type === 'pattern' && ctx.project.patterns.find((p) => p.id === node.data.patternId)

  return (
    <div className={`gnode g-${spec.group} t-${node.type} ${selected ? 'selected' : ''} ${soloing ? 'soloing' : ''}`}>
      {spec.inputs === 1 && <Handle type="target" position={Position.Left} id="in" className="port in" />}
      <div className="node-head">
        <span className="node-kind">{spec.label}</span>
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
              <div className="node-chans">
                {pattern.channels.length
                  ? pattern.channels.map((c) => <span key={c.id} className={`node-chan ${c.mute ? 'muted' : ''}`}>{c.name}</span>)
                  : <span className="node-hint">empty: add instruments</span>}
              </div>
            )}
            <div className="node-actions nodrag">
              <button className="btn primary" onClick={(e) => ctx.editPattern(node.data.patternId, e)} disabled={!pattern}>edit steps &amp; notes</button>
              <button className="btn" onClick={() => ctx.openRack(node.data.patternId)} disabled={!pattern}>rack</button>
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
                  <span className="slot-name">{wire ? nodeTitle(src, ctx.project) : 'connect'}</span>
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
                  <span className="slot-name">{nodeTitle(src, ctx.project)}</span>
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

      {node.type !== 'output' && <Handle type="source" position={Position.Right} id="out" className="port out" />}
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
  tremolo: 'modulation volume pulse lfo wobble',
  vowel: 'formant voice talk mouth',
  lofi: 'coarse bitcrush downsample grit crush retro',
  fxrack: 'effects chain multiple fx rack bus insert',
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

function Canvas({ project, onUpdateProject, started, solo, onSolo, onOpenRack, transport }) {
  const flow = useReactFlow()
  const wrapRef = useRef(null)
  const [editing, setEditing] = useState(null) // { patternId, x, y }
  // frame the whole patch once the nodes have been measured (fitting earlier zooms to max)
  const initialized = useNodesInitialized()
  const fitted = useRef(false)
  useEffect(() => {
    if (!initialized || fitted.current) return
    fitted.current = true
    requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1 }))
  }, [initialized, flow])
  const [picking, setPicking] = useState(null) // { nodeId, key, x, y }

  // React Flow keeps its own copy for dragging and selection; the project stays the source.
  // Existing nodes keep their object (and so their measured size): a fresh object makes
  // React Flow treat the node as unmeasured and hide it for a frame, which blanks the
  // canvas on every knob turn. Only a moved position makes a new object.
  const toRf = useCallback((prev) => {
    const old = new Map(prev.map((n) => [n.id, n]))
    return project.nodes.map((n) => {
      const was = old.get(n.id)
      if (!was) return { id: n.id, type: 'studio', position: { x: n.x, y: n.y }, data: {}, selected: false, dragHandle: '.node-head' }
      if (was.dragging || (was.position.x === n.x && was.position.y === n.y)) return was
      return { ...was, position: { x: n.x, y: n.y } }
    })
  }, [project.nodes])
  const [nodes, setNodes] = useState(() => toRf([]))
  useEffect(() => setNodes((prev) => toRf(prev)), [toRf])

  const [spliceTarget, setSpliceTarget] = useState(null) // wire a dragged node would drop into
  const [detaching, setDetaching] = useState(null) // wire being pulled off its input (for its look)
  const detachRef = useRef(null) // the same, for the drop handler, which must not read stale state
  const spliceRef = useRef(null)
  const rfEdges = useMemo(() => project.edges.map((e) => ({
    ...e,
    sourceHandle: 'out',
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
      p.nodes = p.nodes.filter((n) => !gone.has(n.id))
      p.edges = p.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))
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
    })
    return id
  }, [flow, onUpdateProject, project.nodes])

  const ctx = useMemo(() => ({
    project,
    solo,
    setSolo: onSolo,
    updateNode,
    removeNode: (id) => removeNodes([id]),
    editPattern: (patternId, e) => setEditing({ patternId, x: e?.clientX ?? window.innerWidth / 2, y: e?.clientY ?? 200 }),
    openRack: onOpenRack,
    pickSound: (nodeId, key, at) => setPicking({ nodeId, key, ...at }),
    newPatternFor: (nodeId) => {
      const patternId = newId()
      onUpdateProject((p) => {
        p.patterns.push(makePattern(`pattern ${p.patterns.length + 1}`, { id: patternId }))
        const n = p.nodes.find((x) => x.id === nodeId)
        if (n) n.data.patternId = patternId
      })
      setEditing({ patternId, x: window.innerWidth / 2, y: 160 })
    },
  }), [project, solo, onSolo, updateNode, removeNodes, onOpenRack, onUpdateProject])

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
      p.edges.push({ source: c.source, target: c.target, targetHandle: handle })
    })
  }, [onUpdateProject])

  const selected = project.nodes.find((n) => nodes.find((r) => r.id === n.id && r.selected))
  const soundNode = picking && project.nodes.find((n) => n.id === picking.nodeId)

  return (
    <Ctx.Provider value={ctx}>
      <div className="graph" ref={wrapRef}>
        <Palette onAdd={(type, pos, instrument) => addNode(type, pos, instrument)} />
        <div
          className="graph-canvas"
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
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns))}
            onEdgesChange={(changes) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), es))}
            onNodesDelete={(deleted) => removeNodes(deleted.map((n) => n.id))}
            onEdgesDelete={(deleted) => {
              const gone = new Set(deleted.map((e) => e.id))
              onUpdateProject((p) => { p.edges = p.edges.filter((e) => !gone.has(e.id)) })
            }}
            onNodeDrag={(_, node, dragged) => {
              // a lone, unwired node that has an input and an output can drop into a wire
              const model = project.nodes.find((n) => n.id === node.id)
              const wired = project.edges.some((e) => e.source === node.id || e.target === node.id)
              if (dragged.length !== 1 || !model || !splicable(model.type) || wired) {
                if (spliceRef.current) { spliceRef.current = null; setSpliceTarget(null) }
                return
              }
              const el = document.querySelector(`.graph-canvas .react-flow__node[data-id="${node.id}"]`)
              const wire = el ? wireAt(el.getBoundingClientRect(), node.id) : null
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
            minZoom={0.2}
            maxZoom={2}
            defaultEdgeOptions={{ type: 'default' }}
          >
            <Background gap={24} size={1.2} color="#34342f" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ({ source: '#e4ff1a', output: '#e4ff1a', transform: '#f2f0e6', effect: '#a3a39a', combine: '#6b6b63' })[NODE_TYPES[project.nodes.find((x) => x.id === n.id)?.type]?.group] ?? '#555'} maskColor="rgba(0,0,0,0.6)" />
          </ReactFlow>
          <div className="graph-tip" aria-live="polite">
            {solo
              ? <>auditioning <b>{nodeTitle(project.nodes.find((n) => n.id === solo), project)}</b> · <button className="linkish" onClick={() => onSolo(null)}>back to the output</button></>
              : selected ? NODE_TYPES[selected.type]?.blurb
              : 'wire: drag right dot → left dot · pull a wire off an input to remove it · drop a node on a wire to insert it'}
          </div>
        </div>
      </div>
      {editing && (
        <PatternEditor
          project={project}
          patternId={editing.patternId}
          anchor={editing}
          transport={transport}
          started={started}
          onUpdateProject={onUpdateProject}
          onOpenRack={() => { const id = editing.patternId; setEditing(null); onOpenRack(id) }}
          onClose={() => setEditing(null)}
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
