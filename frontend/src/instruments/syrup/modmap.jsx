import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatValue, readoutText } from '../../Knob.jsx'
import { parseKnobValue, snapValue } from '../../knobMath.js'
import { KnobReadout, KnobTypeInput, RESET_HINT, useKnobControl } from '../../useKnobControl.jsx'
import { MAX_ROUTES, MAX_ROUTES_EACH, modColor, modName, newPartId, pruneRoutes, routeLoops, targetSpec } from './model.js'

/**
 * Mapping modulators to knobs, as Serum and Phase Plant do it: drag a modulator's handle
 * onto a knob to route it there, drag the coloured ring round a knob (or alt-drag the knob)
 * to set how far it moves it, and list or remove a knob's routes from its badge. Anything
 * that takes a drop wears `data-sy-target` (its target string).
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Can modulator `src` be routed to `target` now: a real target, no loop, not there already, room left. */
export function canRoute(patch, src, target) {
  if (!target || !targetSpec(patch, target) || routeLoops(patch, src, target)) return false
  if (patch.routes.some((r) => r.src === src && r.target === target)) return false
  return patch.routes.length < MAX_ROUTES && patch.routes.filter((r) => r.src === src).length < MAX_ROUTES_EACH
}

export function addRoute(ui, src, target, amt = 0.5) {
  ui.edit((p) => { if (canRoute(p, src, target)) p.routes.push({ id: newPartId(), src, target, amt }) })
}
export function setAmount(ui, id, amt) {
  ui.edit((p) => { const r = p.routes.find((x) => x.id === id); if (r) r.amt = Math.round(clamp(amt, -1, 1) * 1000) / 1000 })
}
export function removeRoute(ui, id) {
  ui.edit((p) => { p.routes = p.routes.filter((x) => x.id !== id); pruneRoutes(p) })
}

/**
 * Dragging a modulator's handle onto a knob. `assign` is { src, x, y, over } while it's held
 * (`over`: the target under the pointer, if it takes this modulator).
 */
export function useAssign(ui) {
  const [assign, setAssign] = useState(null)
  const held = useRef(null)
  held.current = assign
  const uiRef = useRef(ui)
  uiRef.current = ui
  const under = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-sy-target]')
    const target = el?.getAttribute('data-sy-target')
    return target && held.current && canRoute(uiRef.current.patch, held.current.src, target) ? target : null
  }
  useEffect(() => {
    if (!assign) return undefined
    const move = (e) => setAssign((a) => (a ? { ...a, x: e.clientX, y: e.clientY, over: under(e) } : a))
    const up = (e) => {
      const a = held.current
      const target = under(e)
      setAssign(null)
      if (a && target) {
        addRoute(uiRef.current, a.src, target)
        uiRef.current.setFocus(a.src)
      }
    }
    const cancel = () => setAssign(null)
    const key = (e) => { if (e.key === 'Escape') cancel() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
    }
  }, [!!assign]) // eslint-disable-line react-hooks/exhaustive-deps
  return {
    assign,
    start(e, src) {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      setAssign({ src, x: e.clientX, y: e.clientY, over: null })
    },
  }
}

/** The label that follows the pointer while assigning. */
export function AssignGhost({ ui }) {
  const a = ui.assign
  if (!a) return null
  const t = a.over && targetSpec(ui.patch, a.over)
  return createPortal(
    <div className="sy-fx-ghost sy-assign-ghost" style={{ left: a.x, top: a.y, background: modColor(ui.patch, a.src) }} aria-hidden>
      {modName(ui.patch, a.src)}
      <span>{t ? `→ ${t.label}` : 'drop on a knob'}</span>
    </div>,
    document.body,
  )
}

/** A route's amount as a knob sees it: -1 … +1, shown as ±100. */
const AMOUNT = { key: 'amt', label: 'amount', min: -1, max: 1, def: 0, unit: 'bi' }

/**
 * Turning a route's amount (useKnobControl): its ring round a knob, alt-dragging the knob,
 * or the slider in its row. Drag either way (shift: finer), scroll, double-click to type,
 * ctrl/cmd-click or Home for none. `extra` adds to the options.
 */
export function useAmountControl(ui, route, extra = null) {
  const amt = route?.amt ?? 0
  return useKnobControl({
    value: amt,
    shown: amt,
    toPos: (a) => (a + 1) / 2,
    fromPos: (p) => p * 2 - 1,
    snap: (a) => snapValue(a, AMOUNT),
    onChange: (a) => { if (route) setAmount(ui, route.id, a) },
    resetTo: 0,
    centre: 0.5,
    parse: (text) => parseKnobValue(text, AMOUNT),
    format: (a) => formatValue(a, AMOUNT),
    ...extra,
  })
}

/** A route's amount floating by whatever is turning it. */
export function AmountReadout({ control, amt = 0 }) {
  return <KnobReadout control={control} text={readoutText(control.live ?? amt, AMOUNT)} />
}

/** The coloured ring a route draws round its knob: drag it (or scroll on it) to set how far it moves the knob. */
export function AmountRing({ ui, route, d }) {
  const control = useAmountControl(ui, route)
  return (
    <>
      <path
        ref={control.ref}
        d={d}
        className="sy-ring-hit"
        onPointerEnter={control.onPointerEnter}
        onPointerLeave={control.onPointerLeave}
        onPointerDown={(e) => { e.stopPropagation(); control.onPointerDown(e) }}
        // too thin to type into: its row in the list (the badge) takes typing
        onDoubleClick={() => control.reset()}
      >
        <title>{`${modName(ui.patch, route.src)}: ${Math.round((control.live ?? route.amt) * 100)} · drag or scroll to set · double-click or ${RESET_HINT.replace(' or Home to reset', '')} for none`}</title>
      </path>
      <AmountReadout control={control} amt={route.amt} />
    </>
  )
}

