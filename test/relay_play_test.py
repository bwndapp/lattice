"""Playing in time: the clock answer, where the playhead is going, and joining mid-song."""
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


async def until(ws, want, timeout=2.0):
    """Everything that arrives up to and including the one we're waiting for. Use this
    rather than drain() to say what did NOT turn up: drain walks straight past it."""
    seen = []
    while True:
        msg = await recv(ws, timeout)
        seen.append(msg)
        if msg.get('t') == want:
            return seen


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

            # somebody watching neither hears nor moves anyone's playhead
            async with websockets.connect(URL) as c:
                await hello(c, '', 'nosy')  # no token: here to watch
                await c.send(json.dumps({'t': 'play', 'on': True, 'pos': 999, 'cps': 1}))
                await c.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 0, 'y': 0}))
                seen = await until(b, 'at')  # their cursor arrives, so the play frame was handled first
                ok("someone watching cannot move anyone's playhead", not any(m['t'] == 'play' for m in seen), seen)
                await c.send(json.dumps({'t': 'time', 'c': 7}))
                tick = await drain(c, 'time')
                ok('anyone may ask the time', tick.get('c') == 7, tick)

            # walking in while the room is playing: you are told, without anyone touching
            # the transport again, and told when — so you can work out where it is by now
            await a.send(json.dumps({'t': 'play', 'on': True, 'pos': 4.0, 'cps': 0.5}))
            await drain(b, 'play')
            async with websockets.connect(URL) as d:
                await hello(d, 'friend', 'bo')
                joined = await drain(d, 'play')
                ok('a late arrival is told what the room is playing', joined['on'] is True and joined['pos'] == 4.0, joined)
                ok('and when it was said', abs(joined['at'] - time.time() * 1000) < 2000, joined)

            # a room that is stopped has no music to join, and moving someone's playhead
            # when nobody is playing would be a worse surprise than silence
            await a.send(json.dumps({'t': 'play', 'on': False, 'pos': 9.0}))
            await drain(b, 'play')
            async with websockets.connect(URL) as e:
                await hello(e, 'friend', 'bo')
                await e.send(json.dumps({'t': 'time', 'c': 3}))
                seen = await until(e, 'time')
                ok('a stopped room hands nobody a playhead', not any(m['t'] == 'play' for m in seen), seen)

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
