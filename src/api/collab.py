"""Working on a track together: who else is here and where they are.

One websocket per open track, mounted at /api/collab/{track_id} (draft:
/preview/api/collab/{track_id}). The server is a relay: it hands a new peer the list of
who's already here, then passes every message on to the rest of the room. Nothing about a
cursor is stored — presence dies with the connection, which is what makes it cheap.

Messages are JSON text frames.

    → {"t":"hello","token":"<sso access token>","name":"..."}   first frame, always
    → {"t":"at","where":"graph","x":120,"y":40}                 the pointer moved
    → {"t":"sel","where":"graph","ids":["n1","n2"]}             what they have selected
    ← {"t":"me","id":3,"color":"#e8b"}                          who the server thinks you are
    ← {"t":"here","peers":[{"id":1,"name":"ana","color":"#6cf","at":{...},"sel":{...}}]}
    ← {"t":"join","peer":{...}} · {"t":"at","id":1,...} · {"t":"sel","id":1,...} · {"t":"gone","id":1}

Coordinates are the surface's own, not pixels: the patch canvas sends flow x/y, the
timeline sends bars and rows, the piano roll sends bars and midi notes. Whoever draws the
cursor converts, so it lands in the same place at any zoom or scroll.

A private track only lets its owner in; anyone who can open a track can be present on it,
signed in or not (a guest is just a peer without a name).
"""
import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from incubator_lib import db, sso_user

router = APIRouter()

MAX_PEERS = 24          # a room bigger than this isn't a jam, it's a broadcast
MAX_MSG = 4096          # a cursor message is ~80 bytes; anything huge is a mistake
RATE = 60               # messages a second per peer, beyond which we stop listening
COLORS = ["#6cc9ff", "#ff8fb1", "#8de88d", "#ffcf6b", "#c79bff", "#5ee0cf", "#ff9e6b", "#a8b6ff"]


class Peer:
    __slots__ = ("id", "ws", "name", "color", "at", "sel", "sub")

    def __init__(self, pid, ws, name, color, sub):
        self.id = pid
        self.ws = ws
        self.name = name
        self.color = color
        self.sub = sub
        self.at = None
        self.sel = None

    def public(self):
        return {"id": self.id, "name": self.name, "color": self.color, "at": self.at, "sel": self.sel}


class Room:
    """Everyone on one track. Rooms live only as long as someone is in them."""

    def __init__(self):
        self.peers = {}
        self.next_id = 1

    def color_for(self):
        taken = {p.color for p in self.peers.values()}
        for c in COLORS:
            if c not in taken:
                return c
        return COLORS[len(self.peers) % len(COLORS)]

    async def send(self, peer, msg):
        try:
            await peer.ws.send_text(msg)
        except Exception:
            pass  # a dropped connection is cleaned up by its own task

    async def tell_others(self, sender_id, payload):
        msg = json.dumps(payload)
        await asyncio.gather(*(self.send(p, msg) for p in list(self.peers.values()) if p.id != sender_id))


_rooms: dict[str, Room] = {}


def _may_open(track_id, user):
    """(ok, reason). Anyone can join a public or unlisted track; private is the owner's."""
    try:
        row = db().execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
    except Exception:
        return False, "no track"
    if not row:
        return False, "no track"
    if row["visibility"] == "private" and (not user or user.get("sub") != row["owner_sub"]):
        return False, "private"
    return True, None


def _clean_name(raw, user):
    name = (user or {}).get("given_name") or (user or {}).get("name") or (raw or "")
    name = " ".join(str(name).split())[:24]
    return name or "guest"


@router.websocket("/{track_id}")
async def collab(ws: WebSocket, track_id: str):
    await ws.accept()
    peer = None
    room = None
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=10))
        if hello.get("t") != "hello":
            await ws.close(code=4000)
            return
        # verifying a token calls the issuer, so keep it off the event loop
        token = str(hello.get("token") or "")[:4096]
        user = await asyncio.to_thread(sso_user, token) if token else None
        ok, why = await asyncio.to_thread(_may_open, track_id, user)
        if not ok:
            await ws.close(code=4004 if why == "no track" else 4003)
            return
        room = _rooms.setdefault(track_id, Room())
        if len(room.peers) >= MAX_PEERS:
            await ws.close(code=4008)
            return
        peer = Peer(room.next_id, ws, _clean_name(hello.get("name"), user), room.color_for(), (user or {}).get("sub"))
        room.next_id += 1
        await ws.send_text(json.dumps({"t": "me", "id": peer.id, "color": peer.color, "name": peer.name}))
        await ws.send_text(json.dumps({"t": "here", "peers": [p.public() for p in room.peers.values()]}))
        await room.tell_others(peer.id, {"t": "join", "peer": peer.public()})
        room.peers[peer.id] = peer

        window, count = time.monotonic(), 0
        while True:
            raw = await ws.receive_text()
            now = time.monotonic()
            if now - window > 1:
                window, count = now, 0
            count += 1
            if count > RATE or len(raw) > MAX_MSG:
                continue  # too much, too fast: drop it rather than pass it on
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("t")
            if kind == "at":
                peer.at = None if msg.get("where") is None else {"where": msg.get("where"), "x": msg.get("x"), "y": msg.get("y")}
                await room.tell_others(peer.id, {"t": "at", "id": peer.id, **(peer.at or {"where": None})})
            elif kind == "sel":
                ids = [str(i)[:40] for i in (msg.get("ids") or [])][:60]
                peer.sel = {"where": msg.get("where"), "ids": ids} if ids else None
                await room.tell_others(peer.id, {"t": "sel", "id": peer.id, "where": msg.get("where"), "ids": ids})
            elif kind == "ping":
                await ws.send_text('{"t":"pong"}')
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass
    except Exception:
        pass
    finally:
        if room is not None and peer is not None:
            room.peers.pop(peer.id, None)
            await room.tell_others(peer.id, {"t": "gone", "id": peer.id})
            if not room.peers:
                _rooms.pop(track_id, None)
        try:
            await ws.close()
        except Exception:
            pass


@router.get("/{track_id}/who")
async def who(track_id: str):
    """Who's on a track right now, for a page that isn't holding a socket open."""
    room = _rooms.get(track_id)
    return {"peers": [{"name": p.name, "color": p.color} for p in (room.peers.values() if room else [])]}
