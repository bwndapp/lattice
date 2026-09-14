import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, applyEdgeChanges, useNodesInitialized, useReactFlow, useUpdateNodeInternals,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { APPLY, GROUPS, NODE_TYPES, defaultData, inputsOf, makesCycle } from './graph'
import { INSTRUMENT_MIME, instrumentChannel, makePattern, newId } from './project'
import { InstrumentChips } from './Rack.jsx'
import Knob from './Knob.jsx'
import SoundPicker from './SoundPicker.jsx'
import PatternEditor from './PatternEditor.jsx'
import { onSoundsChange, previewSound, soundCatalog } from './audio'

const NODE_MIME = 'application/x-strudel-node'
const Ctx = createContext(null)

const slotNum = (h) => Number(/^in-(\d+)$/.exec(h ?? '')?.[1] ?? -1)

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
function KitSelect({ node, param, onChange }) {
  const kits = useKits()
  const value = String(node.data[param.key] ?? '')
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
function Param({ node, param }) {
  const ctx = useContext(Ctx)
  const value = node.data[param.key]
  const set = (v) => ctx.updateNode(node.id, (d) => { d[param.key] = v })
  switch (param.type) {
    case 'kit':
      return <KitSelect node={node} param={param} onChange={set} />
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
    <div className={`gnode g-${spec.group} ${selected ? 'selected' : ''} ${soloing ? 'soloing' : ''}`}>
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

function Palette({ onAdd }) {
  return (
    <aside className="palette graph-palette" aria-label="Add nodes">
      <span className="palette-title">add</span>
      <span className="palette-hint">click to add, or drag onto the canvas</span>
      {GROUPS.map(([group, label]) => (
        <div key={group} className="pal-group">
          <span className="pal-label">{label}</span>
          {Object.entries(NODE_TYPES).filter(([, s]) => s.group === group).map(([type, s]) => (
            <button
              key={type}
              className={`chip pal-${group}`}
              draggable
              title={s.blurb}
              onDragStart={(e) => { e.dataTransfer.setData(NODE_MIME, type); e.dataTransfer.effectAllowed = 'copy' }}
              onClick={() => onAdd(type)}
            >{s.label}</button>
          ))}
        </div>
      ))}
      <div className="pal-group">
        <span className="pal-label">instruments</span>
        <span className="palette-hint">drop one on the canvas for a new pattern with it</span>
        <InstrumentChips className="vertical" onPick={(key) => onAdd('pattern', null, key)} />
      </div>
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
  const toRf = useCallback((prev) => {
    const old = new Map(prev.map((n) => [n.id, n]))
    return project.nodes.map((n) => {
      const was = old.get(n.id)
      const dragging = was?.dragging
      return { id: n.id, type: 'studio', position: dragging ? was.position : { x: n.x, y: n.y }, data: {}, selected: was?.selected ?? false, dragHandle: '.node-head' }
    })
  }, [project.nodes])
  const [nodes, setNodes] = useState(() => toRf([]))
  useEffect(() => setNodes((prev) => toRf(prev)), [toRf])

  const rfEdges = useMemo(() => project.edges.map((e) => ({ ...e, sourceHandle: 'out', animated: started })), [project.edges, started])
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

  const addNode = useCallback((type, position, instrument) => {
    const id = `${type}${newId().slice(-5)}`
    const rect = wrapRef.current?.getBoundingClientRect()
    const at = position ?? flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2 - 110, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 60 })
    onUpdateProject((p) => {
      const data = defaultData(type)
      if (type === 'pattern') {
        const pattern = makePattern(`pattern ${p.patterns.length + 1}`)
        if (instrument) { pattern.channels.push(instrumentChannel(instrument, pattern)); pattern.name = instrument }
        p.patterns.push(pattern)
        data.patternId = pattern.id
      }
      p.nodes.push({ id, type, x: Math.round(at.x), y: Math.round(at.y), data })
    })
    return id
  }, [flow, onUpdateProject])

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
            if (e.dataTransfer.types.includes(NODE_MIME) || e.dataTransfer.types.includes(INSTRUMENT_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
          }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData(NODE_MIME)
            const instrument = e.dataTransfer.getData(INSTRUMENT_MIME)
            if (!type && !instrument) return
            e.preventDefault()
            const at = flow.screenToFlowPosition({ x: e.clientX - 20, y: e.clientY - 20 })
            addNode(type || 'pattern', at, instrument || null)
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
            onNodeDragStop={(_, __, dragged) => onUpdateProject((p) => {
              for (const d of dragged) {
                const n = p.nodes.find((x) => x.id === d.id)
                if (n) { n.x = Math.round(d.position.x); n.y = Math.round(d.position.y) }
              }
            })}
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
              : 'drag from a node’s right dot to another node’s left dot to wire them · delete removes · scroll zooms'}
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
