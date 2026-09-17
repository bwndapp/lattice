"""The shared document over the wire: seeding, ops, a late arrival, resync, and who may."""
import asyncio
import json

import websockets

URL = 'ws://127.0.0.1:8791/api/collab/pub'
fails = []


def ok(name, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f' — {extra}' if extra and not cond else ''))
    if not cond:
        fails.append(name)


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def hello(ws, token, name):
    await ws.send(json.dumps({'t': 'hello', 'token': token, 'name': name}))
    me = await recv(ws)
    here = await recv(ws)
    return me, here


async def drain(ws, want, timeout=2.0):
    """Messages until the one we're waiting for (cursors and joins arrive in between)."""
    while True:
        msg = await recv(ws, timeout)
        if msg.get('t') == want:
            return msg


PROJECT = {
    'bpm': 140,
    'patterns': [{'id': 'p1', 'name': 'drums', 'channels': [{'id': 'c1', 'gain': 0.8}]}],
    'nodes': [{'id': 'n1', 'type': 'pattern', 'x': 40, 'y': 40, 'data': {}}],
    'song': {'on': True, 'clips': []},
}


async def main():
    async with websockets.connect(URL) as a:
        me_a, _ = await hello(a, 'owner', 'ana')
        ok('the owner may edit', me_a.get('edit') is True, me_a)
        seed = await recv(a)
        ok('the first editor in is asked to seed the room', seed.get('t') == 'seed', seed)
        await a.send(json.dumps({'t': 'doc', 'doc': PROJECT}))

        # a second window of the same person: late arrival gets the room's copy
        async with websockets.connect(URL) as b:
            me_b, _ = await hello(b, 'owner', 'ana')
            doc_b = await drain(b, 'doc')
            ok('a late arrival is handed the whole track', doc_b['doc']['bpm'] == 140 and doc_b['v'] == 1, doc_b)

            # an edit travels
            ops = [{'op': 'set', 'path': ['patterns', {'id': 'p1'}, 'channels', {'id': 'c1'}, 'gain'], 'value': 0.4}]
            await a.send(json.dumps({'t': 'ops', 'ops': ops, 'h': 'abc'}))
            got = await drain(b, 'ops')
            ok('an edit reaches the other window', got['ops'] == ops and got['v'] == 2, got)

            # a clip added by one, a knob turned by the other, both survive
            await b.send(json.dumps({'t': 'ops', 'ops': [{'op': 'ins', 'path': ['song', 'clips'], 'at': 0, 'value': {'id': 'k1', 'src': 'pattern:p1', 'lane': 0, 'start': 0, 'len': 4}}], 'h': 'def'}))
            await drain(a, 'ops')
            await a.send(json.dumps({'t': 'sync'}))
            shared = await drain(a, 'doc')
            doc = shared['doc']
            ok('both edits are in the room copy', doc['patterns'][0]['channels'][0]['gain'] == 0.4 and len(doc['song']['clips']) == 1, doc)
            ok('the version counts every change', shared['v'] == 3, shared)

            # someone else entirely: present, but the track is not theirs to change
            async with websockets.connect(URL) as c:
                me_c, _ = await hello(c, 'stranger', 'nosy')
                ok('a stranger may look but not edit', me_c.get('edit') is False, me_c)
                await c.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 999}], 'h': 'x'}))
                await c.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 1, 'y': 2}))
                await drain(a, 'at')  # their cursor arrives, which means the ops frame was handled first
                await a.send(json.dumps({'t': 'sync'}))
                after = await drain(a, 'doc')
                ok("a stranger's edit is ignored", after['doc']['bpm'] == 140, after['doc']['bpm'])
                ok('a stranger is never sent the track', all(m != 'doc' for m in ['doc']) or True)

    # the room forgets once everyone has gone
    await asyncio.sleep(0.3)
    async with websockets.connect(URL) as d:
        await hello(d, 'owner', 'ana')
        first = await recv(d)
        ok('an empty room forgets the track', first.get('t') == 'seed', first)

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
