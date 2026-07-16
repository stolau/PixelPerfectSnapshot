import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
from flask import Blueprint, Response, current_app, jsonify, request

from app.db import get_db

bp = Blueprint("api", __name__, url_prefix="/api")

_DOCS = Path(__file__).resolve().parents[2] / "docs"
_VALIDATOR = jsonschema.Draft202012Validator(
    json.loads((_DOCS / "snapshot.schema.json").read_text())
)


def _error(message: str, status: int) -> tuple[Response, int]:
    return jsonify({"error": message}), status


def _get_run(run_id: str) -> sqlite3.Row | None:
    return get_db().execute(
        "SELECT id, created_at FROM runs WHERE id = ?", (run_id,)
    ).fetchone()


def _get_snapshot(run_id: str, name: str) -> sqlite3.Row | None:
    return get_db().execute(
        "SELECT name, viewport_width, viewport_height, status"
        " FROM snapshots WHERE run_id = ? AND name = ?",
        (run_id, name),
    ).fetchone()


@bp.post("/runs")
def create_run() -> tuple[dict[str, str], int]:
    run_id = uuid.uuid4().hex
    created_at = (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    db = get_db()
    db.execute("INSERT INTO runs (id, created_at) VALUES (?, ?)", (run_id, created_at))
    db.commit()
    return {"id": run_id, "createdAt": created_at}, 201


@bp.get("/runs")
def list_runs() -> dict[str, list[dict[str, object]]]:
    rows = get_db().execute(
        "SELECT runs.id, runs.created_at, COUNT(snapshots.id) AS snapshot_count"
        " FROM runs LEFT JOIN snapshots ON snapshots.run_id = runs.id"
        " GROUP BY runs.id ORDER BY runs.rowid DESC"
    ).fetchall()
    return {
        "runs": [
            {"id": row["id"], "createdAt": row["created_at"], "snapshotCount": row["snapshot_count"]}
            for row in rows
        ]
    }


@bp.post("/runs/<run_id>/snapshots")
def upload_snapshot(run_id: str) -> tuple[Response, int] | tuple[dict[str, str], int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _error("request body must be a JSON snapshot document", 400)
    schema_error = next(_VALIDATOR.iter_errors(payload), None)
    if schema_error is not None:
        return _error(schema_error.message, 400)
    db = get_db()
    try:
        cursor = db.execute(
            "INSERT INTO snapshots (run_id, name, viewport_width, viewport_height)"
            " VALUES (?, ?, ?, ?)",
            (run_id, payload["name"], payload["viewport"]["width"], payload["viewport"]["height"]),
        )
    except sqlite3.IntegrityError:
        return _error(f"snapshot named {payload['name']!r} already exists in this run", 409)
    blob_dir = current_app.config["DATA_DIR"] / "blobs" / run_id
    blob_dir.mkdir(parents=True, exist_ok=True)
    (blob_dir / f"{cursor.lastrowid}.json").write_text(json.dumps(payload))
    db.commit()
    return {"name": payload["name"], "status": "pending"}, 201


@bp.get("/runs/<run_id>")
def get_run(run_id: str) -> tuple[Response, int] | dict[str, object]:
    run = _get_run(run_id)
    if run is None:
        return _error("run not found", 404)
    rows = get_db().execute(
        "SELECT name, viewport_width, viewport_height, status"
        " FROM snapshots WHERE run_id = ? ORDER BY id",
        (run_id,),
    ).fetchall()
    return {
        "id": run["id"],
        "createdAt": run["created_at"],
        "snapshots": [
            {
                "name": row["name"],
                "viewport": {"width": row["viewport_width"], "height": row["viewport_height"]},
                "status": row["status"],
            }
            for row in rows
        ],
    }


@bp.get("/runs/<run_id>/snapshots/<name>")
def get_snapshot(run_id: str, name: str) -> tuple[Response, int] | dict[str, object]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    return {
        "name": snapshot["name"],
        "viewport": {
            "width": snapshot["viewport_width"],
            "height": snapshot["viewport_height"],
        },
        "status": snapshot["status"],
        "baselineUrl": None,
        "candidateUrl": None,
        "diffUrl": None,
    }


@bp.get("/runs/<run_id>/snapshots/<name>/images/<any(baseline,candidate,diff):kind>")
def get_image(run_id: str, name: str, kind: str) -> tuple[Response, int]:
    return _error("image not found", 404)


@bp.post("/runs/<run_id>/snapshots/<name>/approve")
def approve_snapshot(run_id: str, name: str) -> tuple[Response, int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    if _get_snapshot(run_id, name) is None:
        return _error("snapshot not found", 404)
    return _error("approve not implemented until the render engine exists", 501)
