import { useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react'

/** Fired by a wire's + button; the patch canvas opens its add menu there. */
export const ADD_INTO_WIRE = 'lattice:add-into-wire'

const STIFF = 0.16 // how hard the wire pulls back to where it wants to hang
const DAMP = 0.78 // how quickly the swing dies down
const REST = 0.15 // below this it's near enough still to stop drawing

/** How far a wire hangs at rest: the longer the span, the more rope there is in it. */
function slackOf(sourceX, sourceY, targetX, targetY) {
  const run = Math.abs(targetX - sourceX)
  const back = Math.max(0, sourceX - targetX) // one doubling back has further to hang
  return Math.min(130, 12 + run * 0.17 + back * 0.4)
}

/**
 * The weight in a wire. It hangs a little rather than being drawn taut, and when a node
 * moves it swings and settles instead of snapping to its new shape — one spring per wire,
 * on the sag alone, running only while it's actually moving.
 *
 * It's the look of a patch bay, and it costs a number per wire per frame while you drag.
 */
function useSag(sourceX, sourceY, targetX, targetY) {
  const [sag, setSag] = useState(() => slackOf(sourceX, sourceY, targetX, targetY))
  const spring = useRef({ y: null, v: 0, frame: 0, x: 0, ty: 0 })

  useEffect(() => {
    const s = spring.current
    const want = slackOf(sourceX, sourceY, targetX, targetY)
    if (s.y === null) { s.y = want; setSag(want); return undefined }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { s.y = want; setSag(want); return undefined }
    // an end that just moved gives the rope a shove, so a quick drag whips it
    const moved = Math.hypot(targetX - s.x, targetY - s.ty)
    s.x = targetX
    s.ty = targetY
    s.v += Math.min(9, moved * 0.22)
    if (s.frame) return undefined
    const step = () => {
      const now = spring.current
      const to = slackOf(sourceX, sourceY, targetX, targetY)
      now.v = (now.v + (to - now.y) * STIFF) * DAMP
      now.y += now.v
      if (Math.abs(now.v) < REST && Math.abs(to - now.y) < REST) {
        now.y = to
        now.v = 0
        now.frame = 0
        setSag(to)
        return
      }
      setSag(now.y)
      now.frame = requestAnimationFrame(step)
    }
    s.frame = requestAnimationFrame(step)
    return undefined
  }, [sourceX, sourceY, targetX, targetY])

  useEffect(() => () => cancelAnimationFrame(spring.current.frame), [])
  return sag
}

/**
 * A wire with a small + in the middle: click it to add a node into this wire. React Flow's
 * bezier gives the shape; the sag pulls its middle down so the wire has some weight in it.
 */
export function WireEdge({ id, sourceX, sourceY, targetX, targetY, data, style, markerEnd, interactionWidth }) {
  const pull = data?.tension ?? 1
  const sag = useSag(sourceX, sourceY, targetX, targetY) * pull
  // Two curves through a low middle, rather than one bowed line. A wire has to leave its
  // port sideways and arrive at the next one sideways — the dip belongs in between, which
  // one curve can't do: bending it enough to hang tips both ends off at an angle.
  const midX = (sourceX + targetX) / 2
  const midY = (sourceY + targetY) / 2 + sag
  const reach = Math.max(34, Math.abs(targetX - sourceX) * 0.28 + Math.max(0, sourceX - targetX) * 0.5)
  const path = `M${sourceX},${sourceY} C${sourceX + reach},${sourceY} ${midX - reach},${midY} ${midX},${midY}`
    + ` C${midX + reach},${midY} ${targetX - reach},${targetY} ${targetX},${targetY}`
  const length = Math.hypot(targetX - sourceX, targetY - sourceY)
  const small = length < 90
  const lift = length < 36 ? 17 : 0 // no room between the dots: sit just above the wire instead
  return (
    <>
      {/* a wire is three strokes of the same line: a dark casing, the coloured body that
          carries the click, and a thin bright thread down the middle of it */}
      <path className="wire-casing" d={path} style={style} />
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <path className="wire-sheen" d={path} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`wire-add nodrag nopan ${small ? 'small' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY - lift}px)` }}
          title="Add a node into this wire"
          aria-label="Add a node into this wire"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            window.dispatchEvent(new CustomEvent(ADD_INTO_WIRE, { detail: { edgeId: id, x: r.left + r.width / 2, y: r.top + r.height / 2 } }))
          }}
        >+</button>
        {/* what's going through, in dB, written here frame by frame by flow.js */}
        <span
          className="wire-db quiet"
          data-db={id}
          aria-hidden
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY - 26}px)` }}
        />
      </EdgeLabelRenderer>
    </>
  )
}

export const EDGE_TYPES = { wire: WireEdge }
