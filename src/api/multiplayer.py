"""Serve a branch of the app — front and back — at /multiplayer/, beside the live site.

The platform serves exactly two directories (public/ at /, webapp/ at /preview/) and loads
api routes from exactly one folder. A branch needs both of its halves somewhere, and
copying them into the shared folder is how one session quietly overwrites another's work.
So this file is the only thing the branch puts there, and it reaches for everything else
where the branch actually lives — its worktree:

    /multiplayer/            → the branch's build      (BRANCH/multiplayer)
    /multiplayer/api/collab  → the branch's api routes (BRANCH/src/api/*.py)

Point BRANCH at another worktree (or set LATTICE_BRANCH) and you are serving that branch
instead. Nothing here touches the live site, /preview/, or the routes either of them uses;
delete this file and the box is exactly as it was.

The app served here works on the DRAFT's tracks and database, like /preview/ does.

Why it reaches for the app object: a route file only gets to mount things under
/api/<its name>, and a whole app needs a path of its own. The lookup is by the platform's
own /_routes endpoint, so it either finds the running server or does nothing at all.
"""
import importlib.util
import os
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Mount, Route

router = APIRouter()

BRANCH = Path(os.environ.get("LATTICE_BRANCH", "/incubators/incu-strudel/.claude/worktrees/collab-presence"))
BUILD = BRANCH / "multiplayer"          # what `npm run room` writes
ROUTES = BRANCH / "src" / "api"         # the branch's own api routes
MOUNT = "/multiplayer"
SERVE = ("collab",)                     # which of the branch's routes to put up


class FreshStatic(StaticFiles):
    """Never cached: this is a branch being worked on, and a frozen asset at the edge is a
    bug report about something that was fixed an hour ago."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response


def _running_app():
    """The FastAPI app actually serving this box, found by a route only it defines."""
    import sys

    for module in list(sys.modules.values()):
        app = getattr(module, "app", None)
        routes = getattr(getattr(app, "router", None), "routes", None)
        if routes and any(getattr(r, "path", "") == "/_routes" for r in routes):
            return app
    return None


def _load(name):
    """Import one of the branch's route files, under its own name so it can never be
    confused with the copy the draft or live site is running."""
    spec = importlib.util.spec_from_file_location(f"branch_{name}", ROUTES / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mount():
    """Put the branch on the path, replacing an earlier mount of ours if there is one."""
    app = _running_app()
    if app is None or not BUILD.is_dir():
        return []
    ours = {MOUNT} | {f"{MOUNT}/api/{name}" for name in SERVE}
    app.router.routes = [r for r in app.router.routes if getattr(r, "_branch_mount", None) not in ours]
    # (the branch's own columns are made sure of by collab.py, which is the file that
    # actually needs them — the copy of THIS file that runs is the one in the shared route
    # folder, so anything schema-shaped in here would only run for whoever last synced it)
    added, api = [], []
    for name in SERVE:
        try:
            module = _load(name)
        except Exception:
            continue  # a branch mid-edit shouldn't take the rest of it down
        before = len(app.router.routes)
        app.include_router(module.router, prefix=f"{MOUNT}/api/{name}")
        moved = app.router.routes[before:]
        del app.router.routes[before:]
        for r in moved:
            r._branch_mount = f"{MOUNT}/api/{name}"
        api += moved
        added.append(name)
    static = Mount(MOUNT, app=FreshStatic(directory=str(BUILD), html=True), name="branch")
    slash = Route(MOUNT, lambda request: RedirectResponse(url=f"{MOUNT}/", status_code=307), name="branch-slash")
    for r in (static, slash):
        r._branch_mount = MOUNT
    # order matters: the api first, or the directory answers /multiplayer/api/... itself,
    # then the branch's own pages, and only then whatever the box was already serving
    app.router.routes[0:0] = [*api, slash, static]
    return added


MOUNTED = []
try:
    MOUNTED = _mount()
except Exception:
    MOUNTED = []  # trying a branch out is never worth breaking the box for


@router.get("")
async def status():
    """What's being served from the branch, and when it was last built."""
    index = BUILD / "index.html"
    return {
        "branch": str(BRANCH),
        "at": f"{MOUNT}/",
        "serving": MOUNTED,
        "built": int(index.stat().st_mtime) if index.exists() else None,
        "now": int(time.time()),
    }
