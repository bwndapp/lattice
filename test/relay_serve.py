"""Run the collab relay on its own port, against a throwaway database and fake sign-ins."""
import importlib.util
import os
import sqlite3
import sys

sys.path.insert(0, '/opt/incubator')
import incubator_lib

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, 't.db')
if os.path.exists(path):
    os.remove(path)
conn = sqlite3.connect(path, check_same_thread=False)
conn.row_factory = sqlite3.Row
conn.execute("CREATE TABLE tracks (id TEXT, owner_sub TEXT, visibility TEXT, collab INTEGER NOT NULL DEFAULT 1,"
             " jam TEXT NOT NULL DEFAULT 'open', jam_key TEXT)")
conn.execute("INSERT INTO tracks VALUES ('pub','someone','public',1,'open',NULL)")
conn.execute("INSERT INTO tracks VALUES ('priv','someone','private',1,'open',NULL)")
conn.execute("INSERT INTO tracks VALUES ('shut','someone','public',1,'invite','sesame')")
conn.commit()
incubator_lib.db = lambda: conn

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src', 'api', 'collab.py')
spec = importlib.util.spec_from_file_location('collab_test', SRC)
collab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collab)
collab.db = incubator_lib.db
# stand-in for the sign-in service: "owner" is the track's owner, anything else is someone else
_people = {'owner': {'sub': 'someone', 'given_name': 'ana'}, 'friend': {'sub': 'other', 'given_name': 'bo'}, 'third': {'sub': 'third', 'given_name': 'cy'}}
collab.sso_user = lambda tok: _people.get(tok, {'sub': f'someone-{tok}', 'given_name': 'someone'} if tok else None)
# (no token at all is a guest: present, but nothing of theirs is taken)

from fastapi import FastAPI
import uvicorn

app = FastAPI()
app.include_router(collab.router, prefix='/api/collab')
uvicorn.run(app, host='127.0.0.1', port=8791, log_level='error')
