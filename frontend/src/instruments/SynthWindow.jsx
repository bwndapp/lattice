import { useEffect, useMemo, useRef } from 'react'
import Knob from '../Knob.jsx'
import { AutomationContext, useAutomation } from '../autoLive.js'
import { engineTarget } from '../automation.js'
import { previewInPatch } from '../audio'
import { ENGINES, engineData } from './index.js'
import KickPanel from './KickPanel.jsx'
import './SynthWindow.css'

/** Engines with a face of their own; the rest get their knobs in groups. */
const PANELS = { kick: KickPanel }

/**
 * An instrument engine's window, opened from its instrument in a pattern: a modal plugin
 * window with the engine's own panel. Knobs change the instrument as they turn, and
 * right-click automates them like any other knob.
 */
export default function SynthWindow({ project, patternId, channelId, onUpdateProject, onClose }) {
  const ref = useRef(null)
  const pattern = project.patterns.find((p) => p.id === patternId)
  const ch = pattern?.channels.find((c) => c.id === channelId)
  const spec = ch?.engine && ENGINES[ch.engine.type]

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])
  // the instrument went away (deleted, undone, another sound picked)
  useEffect(() => { if (!spec) onClose() }, [spec, onClose])

  // automating a knob happens on the timeline, which the window would cover: close it first
  const automation = useAutomation()
  const outer = useMemo(() => automation && {
    ...automation,
    automate: (...args) => { onClose(); automation.automate(...args) },
    open: (...args) => { onClose(); automation.open(...args) },
    showTimeline: (...args) => { onClose(); automation.showTimeline(...args) },
  }, [automation, onClose])

  if (!spec) return null
  const data = engineData(ch.engine)
  const set = (key, value) => onUpdateProject((p) => {
    const c = p.patterns.find((x) => x.id === patternId)?.channels.find((x) => x.id === channelId)
    if (c?.engine) c.engine = { ...c.engine, data: { ...c.engine.data, [key]: value } }
  })
  const reset = () => onUpdateProject((p) => {
    const c = p.patterns.find((x) => x.id === patternId)?.channels.find((x) => x.id === channelId)
    if (c?.engine) c.engine = { ...c.engine, data: {} }
  })
  const knob = (def) => (
    <Knob key={def.key} def={def} value={data[def.key]} onChange={(v) => set(def.key, v)} target={engineTarget(patternId, channelId, def.key)} />
  )
  const groups = spec.groups.map(([key, title]) => ({ key, title, params: spec.params.filter((p) => p.group === key) }))
  const Panel = PANELS[spec.type]

  return (
    <dialog
      ref={ref}
      className="synth-window"
      aria-labelledby="synth-window-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      // keys stay in here: Delete on a knob must not delete nodes behind the window
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      <AutomationContext.Provider value={outer}>
        <div className="sw-body">
          <header className="sw-head">
            <h2 id="synth-window-title" className="sw-title">{spec.label}</h2>
            <span className="sw-where">{ch.name} · {pattern.name}</span>
            <span className="sw-spacer" />
            <button type="button" className="btn" onClick={() => previewInPatch(project, patternId, ch)} title="Play one hit">hear</button>
            <button type="button" className="btn ghost" onClick={reset} title="Every knob back to where it started">reset</button>
            <button type="button" className="btn" onClick={onClose} title="Close (Esc)">close</button>
          </header>
          {Panel
            ? <Panel data={data} groups={groups} knob={knob} />
            : (
              <div className="sw-groups">
                {groups.map((g) => (
                  <section key={g.key} className="sw-group" aria-label={g.title}>
                    <h3 className="sw-group-title">{g.title}</h3>
                    <div className="sw-knobs">{g.params.map(knob)}</div>
                  </section>
                ))}
              </div>
            )}
        </div>
      </AutomationContext.Provider>
    </dialog>
  )
}