/** A small floating box by `anchor` (an element), closed by a click outside or Escape. */
export function Popover({ anchor, onClose, children, className = '' }) {
  const ref = useRef(null)
  const [at, setAt] = useState(null)
  useEffect(() => {
    const r = anchor?.getBoundingClientRect()
    if (!r) return
    const w = ref.current?.offsetWidth ?? 240
    const h = ref.current?.offsetHeight ?? 200
    const left = clamp(r.left, 8, window.innerWidth - w - 8)
    const below = r.bottom + 4
    setAt({ left, top: below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below })
  }, [anchor])
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target) && !anchor?.contains(e.target)) onClose() }
    const key = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [anchor, onClose])
  return createPortal(
    <div ref={ref} className={`sy-pop ${className}`} style={at ?? { left: -9999, top: 0 }} role="dialog">{children}</div>,
    document.body,
  )
}

/** One route as a row: its colour, a name, an amount slider, and ×. `name`: what to call it. */
export function RouteRow({ ui, route, name }) {
  const color = modColor(ui.patch, route.src)
  return (
    <div className="sy-route" style={{ '--sy-route': color }} data-sy-target={`route:${route.id}.amt`}>
      <span className="sy-dot" style={{ color }} aria-hidden />
      <span className="sy-route-name" title={name}>{name}</span>
      <AmountSlider ui={ui} route={route} name={name} />
      <button type="button" className="sy-x" aria-label={`Remove ${name}`} title="Remove" onClick={() => removeRoute(ui, route.id)}>×</button>
    </div>
  )
}

/** A route's amount as a slider: the bar grows from the middle, either way. */
function AmountSlider({ ui, route, name }) {
  const control = useAmountControl(ui, route)
  const amt = control.live ?? route.amt
  return (
    <>
      <span
        ref={control.ref}
        className="sy-amt"
        role="slider"
        tabIndex={0}
        aria-label={`${name} amount`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={amt}
        aria-valuetext={formatValue(amt, AMOUNT)}
        title={`Amount · drag or scroll · double-click to type · ${RESET_HINT.replace(' to reset', '')} for none`}
        onPointerEnter={control.onPointerEnter}
        onPointerLeave={control.onPointerLeave}
        onPointerMove={control.onPointerMove}
        onPointerDown={control.onPointerDown}
        onDoubleClick={() => control.startTyping()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); control.startTyping() }
          else control.onKeyDown(e)
        }}
      >
        <span className="sy-amt-bar" style={{ left: `${(Math.min(0, amt) + 1) * 50}%`, width: `${Math.abs(amt) * 50}%` }} />
        <span className="sy-amt-thumb" style={{ left: `${(amt + 1) * 50}%` }} />
        <KnobTypeInput control={control} label={`${name} amount`} />
      </span>
      <AmountReadout control={control} amt={route.amt} />
      <output>{formatValue(amt, AMOUNT)}</output>
    </>
  )
}

/**
 * Picking a target by name: a search box over the targets, grouped. `options` are
 * [target, label, group]; `pick(target)`.
 */
export function TargetPicker({ options, pick, onClose, anchor }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return options.filter(([, label, group]) => words.every((w) => `${group} ${label}`.toLowerCase().includes(w)))
  }, [options, q])
  const groups = [...new Set(found.map(([, , g]) => g))]
  const choose = (t) => { pick(t); onClose() }
  return (
    <Popover anchor={anchor} onClose={onClose} className="sy-picker">
      <input
        autoFocus
        className="sy-picker-search"
        placeholder="find a target…"
        value={q}
        aria-label="Find a target"
        onChange={(e) => { setQ(e.target.value); setAt(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(found.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter' && found[at]) choose(found[at][0])
        }}
      />
      <div className="sy-picker-list" role="listbox">
        {!found.length && <span className="sy-small-label">nothing matches</span>}
        {groups.map((g) => (
          <div key={g} className="sy-picker-group">
            <span className="sy-small-label">{g}</span>
            {found.filter(([, , x]) => x === g).map(([t, label]) => (
              <button key={t} type="button" role="option" aria-selected={found[at]?.[0] === t} className={found[at]?.[0] === t ? 'on' : ''} onClick={() => choose(t)}>{label}</button>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  )
}

/** A knob's routes, listed from its badge: each with its amount and ×. */
export function KnobRoutes({ ui, route, anchor, onClose }) {
  const routes = ui.patch.routes.filter((r) => r.target === route)
  useEffect(() => { if (!routes.length) onClose() }, [routes.length, onClose])
  return (
    <Popover anchor={anchor} onClose={onClose} className="sy-knob-routes">
      <span className="sy-small-label">{targetSpec(ui.patch, route)?.label ?? route} · moved by</span>
      {routes.map((r) => <RouteRow key={r.id} ui={ui} route={r} name={modName(ui.patch, r.src)} />)}
    </Popover>
  )
}

/** The handle you drag from a modulator onto a knob. */
export function AssignHandle({ ui, src }) {
  return (
    <button
      type="button"
      className={`sy-assign ${ui.assign?.src === src ? 'held' : ''}`}
      title="Drag onto a knob to move it with this"
      aria-label={`Drag ${modName(ui.patch, src)} onto a knob`}
      onPointerDown={(e) => ui.startAssign(e, src)}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M7 0v4M7 10v4M0 7h4M10 7h4" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  )
}
