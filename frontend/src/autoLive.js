import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * What knobs need to know about automation, from the app: which knobs follow a curve,
 * and what right-click → automate does. Null outside the app (knobs then have no menu).
 */
export const AutomationContext = createContext(null)
export const useAutomation = () => useContext(AutomationContext)

// ── knobs moving while the song plays ─────────────────────────────────────────
const liveValues = new Map() // target → value the knob is at now
const listeners = new Set()
export const autoLive = {
  set(values) {
    let changed = false
    for (const [target, v] of values) {
      if (Math.abs((liveValues.get(target) ?? NaN) - v) > 1e-6 || !liveValues.has(target)) { liveValues.set(target, v); changed = true }
    }
    for (const target of [...liveValues.keys()]) if (!values.has(target)) { liveValues.delete(target); changed = true }
    if (changed) for (const fn of listeners) fn()
  },
  clear() { this.set(new Map()) },
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
/** Where an automated knob is right now while the song plays (undefined otherwise). */
export function useAutoLive(target) {
  return useSyncExternalStore(subscribe, () => (target ? liveValues.get(target) : undefined))
}

