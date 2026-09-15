import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'

/** Fired by a wire's + button; the patch canvas opens its add menu there. */
export const ADD_INTO_WIRE = 'lattice:add-into-wire'

/**
 * A wire with a small + in the middle: click it to add a node into this wire. The path is
 * React Flow's own bezier, so the wire looks and hit-tests exactly like before.
 */
export function WireEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, interactionWidth }) {
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
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
