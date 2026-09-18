"""Shared Strudel tracks. Mounted at /api/tracks (draft: /preview/api/tracks).

Anyone can browse public tracks and open unlisted ones by link; saving, liking
and forking need a blue wind sign-in. Ownership is keyed on the SSO `sub`.
"""
import hashlib
import json
import secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from incubator_lib import db, db_path, sso_user

router = APIRouter()

MAX_CODE = 100_000
MAX_TITLE = 80
VISIBILITIES = ("public", "unlisted", "private")
SORTS = {
    "new": "t.updated_at DESC",
    "top": "t.likes DESC, t.plays DESC, t.updated_at DESC",
    "opened": "t.plays DESC, t.updated_at DESC",
    "played": "t.plays DESC, t.updated_at DESC",
}

_ready: set = set()


def _conn():
    """A connection for this request's env (draft/live), with the schema in place."""
    conn = db()
    path = str(db_path())
    if path not in _ready:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tracks (
              id TEXT PRIMARY KEY,
              owner_sub TEXT NOT NULL,
              author TEXT NOT NULL,
              title TEXT NOT NULL,
              code TEXT NOT NULL,
              visibility TEXT NOT NULL DEFAULT 'public',
              forked_from TEXT,
              likes INTEGER NOT NULL DEFAULT 0,
              plays INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tracks_owner ON tracks(owner_sub);
            CREATE INDEX IF NOT EXISTS tracks_forked ON tracks(forked_from);
            CREATE INDEX IF NOT EXISTS tracks_vis_updated ON tracks(visibility, updated_at);
            -- every saved version of a track, so a bad save (or a cleared patch) can be undone
            CREATE TABLE IF NOT EXISTS track_versions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              track_id TEXT NOT NULL,
              title TEXT NOT NULL,
              code TEXT NOT NULL,
              saved_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS track_versions_track ON track_versions(track_id, id);
            CREATE TABLE IF NOT EXISTS likes (
              track_id TEXT NOT NULL,
              sub TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (track_id, sub)
            );
            """
        )
        # a public handle for whoever made a track, so "everything by this person" can be
        # asked for without their account id ever leaving the server
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
        # when a copy was taken: where it leaves the track it came from, on its history
        if "forked_at" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN forked_at INTEGER")
            conn.execute("UPDATE tracks SET forked_at = created_at WHERE forked_from IS NOT NULL")
        if "author_id" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN author_id TEXT")
            for row in conn.execute("SELECT DISTINCT owner_sub FROM tracks").fetchall():
                conn.execute("UPDATE tracks SET author_id = ? WHERE owner_sub = ?",
                             (_author_id(row["owner_sub"]), row["owner_sub"]))
            conn.execute("CREATE INDEX IF NOT EXISTS tracks_author ON tracks(author_id)")
        conn.commit()
        _ready.add(path)
    return conn


KEEP_VERSIONS = 60


def _keep_version(conn, track_id):
    """Remember the track as it is now, unless its latest version already has this code."""
    row = conn.execute("SELECT title, code, updated_at FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        return
    last = conn.execute(
        "SELECT code FROM track_versions WHERE track_id = ? ORDER BY id DESC LIMIT 1", (track_id,)
    ).fetchone()
    if last and last["code"] == row["code"]:
        return
    conn.execute(
        "INSERT INTO track_versions (track_id, title, code, saved_at) VALUES (?,?,?,?)",
        (track_id, row["title"], row["code"], row["updated_at"]),
    )
    conn.execute(
        """DELETE FROM track_versions WHERE track_id = ? AND id NOT IN (
             SELECT id FROM track_versions WHERE track_id = ? ORDER BY id DESC LIMIT ?)""",
        (track_id, track_id, KEEP_VERSIONS),
    )


def _summary(code):
    """What's in a version, from its project header: counts to recognise it by."""
    first = code.split("\n", 1)[0]
    if not first.startswith("// @project "):
        return {"kind": "code", "lines": code.count("\n") + 1}
    try:
        p = json.loads(first[len("// @project "):])
    except ValueError:
        return {"kind": "code", "lines": code.count("\n") + 1}
    nodes = [n for n in p.get("nodes", []) if isinstance(n, dict) and n.get("type") != "output"]
    song = p.get("song") or {}
    return {
        "kind": "patch",
        "nodes": len(nodes),
        "effects": sum(len((n.get("data") or {}).get("chain") or []) for n in nodes),
        "patterns": len(p.get("patterns", [])),
        "clips": len([c for c in song.get("clips", []) if not str(c.get("src", "")).startswith("auto:")]),
        "automations": len(song.get("autos", [])),
    }


def _err(msg, status):
    return JSONResponse({"error": msg}, status_code=status)


def _author(user):
    return (user.get("name") or user.get("given_name") or "anon").strip()[:60] or "anon"


def _author_id(sub):
    """A stable public handle for whoever made a track, without showing who they are."""
    return hashlib.sha256(f"lattice:{sub}".encode()).hexdigest()[:12] if sub else ""


PROJECT_MARK = "// @project "
# the clip colours from frontend/src/clipColors.js, in the same order
PALETTE = ["#e4ff1a", "#f2f0e6", "#b9c96a", "#ffb347", "#86d8cc", "#c8a2ff", "#ff8fa3", "#9fb4ff"]


def _color_for(src, colors):
    """A part's colour: the one it was given, or one from its id — as the studio does it."""
    if colors.get(src):
        return str(colors[src])[:24]
    h = 0
    for ch in src:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return PALETTE[h % len(PALETTE)]


def _shape(code):
    """
    A track's arrangement, small enough to send with a listing: where each clip sits, in
    what colour, and how big the song is. Enough to draw the track on a card — a picture of
    this piece of music and no other — and nowhere near enough to play it.
    """
    line = str(code).split("\n", 1)[0]
    if not line.startswith(PROJECT_MARK):
        return None
    try:
        p = json.loads(line[len(PROJECT_MARK):])
    except ValueError:
        return None
    song = p.get("song") or {}
    colors = song.get("colors") or {}
    palette, clips, bars, lanes = [], [], 0.0, 0
    for c in (song.get("clips") or [])[:140]:
        try:
            lane, start, length = int(c["lane"]), float(c["start"]), float(c["len"])
        except (KeyError, TypeError, ValueError):
            continue
        if length <= 0 or lane < 0 or start < 0:
            continue
        src = str(c.get("src") or "")
        colour = _color_for(src, colors)
        if colour not in palette:
            palette.append(colour)
        # 1 marks an automation curve, which is drawn as a line rather than a block
        clips.append([lane, round(start, 3), round(length, 3), palette.index(colour),
                      1 if src.startswith("auto:") else 0])
        bars = max(bars, start + length)
        lanes = max(lanes, lane + 1)
    return {
        "bpm": p.get("bpm"),
        "beats": p.get("beats"),
        "bars": round(bars, 3),
        "lanes": lanes,
        "parts": len(p.get("patterns") or []),
        "nodes": len([n for n in (p.get("nodes") or []) if n.get("type") != "output"]),
        "p": palette,
        "c": clips,
    }


def _public(row, user=None, liked=False, with_code=True):
    t = dict(row)
    t["is_owner"] = bool(user and user.get("sub") == t["owner_sub"])
    t["liked"] = bool(liked)
    t["author_id"] = _author_id(t.get("owner_sub"))
    t.pop("owner_sub", None)
    # what the track looks like, so a list of them can be looked at and not only read
    if t.get("code"):
        t["shape"] = _shape(t["code"])
    if not with_code:
        t.pop("code", None)
    return t


def _validate(body, partial=False):
    out = {}
    if "title" in body or not partial:
        title = str(body.get("title") or "").strip()[:MAX_TITLE]
        out["title"] = title or "untitled"
    if "code" in body or not partial:
        code = body.get("code")
        if not isinstance(code, str) or not code.strip():
            return None, "code is empty"
        if len(code) > MAX_CODE:
            return None, f"code is over {MAX_CODE // 1000} KB"
        out["code"] = code
    if "visibility" in body or not partial:
        vis = body.get("visibility") or "public"
        if vis not in VISIBILITIES:
            return None, "visibility must be public, unlisted or private"
        out["visibility"] = vis
    return out, None


@router.get("")
def list_tracks(request: Request, q: str = "", sort: str = "new", view: str = "explore",
                limit: int = 50, offset: int = 0, author: str = "", remixes_of: str = ""):
    """view: explore (public), mine (all of yours), liked (tracks you liked).

    `author` narrows to one person's public tracks (their handle from _author_id), and
    `remixes_of` to what came out of one track. Both work with any view and sort.
    """
    user = sso_user(request)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    where, params = [], []
    join = ""
    if view == "mine":
        if not user:
            return _err("sign in", 401)
        where.append("t.owner_sub = ?")
        params.append(user["sub"])
    elif view == "liked":
        if not user:
            return _err("sign in", 401)
        join = "JOIN likes lk ON lk.track_id = t.id AND lk.sub = ?"
        params.append(user["sub"])
        where.append("(t.visibility != 'private' OR t.owner_sub = ?)")
        params.append(user["sub"])
    else:
        where.append("t.visibility = 'public'")
    if author.strip():
        where.append("t.author_id = ?")
        params.append(author.strip()[:32])
    if remixes_of.strip():
        where.append("t.forked_from = ?")
        params.append(remixes_of.strip()[:40])
    if q.strip():
        where.append("(t.title LIKE ? OR t.author LIKE ?)")
        like = f"%{q.strip()[:80]}%"
        params += [like, like]
    my_like = "EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.sub = ?)"
    # what it was made from, so a copy can point back to it without a second request
    came_from = "LEFT JOIN tracks par ON par.id = t.forked_from AND par.visibility != 'private'"
    sql = (
        f"SELECT t.*, {my_like} AS my_like, par.title AS parent_title, par.author AS parent_author "
        f"FROM tracks t {join} {came_from} "
        f"WHERE {' AND '.join(where)} ORDER BY {SORTS.get(sort, SORTS['new'])} LIMIT ? OFFSET ?"
    )
    conn = _conn()
    try:
        rows = conn.execute(sql, [user["sub"] if user else ""] + params + [limit + 1, offset]).fetchall()
    finally:
        conn.close()
    more = len(rows) > limit
    def row_out(r):
        keep = {k: r[k] for k in r.keys() if k not in ("my_like", "parent_title", "parent_author")}
        out = _public(keep, user, r["my_like"], with_code=False)
        if r["forked_from"] and r["parent_title"]:
            out["parent"] = {"id": r["forked_from"], "title": r["parent_title"], "author": r["parent_author"]}
        return out

    return {
        "tracks": [row_out(r) for r in rows[:limit]],
        "more": more,
        "offset": offset + min(len(rows), limit),
    }


@router.get("/{track_id}")
def get_track(track_id: str, request: Request):
    user = sso_user(request)
    conn = _conn()
    try:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row or (row["visibility"] == "private" and not (user and user["sub"] == row["owner_sub"])):
            return _err("track not found", 404)
        liked = bool(user) and conn.execute(
            "SELECT 1 FROM likes WHERE track_id = ? AND sub = ?", (track_id, user["sub"])).fetchone() is not None
        parent = None
        if row["forked_from"]:
            p = conn.execute("SELECT id, title, author, visibility FROM tracks WHERE id = ?",
                             (row["forked_from"],)).fetchone()
            if p and p["visibility"] != "private":
                parent = {"id": p["id"], "title": p["title"], "author": p["author"]}
        # what came out of it, so a track can point forward as well as back
        remixes = conn.execute(
            "SELECT COUNT(*) AS n FROM tracks WHERE forked_from = ? AND visibility = 'public'",
            (track_id,)).fetchone()["n"]
    finally:
        conn.close()
    return {**_public(row, user, liked), "parent": parent, "remixes": remixes}


@router.post("")
async def create_track(request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in to save tracks", 401)
    body = await request.json()
    data, error = _validate(body)
    if error:
        return _err(error, 400)
    forked_from = body.get("forked_from") or None
    forked_at = None
    now = int(time.time())
    track_id = secrets.token_urlsafe(6)
    conn = _conn()
    try:
        if forked_from:
            parent = conn.execute("SELECT created_at, updated_at FROM tracks WHERE id = ?",
                                  (forked_from,)).fetchone()
            # the state it was taken from, so the copy can be placed on the parent's history.
            # Branching an older save says when that save was, which is where it belongs on
            # the line; anything outside the parent's own lifetime is ignored.
            forked_at = parent["updated_at"] if parent else None
            asked = body.get("forked_at")
            if parent and isinstance(asked, (int, float)) and parent["created_at"] <= asked <= parent["updated_at"]:
                forked_at = int(asked)
            if not parent:
                forked_from = None
        conn.execute(
            "INSERT INTO tracks (id, owner_sub, author, author_id, title, code, visibility, forked_from, forked_at, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (track_id, user["sub"], _author(user), _author_id(user["sub"]), data["title"], data["code"],
             data["visibility"], forked_from, forked_at or now, now, now),
        )
        _keep_version(conn, track_id)
        conn.commit()
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    finally:
        conn.close()
    return _public(row, user)


@router.put("/{track_id}")
async def update_track(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in", 401)
    data, error = _validate(await request.json(), partial=True)
    if error:
        return _err(error, 400)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            return _err("track not found", 404)
        if row["owner_sub"] != user["sub"]:
            return _err("not your track", 403)
        data["author"] = _author(user)
        data["updated_at"] = int(time.time())
        sets = ", ".join(f"{k} = ?" for k in data)
        _keep_version(conn, track_id)  # the version being replaced (tracks saved before history existed)
        conn.execute(f"UPDATE tracks SET {sets} WHERE id = ?", [*data.values(), track_id])
        _keep_version(conn, track_id)  # and the new one
        conn.commit()
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        liked = conn.execute("SELECT 1 FROM likes WHERE track_id = ? AND sub = ?",
                             (track_id, user["sub"])).fetchone() is not None
    finally:
        conn.close()
    return _public(row, user, liked)


def _readable(conn, track_id, user):
    """
    Who may read a track's history: anyone who may open the track. A shared track's saves
    are part of what was shared — how it got to where it is, and where people left from.
    A private track stays between its owner and them.
    """
    row = conn.execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        return _err("track not found", 404), False
    mine = bool(user and row["owner_sub"] == user["sub"])
    if row["visibility"] == "private" and not mine:
        return _err("track not found", 404), False
    return None, mine


@router.get("/{track_id}/versions")
def list_versions(track_id: str, request: Request):
    """Every save of a track, newest first — the same history the track's page draws."""
    user = sso_user(request)
    conn = _conn()
    try:
        denied, mine = _readable(conn, track_id, user)
        if denied:
            return denied
        if mine:
            _keep_version(conn, track_id)  # a track saved before history existed starts with what it has
            conn.commit()
        rows = conn.execute(
            "SELECT id, title, code, saved_at FROM track_versions WHERE track_id = ? ORDER BY id DESC",
            (track_id,),
        ).fetchall()
    finally:
        conn.close()
    return {"versions": [
        {"id": r["id"], "title": r["title"], "saved_at": r["saved_at"], "size": len(r["code"]), **_summary(r["code"])}
        for r in rows
    ]}


@router.get("/{track_id}/versions/{version_id}")
def get_version(track_id: str, version_id: int, request: Request):
    user = sso_user(request)
    conn = _conn()
    try:
        denied, _mine = _readable(conn, track_id, user)
        if denied:
            return denied
        row = conn.execute(
            "SELECT id, title, code, saved_at FROM track_versions WHERE track_id = ? AND id = ?",
            (track_id, version_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return _err("version not found", 404)
    return dict(row)


@router.delete("/{track_id}")
def delete_track(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in", 401)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            return _err("track not found", 404)
        if row["owner_sub"] != user["sub"]:
            return _err("not your track", 403)
        conn.execute("DELETE FROM likes WHERE track_id = ?", (track_id,))
        conn.execute("DELETE FROM track_versions WHERE track_id = ?", (track_id,))
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/{track_id}/like")
def toggle_like(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in to like tracks", 401)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row or (row["visibility"] == "private" and row["owner_sub"] != user["sub"]):
            return _err("track not found", 404)
        cur = conn.execute("DELETE FROM likes WHERE track_id = ? AND sub = ?", (track_id, user["sub"]))
        liked = cur.rowcount == 0
        if liked:
            conn.execute("INSERT INTO likes (track_id, sub, created_at) VALUES (?,?,?)",
                         (track_id, user["sub"], int(time.time())))
        conn.execute("UPDATE tracks SET likes = (SELECT COUNT(*) FROM likes WHERE track_id = ?) WHERE id = ?",
                     (track_id, track_id))
        conn.commit()
        likes = conn.execute("SELECT likes FROM tracks WHERE id = ?", (track_id,)).fetchone()["likes"]
    finally:
        conn.close()
    return {"liked": liked, "likes": likes}


@router.post("/{track_id}/open")
def count_open(track_id: str, request: Request):
    """Someone took this track into their own hands. Not the owner opening their own work,
    which would only count how much they'd worked on it."""
    user = sso_user(request)
    conn = _conn()
    try:
        conn.execute(
            "UPDATE tracks SET plays = plays + 1 WHERE id = ? AND visibility != 'private' AND owner_sub IS NOT ?",
            (track_id, user["sub"] if user else None),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/{track_id}/play")
def count_play(track_id: str, request: Request):
    """What opening used to be called; kept so an older page still counts."""
    return count_open(track_id, request)
