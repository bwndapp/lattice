import { useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'

/** Fired by a wire's + button; the patch canvas opens its add menu there. */
export const ADD_INTO_WIRE = 'lattice:add-into-wire'

const STIFF = 0.16 // how hard the wire pulls back to where it wants to hang
const DAMP = 0.78 // how quickly the swing dies down
const REST = 0.15 // below this it's near enough still to stop drawing

/** How far a wire hangs when it's at rest: more slack over a short run, and more doubling back. */
function slackOf(sourceX, sourceY, targetX, targetY) {
  const run = Math.abs(targetX - sourceX)
  const drop = Math.abs(targetY - sourceY)
  const back = Math.max(0, sourceX - targetX) // a wire going backwards has rope to spare
  return Math.min(56, 10 + back * 0.16 + Math.max(0, 260 - run) * 0.09 + drop * 0.02)
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
export function WireEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, interactionWidth }) {
  const sag = useSag(sourceX, sourceY, targetX, targetY)
  const [path, midX, midY] = getBezierPath({
    sourceX,
    sourceY: sourceY + sag * 0.35,
    targetX,
    targetY: targetY + sag * 0.35,
    sourcePosition,
    targetPosition,
    curvature: 0.3,
  })
  const length = Math.hypot(targetX - sourceX, targetY - sourceY)
  const small = length < 90
  const lift = length < 36 ? 17 : 0 // no room between the dots: sit just above the wire instead
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
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
      </EdgeLabelRenderer>
    </>
  )
}

export const EDGE_TYPES = { wire: WireEdge }
