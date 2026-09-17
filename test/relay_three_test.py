"""Three people at once: everything reaching everyone, and cursors never crowding out edits."""
import asyncio
import json

import websockets

URL = 'ws://127.0.0.1:8791/api/collab/pub'
fails = []


def ok(name, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f' — {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


async def recv(ws, timeout=3.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def drain(ws, want, timeout=3.0):
    while True:
        msg = await recv(ws, timeout)
        if msg.get('t') == want:
            return msg


async def hello(ws, token, name):
    await ws.send(json.dumps({'t': 'hello', 'token': token, 'name': name}))
    me = await recv(ws)
    await recv(ws)  # here
    return me


def gain_op(channel, value):
    return {'op': 'set', 'path': ['patterns', {'id': 'p1'}, 'channels', {'id': channel}, 'gain'], 'value': value}


PROJECT = {
    'bpm': 140,
    'patterns': [{'id': 'p1', 'channels': [{'id': 'kick', 'gain': 1}, {'id': 'bass', 'gain': 1}, {'id': 'hat', 'gain': 1}]}],
    'song': {'on': True, 'clips': []},
}


async def main():
    async with websockets.connect(URL) as a, websockets.connect(URL) as b, websockets.connect(URL) as c:
        me_a = await hello(a, 'owner', 'ana')
        await drain(a, 'seed')
        await a.send(json.dumps({'t': 'doc', 'doc': PROJECT}))
        await drain(a, 'ack')
        me_b = await hello(b, 'friend', 'bo')
        me_c = await hello(c, 'third', 'cy')
        await drain(b, 'doc')
        await drain(c, 'doc')
        ok('three in the room, all able to edit', all(m.get('edit') for m in (me_a, me_b, me_c)))
        ok('each is a different colour', len({me_a['color'], me_b['color'], me_c['color']}) == 3)

        # all three edit at the same moment, each a different knob
        await asyncio.gather(
            a.send(json.dumps({'t': 'ops', 'ops': [gain_op('kick', 0.1)], 'h': 'a'})),
            b.send(json.dumps({'t': 'ops', 'ops': [gain_op('bass', 0.2)], 'h': 'b'})),
            c.send(json.dumps({'t': 'ops', 'ops': [gain_op('hat', 0.3)], 'h': 'c'})),
        )
        # each hears all three changes, their own included: everybody applies the same
        # changes in the same order, which is what makes them agree (see collab.py)
        heard = {}
        for name, ws in (('ana', a), ('bo', b), ('cy', c)):
            heard[name] = [await drain(ws, 'ops'), await drain(ws, 'ops'), await drain(ws, 'ops')]
        ok('everyone hears all three changes', all(len(v) == 3 for v in heard.values()), heard)

        await a.send(json.dumps({'t': 'sync'}))
        doc = (await drain(a, 'doc'))['doc']
        gains = {ch['id']: ch['gain'] for ch in doc['patterns'][0]['channels']}
        ok('all three edits survived', gains == {'kick': 0.1, 'bass': 0.2, 'hat': 0.3}, gains)

        # one order for everybody: three changes numbered 2, 3, 4, and each person is told
        # the two that weren't theirs — which is what lets a client spot a gap and ask again
        versions = {name: sorted(m['v'] for m in msgs) for name, msgs in heard.items()}
        ok('the changes are numbered in one order for everyone', all(v == [2, 3, 4] for v in versions.values()), versions)

        # a cursor storm from one person must not cost anybody an edit
        storm = [a.send(json.dumps({'t': 'at', 'where': 'graph', 'x': i, 'y': i})) for i in range(120)]
        await asyncio.gather(*storm)
        await a.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 128}], 'h': 'storm'}))
        got = await drain(b, 'ops', timeout=4)
        ok('an edit still lands in the middle of a cursor storm', got['ops'][0]['value'] == 128, got)

        # and the storm itself is trimmed rather than passed on wholesale
        seen_cursors = 0
        try:
            while True:
                msg = await recv(b, 0.4)
                if msg.get('t') == 'at':
                    seen_cursors += 1
        except (asyncio.TimeoutError, TimeoutError):
            pass
        ok('the storm is trimmed, not relayed whole', seen_cursors <= 45, seen_cursors)

        # one person leaving leaves the other two working
        await c.close()
        await drain(a, 'gone')
        await b.send(json.dumps({'t': 'ops', 'ops': [gain_op('kick', 0.9)], 'h': 'z'}))
        after = await drain(a, 'ops')
        ok('the other two carry on when one leaves', after['ops'][0]['value'] == 0.9, after)

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
