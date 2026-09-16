import { createContext, useContext } from 'react'

/**
 * The piano roll lives in a dock along the bottom of the app (see RollDock.jsx), so it
 * stays open while you work on the patch, the timeline or another instrument. Anything
 * that shows notes asks for it through here.
 */
export const RollContext = createContext(null)
export const useRollDock = () => useContext(RollContext)
