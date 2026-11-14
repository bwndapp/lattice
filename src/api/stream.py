"""A track's stream: what's playing, as data, for anything that wants to follow along
(TouchDesigner, Max, a visualiser, a lighting rig).

The browser playing the track publishes; anything else listens. The server only relays: it
keeps nothing, parses nothing, and a listener that can't keep up loses frames instead of
holding up the others.

    publish   ws  /api/stream/pub/{key}      the browser (one at a time: a new one takes over)
    listen    ws  /api/stream/{key}          anyone holding the key, as many as like
    look      GET /api/stream/{key}/status   is anyone publishing, how many listening

(draft: /preview/api/stream/...). The key is random and long, made in the browser when the
stream is switched on: holding it is what lets you listen. Messages are JSON text frames —
see frontend/src/stream.js for what's in them.
"""

import asyncio
import json
import re

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

router = APIRouter()

KEY = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
QUEUE = 240  # frames a listener may fall behind by (about four seconds) before it starts losing them


class Room:
    def __init__(self):
        self.pub: WebSocket | None = None
        self.subs: dict[WebSocket, asyncio.Queue] = {}


rooms: dict[str, Room] = {}


def _room(key: str) -> Room:
    if not KEY.match(key):
        raise HTTPException(404, "no such stream")
    return rooms.setdefault(key, Room())


def _tidy(key: str):
    room = rooms.get(key)
    if room and room.pub is None and not room.subs:
        rooms.pop(key, None)


def _say(room: Room, text: str):
    for q in room.subs.values():
        if q.full():
            try:
                q.get_nowait()  # the oldest goes: a listener wants now, not four seconds ago
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(text)


@router.get("/{key}/status")
async def status(key: str):
    room = rooms.get(key) if KEY.match(key) else None
    return {"live": bool(room and room.pub), "listeners": len(room.subs) if room else 0}


@router.websocket("/pub/{key}")
async def publish(ws: WebSocket, key: str):
    if not KEY.match(key):
        await ws.close(code=4404)
        return
    await ws.accept()
    room = _room(key)
    old, room.pub = room.pub, ws
    if old is not None:
        try:
            await old.close(code=4409)  # another tab took over
        except Exception:
            pass
    _say(room, json.dumps({"type": "status", "live": True}))
    await ws.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
    try:
        while True:
            text = await ws.receive_text()
            _say(room, text)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if room.pub is ws:
            room.pub = None
            _say(room, json.dumps({"type": "status", "live": False}))
        _tidy(key)


@router.websocket("/{key}")
async def listen(ws: WebSocket, key: str):
    if not KEY.match(key):
        await ws.close(code=4404)
        return
    await ws.accept()
    room = _room(key)
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE)
    room.subs[ws] = q
    await ws.send_text(json.dumps({"type": "status", "live": room.pub is not None}))
    if room.pub is not None:
        try:
            await room.pub.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
        except Exception:
            pass

    async def pump():
        while True:
            await ws.send_text(await q.get())

    async def drain():
        # a listener has nothing to say, but reading is how a closed socket is noticed
        while True:
            await ws.receive_text()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        room.subs.pop(ws, None)
        if room.pub is not None:
            try:
                await room.pub.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
            except Exception:
                pass
        _tidy(key)
