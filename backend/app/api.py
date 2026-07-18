import json
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
from flask import Blueprint, Response, current_app, jsonify, request, send_file, url_for

from app.db import get_db
from app.render import baseline_history_dir, baseline_history_path, baseline_path, image_path, process_pending

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
        "SELECT id, name, viewport_width, viewport_height, status"
        " FROM snapshots WHERE run_id = ? AND name = ?",
        (run_id, name),
    ).fetchone()


def _image_file(run_id: str, snapshot: sqlite3.Row, kind: str) -> Path:
    data_dir = current_app.config["DATA_DIR"]
    if kind == "baseline":
        return baseline_path(
            data_dir, snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"]
        )
    return image_path(data_dir, run_id, snapshot["id"], kind)


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

    def image_url(kind: str) -> str | None:
        if not _image_file(run_id, snapshot, kind).exists():
            return None
        return url_for("api.get_image", run_id=run_id, name=name, kind=kind)

    return {
        "name": snapshot["name"],
        "viewport": {
            "width": snapshot["viewport_width"],
            "height": snapshot["viewport_height"],
        },
        "status": snapshot["status"],
        "baselineUrl": image_url("baseline"),
        "candidateUrl": image_url("candidate"),
        "diffUrl": image_url("diff"),
    }


@bp.get("/runs/<run_id>/snapshots/<name>/images/<any(baseline,candidate,diff):kind>")
def get_image(run_id: str, name: str, kind: str) -> Response | tuple[Response, int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    path = _image_file(run_id, snapshot, kind)
    if not path.exists():
        return _error("image not found", 404)
    return send_file(path, mimetype="image/png")


@bp.get("/runs/<run_id>/snapshots/<name>/history")
def get_snapshot_history(run_id: str, name: str) -> tuple[Response, int] | dict[str, object]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    history_dir = baseline_history_dir(
        current_app.config["DATA_DIR"],
        snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
    )
    timestamps = [p.stem for p in history_dir.glob("*.png")] if history_dir.exists() else []
    return {"history": [{"timestamp": ts} for ts in sorted(timestamps, reverse=True)]}


@bp.get("/runs/<run_id>/snapshots/<name>/history/<timestamp>")
def get_snapshot_history_image(run_id: str, name: str, timestamp: str) -> Response | tuple[Response, int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    path = baseline_history_path(
        current_app.config["DATA_DIR"],
        snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
        timestamp,
    )
    if not path.exists():
        return _error("history entry not found", 404)
    return send_file(path, mimetype="image/png")


@bp.post("/runs/<run_id>/snapshots/<name>/approve")
def approve_snapshot(run_id: str, name: str) -> tuple[Response, int] | tuple[dict[str, str], int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    candidate = _image_file(run_id, snapshot, "candidate")
    if not candidate.exists():
        return _error("no candidate image exists yet; snapshot has not been rendered", 409)
    baseline = _image_file(run_id, snapshot, "baseline")
    baseline.parent.mkdir(parents=True, exist_ok=True)
    if baseline.exists():
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        history_path = baseline_history_path(
            current_app.config["DATA_DIR"],
            snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
            timestamp,
        )
        history_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(baseline, history_path)
    shutil.copyfile(candidate, baseline)
    db = get_db()
    db.execute("UPDATE snapshots SET status = 'pass' WHERE run_id = ? AND name = ?", (run_id, name))
    db.commit()
    return {"name": name, "status": "pass"}, 200


@bp.post("/runs/<run_id>/process")
def process_run(run_id: str) -> tuple[Response, int] | dict[str, object]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    try:
        process_pending(run_id)
    except FileNotFoundError:
        current_app.logger.exception("render engine unavailable while processing run %s", run_id)
        return _error("render engine unavailable", 500)
    return get_run(run_id)
