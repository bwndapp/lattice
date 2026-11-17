/**
 * Knobs the app sets itself (an insert's, a send's, an instrument engine's) are set back to
 * where their knob is whenever the code is committed or a rack is built for a bus that has
 * just started sounding. Automation moving those knobs needs to know, or it leaves them
 * there until its curve next changes (wrong from the start of the song, on a flat stretch).
 * Each of those bumps this; the automation driver puts its knobs back on their curves when
 * it sees it move (autoDrive.js).
 */
let epoch = 0
export const paramsReset = () => { epoch++ }
export const paramsEpoch = () => epoch

/*
 * Where automation has those knobs right now, for anything being built: a rack, a send or an
 * instrument made from the code's settings starts on the curve, not at the knob's set value
 * gliding over (a filter built wide open and sweeping down was a bright "sharp bit" at the
 * start). `fn(key)` → { param: value } for an automated thing, or null. The app sets it while
 * a song has automation; the export sets it to the bar it renders from.
 */
let source = null
export const setAutoSource = (fn) => { source = fn ?? null }
export const getAutoSource = () => source
export const autoOverlay = (key) => { try { return source?.(key) ?? null } catch { return null } }
