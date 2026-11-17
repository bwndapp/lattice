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
