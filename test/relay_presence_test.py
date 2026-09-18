"""Two peers join a room and watch each other: join, cursor, selection, leave."""
import asyncio
import json

import websockets

URL = 'ws://127.0.0.1:8791/api/collab'


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def main():
    out = []
    async with websockets.connect(f'{URL}/pub') as a:
        await a.send(json.dumps({'t': 'hello', 'token': '', 'name': 'ana'}))
        me_a = await recv(a)
        here_a = await recv(a)
        out.append(('a me', me_a))
        out.append(('a here', here_a))

        async with websockets.connect(f'{URL}/pub') as b:
            await b.send(json.dumps({'t': 'hello', 'token': '', 'name': 'bo'}))
            me_b = await recv(b)
            here_b = await recv(b)
            out.append(('b me', me_b))
            out.append(('b sees on arrival', here_b))
            out.append(('a told of join', await recv(a)))

            await b.send(json.dumps({'t': 'at', 'where': 'graph', 'x': 12.5, 'y': -3}))
            out.append(('a sees cursor', await recv(a)))
            await b.send(json.dumps({'t': 'sel', 'where': 'graph', 'ids': ['n1', 'n2']}))
            out.append(('a sees selection', await recv(a)))

            # which view they're on travels, and is waiting for whoever arrives next: a
            # cursor on a surface you don't have open is a cursor you can't see
            await b.send(json.dumps({'t': 'view', 'v': 'song'}))
            out.append(('a sees which view', await recv(a)))

            async with websockets.connect(f'{URL}/pub') as c:
                await c.send(json.dumps({'t': 'hello', 'token': '', 'name': 'cy'}))
                await recv(c)                   # me
                here_c = await recv(c)          # here: who's about, and where each of them is
                views = {p['name']: p.get('view') for p in here_c['peers']}
                out.append(('c arrives knowing where everyone is', views))
                assert views.get('bo') == 'song', f'a late arrival was not told where bo is: {here_c}'
                await recv(a)                   # a told of c joining
            await recv(a)                       # a told of c leaving

            # b must not hear its own messages back
            await b.send(json.dumps({'t': 'ping'}))
            out.append(('b ping answered', await recv(b)))

        out.append(('a told of leave', await recv(a)))

    # a private track turns a stranger away
    try:
        async with websockets.connect(f'{URL}/priv') as c:
            await c.send(json.dumps({'t': 'hello', 'token': '', 'name': 'nosy'}))
            await recv(c)
            out.append(('private let them in', 'WRONG'))
    except Exception as e:
        out.append(('private refused', type(e).__name__ + ' ' + str(getattr(e, 'code', ''))))

    # a track that doesn't exist has no room
    try:
        async with websockets.connect(f'{URL}/nope') as d:
            await d.send(json.dumps({'t': 'hello', 'token': '', 'name': 'x'}))
            await recv(d)
            out.append(('missing track let them in', 'WRONG'))
    except Exception as e:
        out.append(('missing track refused', type(e).__name__ + ' ' + str(getattr(e, 'code', ''))))

    for label, value in out:
        print(f'{label}: {value}')


asyncio.run(main())
