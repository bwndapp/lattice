/**
 * Frames as modules: a wire into an open frame meets an input on its left edge, one going
 * out leaves by an output on its right; wires into the same port inside share one input;
 * only the innermost frame crossed gets the port; collapsed frames are left to routeEdge;
 * and a wire dropped on a port is a wire to (or from) the node inside.
 */
import assert from 'node:assert/strict'
import { framePins, throughPin } from '../src/frames.js'

const node = (id, x, y) => ({ id, type: 'studio', position: { x, y }, width: 100, height: 60 })
const frame = (id, x, y, w, h, extra = {}) => ({ id, x, y, w, h, title: id, ...extra })
const nodes = [node('src', -400, 0), node('a', 50, 80), node('b', 200, 80), node('out', 700, 0), node('src2', -400, 200)]
const edges = [
  { id: 'e1', source: 'src', target: 'a', targetHandle: 'in' }, // in
  { id: 'e2', source: 'a', target: 'b', targetHandle: 'in' }, // inside
  { id: 'e3', source: 'b', target: 'out', targetHandle: 'in-0' }, // out
  { id: 'e4', source: 'src2', target: 'a', targetHandle: 'in' }, // in, to the same port
]
const f = frame('F', 0, 0, 400, 260)
const { pins, route } = framePins([f], nodes, edges)
const at = pins.get('F')
assert.deepEqual(at.ins.map((p) => p.key), ['a|in'], 'one input for the wires into a node\'s one port')
assert.deepEqual(at.outs.map((p) => p.key), ['b|out'], 'and an output for the wire going out')
assert.equal(route.get('e2'), undefined, 'a wire inside the frame is left alone')
assert.deepEqual(route.get('e1'), { inFrame: 'F', inKey: 'a|in' }, 'a wire in goes through the input')
assert.deepEqual(route.get('e3'), { outFrame: 'F', outKey: 'b|out' }, 'a wire out through the output')
assert.ok(at.ins.every((p) => p.y > 28 && p.y < 260), 'ports sit on the edge, below the title bar')

// nested: only the innermost frame crossed gets the port
const inner = frame('G', 20, 40, 160, 140)
const nested = framePins([f, inner], nodes, edges)
assert.equal(nested.route.get('e1').inFrame, 'G', 'into a frame within a frame: the inner one\'s port')
assert.equal(nested.route.get('e2').outFrame, 'G', 'and out of the inner one, still inside the outer')

// collapsed frames are routeEdge's: no ports
const shut = framePins([{ ...f, collapsed: true, members: ['a', 'b'] }], nodes, edges, new Map([['a', 'F'], ['b', 'F']]))
assert.equal(shut.pins.size, 0, 'a collapsed frame has no ports of this kind')

// a wire dropped on a port
assert.deepEqual(throughPin({ source: 'x', sourceHandle: 'out', target: 'F', targetHandle: 'pi-t:a|in' }), { source: 'x', sourceHandle: 'out', target: 'a', targetHandle: 'in' }, 'onto an input: into the node inside')
assert.deepEqual(throughPin({ source: 'F', sourceHandle: 'po-s:b|out', target: 'y', targetHandle: 'in' }), { source: 'b', sourceHandle: 'out', target: 'y', targetHandle: 'in' }, 'from an output: out of the node inside')
console.log('frame ports ok')
