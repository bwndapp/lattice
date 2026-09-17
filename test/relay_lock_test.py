"""The owner deciding whether anyone else may work on the track."""
import asyncio
import json

import websockets

URL = 'ws://127.0.0.1:8791/api/collab/pub'
fails = []


def ok(name, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f' — {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def drain(ws, want, timeout=2.0):
    while True:
        msg = await recv(ws, timeout)
        if msg.get('t') == want:
            return msg


async def hello(ws, token, name):
    await ws.send(json.dumps({'t': 'hello', 'token': token, 'name': name}))
    me = await recv(ws)
    await recv(ws)  # here
    return me


async def main():
    async with websockets.connect(URL) as owner:
        me_o = await hello(owner, 'owner', 'ana')
        ok('the owner is told they own it', me_o.get('owner') is True and me_o.get('edit') is True, me_o)
        ok('a track starts open', me_o.get('open') is True, me_o)
        await drain(owner, 'seed')
        await owner.send(json.dumps({'t': 'doc', 'doc': {'bpm': 140}}))
        await drain(owner, 'ack')

        async with websockets.connect(URL) as friend:
            me_f = await hello(friend, 'friend', 'bo')
            ok('a friend may edit while it is open', me_f.get('edit') is True and me_f.get('owner') is False, me_f)
            await drain(friend, 'doc')

            # the owner closes it
            await owner.send(json.dumps({'t': 'lock', 'on': False}))
            told = await drain(friend, 'role')
            ok('the friend is told at once', told.get('edit') is False and told.get('open') is False, told)

            await friend.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 999}], 'h': 'x'}))
            await friend.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 3, 'y': 4}))
            await drain(owner, 'at')  # their cursor still arrives: they're present, just watching
            await owner.send(json.dumps({'t': 'sync'}))
            after = await drain(owner, 'doc')
            ok('their edit no longer lands', after['doc']['bpm'] == 140, after['doc']['bpm'])

            # the owner's own edits still travel to them? no: watching means watching
            await owner.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 150}], 'h': 'y'}))
            await drain(owner, 'ack')

            # and opens it again
            await owner.send(json.dumps({'t': 'lock', 'on': True}))
            back = await drain(friend, 'role')
            ok('letting them back in is told at once', back.get('edit') is True and back.get('open') is True, back)
            fresh = await drain(friend, 'doc')
            ok('they are handed the track as it now stands', fresh['doc']['bpm'] == 150, fresh['doc'])

            await friend.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 128}], 'h': 'z'}))
            await drain(owner, 'ops')
            await owner.send(json.dumps({'t': 'sync'}))
            end = await drain(owner, 'doc')
            ok('their edits land again', end['doc']['bpm'] == 128, end['doc']['bpm'])

            # a friend cannot lock anyone out
            await friend.send(json.dumps({'t': 'lock', 'on': False}))
            await friend.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 9, 'y': 9}))
            await drain(owner, 'at')
            await friend.send(json.dumps({'t': 'ops', 'ops': [{'op': 'set', 'path': ['bpm'], 'value': 111}], 'h': 'w'}))
            await drain(owner, 'ops')
            ok('a friend cannot lock the owner out of their own track', True)

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
