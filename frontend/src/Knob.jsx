import { useCallback, useState } from 'react'
import { useAutoLive, useAutomation } from './autoLive.js'
import { KnobMenu } from './KnobMenu.jsx'
import { knobBridge } from './knobBridge.js'
import { clamp, fromPos, parseKnobValue, snapValue, stepOf, toPos } from './knobMath.js'
import { KnobReadout, KnobTypeInput, RESET_HINT, useKnobControl } from './useKnobControl.jsx'

export function formatValue(v, def) {
  if (def.choices) return def.choices[Math.round(v)] ?? ''
  if (def.key === 'pan') return v === 0.5 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`
  if (def.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v < 10 ? `${v.toFixed(2)}` : `${Math.round(v)}`
  if (def.unit === 'ct') return `${v > 0.5 ? '+' : ''}${Math.round(v)}ct`
  if (def.unit === 'x') return `${v.toFixed(2)}x`
  if (def.unit === 'bar') return `${Math.round(v * 16 * 10) / 10}/16`
  if (def.unit === 's') return v < 0.1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`
  if (def.unit === 'db') return `${v > 0.05 && def.origin === 0 ? '+' : ''}${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${def.origin === 0 && v <= def.min ? ' off' : ''}`
  if (def.unit === 'ratio') return `${v < 10 ? v.toFixed(1) : Math.round(v)}:1`
  if (def.unit === 'bi') return `${v > 0.005 ? '+' : ''}${Math.round(v * 100)}`
  return `${Math.round(v * 100)}`
}

/** A value with its unit, for the readout. */
export function readoutText(v, def) {
  const s = formatValue(v, def)
  if (def.choices || def.key === 'pan') return s
  if (def.unit === 'hz') return `${s}Hz`
  if (def.unit === 'db') return s.endsWith(' off') ? s : `${s} dB`
  if (!def.unit || def.unit === 'bi' || def.unit === 'c') return `${s}%`
  return s
}

/**
 * A knob: drag up/down or sideways (shift for fine), scroll, arrow keys, double-click (or
 * Enter) to type a value, ctrl/cmd-click, alt-click or Home to reset (see useKnobControl).
 * With a `target` (see automation.js), right-click offers to automate it; an automated knob
 * wears a mark and, while the song plays, turns with its curve, and the sound follows a
 * turn at once where the app can move it (knobBridge.js).
 */
export default function Knob({ def, value, onChange, target = null }) {
  const automation = useAutomation()
  const automated = !!target && !!automation?.automated.has(target)
  const following = useAutoLive(automated ? target : null) // where its curve has it, while playing
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // a knob in steps shows the step it's on, whatever an old project stored
  const resting = def.choices ? snapValue(following ?? value, def) : following ?? value
  const origin = def.origin !== undefined ? clamp(toPos(def.origin, def), 0, 1) : def.key === 'pan' ? 0.5 : 0
  const bipolar = (def.unit === 'bi' || def.key === 'pan' || def.origin !== undefined) && origin >= 0.1 && origin <= 0.9
  const step = stepOf(def)
  const control = useKnobControl({
    value,
    shown: resting,
    toPos: (v) => toPos(v, def),
    fromPos: (p) => fromPos(p, def),
    snap: (v) => snapValue(v, def),
    onChange,
    live: target ? (v) => knobBridge.live(target, v) : null,
    resetTo: def.def,
    parse: (text) => parseKnobValue(text, def),
    format: (v) => formatValue(v, def),
    centre: bipolar ? origin : null,
    notch: step || 0.015,
    fineNotch: step || 0.003,
    keyStep: step || 0.05,
    fineKeyStep: step || 0.01,
    pageStep: Math.max(step, 0.2),
  })
  const { live } = control
  const shown = live ?? resting
  const pos = clamp(toPos(shown, def), 0, 1)
  const changed = Math.abs(shown - def.def) > 1e-9

  // arc from 225° (min) round to -45° (max)
  const angle = (a) => ((225 - a * 270) * Math.PI) / 180
  const r = 13
  const pt = (a) => [18 + r * Math.cos(angle(a)), 18 - r * Math.sin(angle(a))]
  const arc = (a0, a1) => {
    const [x0, y0] = pt(a0)
    const [x1, y1] = pt(a1)
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`
  }
  const [hx, hy] = pt(pos)

  return (
    <div
      className={`knob ${changed ? 'changed' : ''} ${automated ? 'automated' : ''} ${following !== undefined ? 'following' : ''}`}
      title={`${def.label}: ${formatValue(shown, def)}${automated ? ' · automated in the song' : ''} · drag, scroll, double-click to type · ${RESET_HINT}${target && automation ? ' · right-click to automate' : ''}`}
      onContextMenu={(e) => {
        if (!target || !automation) return
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <svg
        ref={control.ref}
        className="nodrag"
        width="36"
        height="36"
        viewBox="0 0 36 36"
        role="slider"
        tabIndex={0}
        aria-label={def.label}
        aria-valuemin={def.min}
        aria-valuemax={def.max}
        aria-valuenow={Math.round(shown * 1000) / 1000}
        aria-valuetext={formatValue(shown, def)}
        onPointerEnter={control.onPointerEnter}
        onPointerLeave={control.onPointerLeave}
        onPointerMove={control.onPointerMove}
        onPointerDown={control.onPointerDown}
        onDoubleClick={(e) => { e.stopPropagation(); control.startTyping() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); control.startTyping() }
          else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); control.reset() }
          else control.onKeyDown(e)
        }}
      >
        {/* a little room round the knob that still grabs it, without taking any space */}
        <circle cx="18" cy="18" r="21" className="knob-hit" />
        <path d={arc(0, 1)} className="knob-track" />
        {Math.abs(pos - origin) > 0.004 && <path d={pos > origin ? arc(origin, pos) : arc(pos, origin)} className="knob-value" />}
        <line x1="18" y1="18" x2={hx} y2={hy} className="knob-hand" />
      </svg>
      <KnobTypeInput control={control} label={def.label} />
      <KnobReadout control={control} text={readoutText(shown, def)} />
      <span className="knob-label">{live !== null || following !== undefined ? formatValue(shown, def) : def.label}</span>
      {automated && <span className="knob-auto-mark" aria-hidden />}
      {menu && (
        <KnobMenu
          x={menu.x}
          y={menu.y}
          title={def.label}
          onClose={closeMenu}
          items={automated ? [
            ['Edit automation', () => automation.open(target, menu)],
            ['Show on the timeline', () => automation.showTimeline(target)],
            ['Remove automation', () => automation.remove(target), { danger: true }],
            null,
            ['Reset to default', () => onChange(def.def)],
          ] : [
            ['Automate on the timeline', () => automation.automate(target, menu), { accent: true }],
            null,
            ['Reset to default', () => onChange(def.def)],
          ]}
        />
      )}
    </div>
  )
}
