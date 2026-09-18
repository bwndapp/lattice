"""Who may walk in: an open session, an invite-only one, and the list browse asks for."""
import asyncio
import json
import urllib.request

import websockets

URL = 'ws://127.0.0.1:8791/api/collab'
HTTP = 'http://127.0.0.1:8791/api/collab'
fails = []


def ok(name, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f' — {extra}' if extra and not cond else ''))
    if not cond:
        fails.append(name)


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def drain(ws, want, timeout=2.0):
    while True:
        msg = await recv(ws, timeout)
        if msg.get('t') == want:
            return msg


async def hello(ws, token, name, join=None):
    frame = {'t': 'hello', 'token': token, 'name': name}
    if join is not None:
        frame['join'] = join
    await ws.send(json.dumps(frame))
    return await recv(ws)  # me


async def turned_away(track, token, join=None):
    """True when the room shuts the door on them."""
    try:
        async with websockets.connect(f'{URL}/{track}') as ws:
            await hello(ws, token, 'nosy', join)
            return False
    except Exception:
        return True


def live():
    with urllib.request.urlopen(f'{HTTP}/live', timeout=2) as r:
        return json.load(r)['tracks']


async def main():
    # ── an invite-only track, set that way in the database before anyone arrives ──
    ok('a stranger without the key is turned away', await turned_away('shut', 'friend'))
    ok('the wrong key is no better', await turned_away('shut', 'friend', 'open-sesame'))

    async with websockets.connect(f'{URL}/shut') as owner:
        me = await hello(owner, 'owner', 'ana', None)
        ok('the owner never needs their own invitation', me.get('t') == 'me', me)
        ok('and is told the key, to hand out', me.get('key') == 'sesame' and me.get('jam') == 'invite', me)

        async with websockets.connect(f'{URL}/shut') as guest:
            me_g = await hello(guest, 'friend', 'bo', 'sesame')
            ok('the key gets you in', me_g.get('t') == 'me', me_g)
            ok("but the key is the owner's to hand out, not everyone's to read", me_g.get('key') is None, me_g)

            # an invite-only room is one nobody is pointed at
            ok('an invite-only session is not listed as live', 'shut' not in live(), live())

        # ── the owner opens it up ──
        await owner.send(json.dumps({'t': 'jam', 'mode': 'open'}))
        said = await drain(owner, 'jam')
        ok('the owner can open the session', said.get('mode') == 'open', said)
        ok('and no key is offered for a room with no door', said.get('key') is None, said)
        ok('an open session is listed as live', 'shut' in live(), live())
        ok('with who is in it', [p['name'] for p in live().get('shut', [])] == ['ana'], live())
        ok('anyone may walk in now', not await turned_away('shut', 'friend'))

        # ── and shuts it again with a fresh key ──
        await owner.send(json.dumps({'t': 'jam', 'mode': 'invite', 'roll': True}))
        rolled = await drain(owner, 'jam')
        ok('shutting it again mints a key', bool(rolled.get('key')), rolled)
        ok('and it is not the old one', rolled.get('key') != 'sesame', rolled)
        ok('the link handed out before has stopped working', await turned_away('shut', 'friend', 'sesame'))
        ok('the new one works', not await turned_away('shut', 'friend', rolled['key']))

        # ── and it is nobody else's switch to throw ──
        async with websockets.connect(f'{URL}/shut') as guest:
            await hello(guest, 'friend', 'bo', rolled['key'])
            await guest.send(json.dumps({'t': 'jam', 'mode': 'open'}))
            await guest.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 1, 'y': 1}))
            await drain(owner, 'at')  # their cursor arrives, so the jam frame was handled first
            ok("a guest cannot open someone else's session", await turned_away('shut', 'third'))

    print('\n' + (f'{len(fails)} failing: {fails}' if fails else 'all good'))


asyncio.run(main())
