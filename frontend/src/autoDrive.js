import { activeAutos, appParam, autoValueFn, resolveTarget } from './automation.js'
import { setFxParams } from './fxbus.js'
import { setInsertParams } from './stereo.js'
import { setEngineParams } from './instruments/host.js'

/**
 * Automated knobs turning while the song plays. Knobs in the code follow their signals on
 * their own; reverb, delay, stereo and instrument knobs are the app's (automation.js
 * `appParam`), and a driver here moves them as the curve goes.
 *
 * Generating the code (any edit, even one that changes nothing, like picking a note in the
 * piano roll) sets every one of those back to where its knob is set. So a generation says
 * so (`codeCommitted`), and each driver puts its knobs straight back on their curves.
 */
const commits = new Set()
export function onCommit(fn) { commits.add(fn); return () => commits.delete(fn) }
export function codeCommitted() { for (const fn of commits) fn() }

/** Every automation that moves a knob now, with its curve (song time → value). */
export function autoTargets(project) {
  return project ? activeAutos(project).map((a) => {
    const fn = autoValueFn(project, a)
    // reverb, delay and stereo knobs are the app's own: it moves them as the curve goes
    return fn && { target: a.target, fn, app: appParam(project, a.target), base: resolveTarget(project, a.target)?.value }
  }).filter(Boolean) : []
}

/** What an app-moved knob sets its parameter to. */
export function appParamValue(app, value) {
  const v = value * (app.scale ?? 1)
  // a reverb's room is rebuilt when its size changes, so only move in steps
  return ['size', 'tone', 'width'].includes(app.param) ? Math.round(v * 40) / 40 : v
}
function setAppParam(app, v) {
  const patch = { [app.param]: v }
  if (app.where === 'fx') setFxParams(app.key, patch)
  else if (app.where === 'engine') setEngineParams(app.key, patch)
  else setInsertParams(app.key, patch)
}
export function applyAppParam(app, value) { setAppParam(app, appParamValue(app, value)) }

/**
 * Drive `autos` (from `autoTargets`) at `position()` (song time): `tick()` moves the app's
 * knobs whose value changed and returns every knob's value; a generation moves them all
 * again at once. `stop(keep)` puts those not in `keep` (targets) back where they're set.
 */
export function autoDriver(autos, position) {
  const last = new Map()
  const drive = (force) => {
    const values = new Map()
    const at = position()
    for (const a of autos) {
      const value = a.fn(at)
      values.set(a.target, value)
      if (!a.app) continue
      const stepped = appParamValue(a.app, value)
      if (!force && last.get(a) === stepped) continue
      last.set(a, stepped)
      setAppParam(a.app, stepped)
    }
    return values
  }
  const off = onCommit(() => drive(true))
  return {
    tick: () => drive(false),
    now: () => drive(true),
    stop(keep = new Set()) {
      off()
      for (const a of autos) {
        if (!a.app || a.base === undefined || keep.has(a.target)) continue
        setAppParam(a.app, a.base * (a.app.scale ?? 1))
      }
    },
  }
}
