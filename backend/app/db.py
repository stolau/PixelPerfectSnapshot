import sqlite3

from flask import Flask, current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    name TEXT NOT NULL,
    viewport_width INTEGER NOT NULL,
    viewport_height INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE (run_id, name)
);
CREATE TABLE IF NOT EXISTS masks (
    id INTEGER PRIMARY KEY,
    name TEXT,
    viewport_width INTEGER,
    viewport_height INTEGER,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    CHECK ((name IS NULL AND viewport_width IS NULL AND viewport_height IS NULL)
        OR (name IS NOT NULL AND viewport_width IS NOT NULL AND viewport_height IS NOT NULL))
);
"""


def init_app(app: Flask) -> None:
    data_dir = app.config["DATA_DIR"]
    (data_dir / "blobs").mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_dir / "pps.sqlite3")
    connection.executescript(SCHEMA)
    connection.close()
    app.teardown_appcontext(close_db)


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATA_DIR"] / "pps.sqlite3")
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(exc: BaseException | None = None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()
