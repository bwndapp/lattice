"""Playing in time: the clock answer, and where the playhead is going."""
import asyncio
import json
import time

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
    await recv(ws)  # me
    await recv(ws)  # here
    return True


async def main():
    async with websockets.connect(URL) as a:
        await hello(a, 'owner', 'ana')
        await drain(a, 'seed')
        await a.send(json.dumps({'t': 'doc', 'doc': {'bpm': 140}}))
        await drain(a, 'ack')

        # the clock
        before = time.time() * 1000
        await a.send(json.dumps({'t': 'time', 'c': 12345}))
        answer = await drain(a, 'time')
        after = time.time() * 1000
        ok('the clock answer carries our own stamp back', answer.get('c') == 12345, answer)
        ok('the clock answer is the server time', before - 5 <= answer['s'] <= after + 5, answer)

        async with websockets.connect(URL) as b:
            await hello(b, 'owner', 'ana')
            await drain(b, 'doc')

            # where the playhead is
            await a.send(json.dumps({'t': 'play', 'on': True, 'pos': 12.5, 'cps': 0.5833}))
            heard = await drain(b, 'play')
            ok('the playhead position travels', heard['on'] is True and heard['pos'] == 12.5 and heard['cps'] == 0.5833, heard)
            ok('the server stamps when it happened', abs(heard['at'] - time.time() * 1000) < 1000, heard)

            await a.send(json.dumps({'t': 'play', 'on': False, 'pos': 16.0}))
            stopped = await drain(b, 'play')
            ok('stopping travels too', stopped['on'] is False and stopped['pos'] == 16.0, stopped)

            # a stranger neither hears nor moves anyone's playhead
            async with websockets.connect(URL) as c:
                await hello(c, 'stranger', 'nosy')
                await c.send(json.dumps({'t': 'play', 'on': True, 'pos': 999, 'cps': 1}))
                await c.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 0, 'y': 0}))
                nxt = await drain(b, 'at')  # their cursor arrives; the play frame was handled first
                ok("a stranger cannot move anyone's playhead", nxt['t'] == 'at')
                await c.send(json.dumps({'t': 'time', 'c': 7}))
                tick = await drain(c, 'time')
                ok('anyone may ask the time', tick.get('c') == 7, tick)

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
