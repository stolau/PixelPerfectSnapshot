import hmac
import json
import re
import shutil
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
from flask import Blueprint, Response, current_app, jsonify, request, send_file, url_for

from app.db import get_db
from app.render import (
    applicable_masks,
    baseline_history_dir,
    baseline_history_path,
    baseline_history_path_by_hash,
    category_viewport,
    image_path,
    process_pending,
    scoped_baseline_history_path,
    scoped_baseline_read_path,
    scoped_baseline_write_path,
)

bp = Blueprint("api", __name__, url_prefix="/api")

_DOCS = Path(__file__).resolve().parents[2] / "docs"
_VALIDATOR = jsonschema.Draft202012Validator(
    json.loads((_DOCS / "snapshot.schema.json").read_text())
)


def _error(message: str, status: int) -> tuple[Response, int]:
    return jsonify({"error": message}), status


@bp.before_request
def _require_api_token() -> tuple[Response, int] | None:
    token = current_app.config["API_TOKEN"]
    if token is None or request.method == "OPTIONS":
        return None
    scheme, _, credential = request.headers.get("Authorization", "").partition(" ")
    if scheme != "Bearer" or not credential or not hmac.compare_digest(credential, token):
        return _error("missing or invalid Authorization header", 401)
    return None


def _validate_mask_payload(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return "request body must be a JSON object"
    for key in ("x", "y", "width", "height"):
        value = payload.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            return "x, y, width, height are required integers"
    if payload["x"] < 0 or payload["y"] < 0 or payload["width"] <= 0 or payload["height"] <= 0:
        return "x and y must be non-negative; width and height must be positive"
    return None


_SCOPE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def _validate_scope_id(scope_id: object) -> str | None:
    if not isinstance(scope_id, str) or not scope_id:
        return "scope id must be a non-empty string"
    if scope_id in (".", ".."):
        return "scope id must not be '.' or '..'"
    if not _SCOPE_ID_RE.fullmatch(scope_id):
        return "scope id may only contain letters, digits, '.', '_', '-'"
    return None


def _get_run(run_id: str) -> sqlite3.Row | None:
    return get_db().execute(
        "SELECT id, created_at, scope_kind, scope_id FROM runs WHERE id = ?", (run_id,)
    ).fetchone()


def _get_snapshot(run_id: str, name: str) -> sqlite3.Row | None:
    return get_db().execute(
        "SELECT id, name, viewport_width, viewport_height, status, category"
        " FROM snapshots WHERE run_id = ? AND name = ?",
        (run_id, name),
    ).fetchone()


def _image_file(run: sqlite3.Row, snapshot: sqlite3.Row, kind: str) -> Path:
    data_dir = current_app.config["DATA_DIR"]
    if kind == "baseline":
        return scoped_baseline_read_path(
            data_dir, run["scope_kind"], run["scope_id"],
            snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
        )
    return image_path(data_dir, run["id"], snapshot["id"], kind)


@bp.post("/runs")
def create_run() -> tuple[Response, int] | tuple[dict[str, str], int]:
    payload = request.get_json(silent=True)
    scope_kind = None
    scope_id = None
    if isinstance(payload, dict) and "scope" in payload:
        scope = payload["scope"]
        if not isinstance(scope, dict):
            return _error("scope must be a JSON object", 400)
        scope_kind = scope.get("kind")
        if scope_kind not in ("branch", "release"):
            return _error("scope.kind must be 'branch' or 'release'", 400)
        scope_id = scope.get("id")
        id_error = _validate_scope_id(scope_id)
        if id_error is not None:
            return _error(id_error, 400)
        if scope_kind == "release":
            release = get_db().execute(
                "SELECT id FROM releases WHERE id = ?", (scope_id,)
            ).fetchone()
            if release is None:
                return _error("release not found", 404)
    run_id = uuid.uuid4().hex
    created_at = (
        datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    db = get_db()
    db.execute(
        "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
        (run_id, created_at, scope_kind, scope_id),
    )
    db.commit()
    return {"id": run_id, "createdAt": created_at}, 201


def _run_verdict(snapshot_count: int, fail_count: int, pass_count: int) -> str:
    if fail_count > 0:
        return "fail"
    if snapshot_count > 0 and pass_count == snapshot_count:
        return "pass"
    return "pending"


@bp.get("/runs")
def list_runs() -> dict[str, list[dict[str, object]]]:
    db = get_db()
    rows = db.execute(
        "SELECT runs.id AS id, runs.created_at AS created_at,"
        " runs.scope_kind AS scope_kind, runs.scope_id AS scope_id,"
        " COUNT(snapshots.id) AS snapshot_count,"
        " SUM(CASE WHEN snapshots.status = 'fail' THEN 1 ELSE 0 END) AS fail_count,"
        " SUM(CASE WHEN snapshots.status = 'pass' THEN 1 ELSE 0 END) AS pass_count,"
        " SUM(CASE WHEN snapshots.status = 'approved-baseline-missing' THEN 1 ELSE 0 END)"
        "   AS new_count"
        " FROM runs LEFT JOIN snapshots ON snapshots.run_id = runs.id"
        " GROUP BY runs.id ORDER BY runs.rowid DESC"
    ).fetchall()
    approved_keys = {
        (r["name"], r["viewport_width"], r["viewport_height"])
        for r in db.execute(
            "SELECT name, viewport_width, viewport_height FROM approved_baselines"
        ).fetchall()
    }
    run_keys: dict[str, set[tuple[str, int, int]]] = {}
    for r in db.execute(
        "SELECT run_id, name, viewport_width, viewport_height FROM snapshots"
    ).fetchall():
        run_keys.setdefault(r["run_id"], set()).add(
            (r["name"], r["viewport_width"], r["viewport_height"])
        )
    return {
        "runs": [
            {
                "id": row["id"],
                "createdAt": row["created_at"],
                "scope": (
                    {"kind": row["scope_kind"], "id": row["scope_id"]}
                    if row["scope_kind"] is not None
                    else None
                ),
                "snapshotCount": row["snapshot_count"],
                "status": _run_verdict(row["snapshot_count"], row["fail_count"], row["pass_count"]),
                "newCount": row["new_count"],
                # removedCount always diffs against MASTER's approved_baselines, regardless of
                # this run's own scope (master/branch/release) -- see docs/API.md's removedCount
                # note. Deliberately not scope-aware: doing so would need a second, symmetric
                # reverse-index for branch/release baselines, which is out of scope here.
                "removedCount": len(approved_keys - run_keys.get(row["id"], set())),
            }
            for row in rows
        ]
    }


@bp.get("/branches")
def list_branches() -> dict[str, list[str]]:
    rows = get_db().execute(
        "SELECT DISTINCT scope_id FROM runs WHERE scope_kind = 'branch' ORDER BY scope_id"
    ).fetchall()
    return {"branches": [row["scope_id"] for row in rows]}


@bp.get("/releases")
def list_releases() -> dict[str, list[dict[str, str]]]:
    rows = get_db().execute("SELECT id, created_at FROM releases ORDER BY rowid DESC").fetchall()
    return {"releases": [{"id": row["id"], "createdAt": row["created_at"]} for row in rows]}


@bp.post("/releases")
def create_release() -> tuple[Response, int] | tuple[dict[str, object], int]:
    payload = request.get_json(silent=True)
    release_id = payload.get("id") if isinstance(payload, dict) else None
    id_error = _validate_scope_id(release_id)
    if id_error is not None:
        return _error(id_error, 400)
    db = get_db()
    existing = db.execute("SELECT id FROM releases WHERE id = ?", (release_id,)).fetchone()
    if existing is not None:
        return _error(f"release named {release_id!r} already exists", 409)
    data_dir = current_app.config["DATA_DIR"]
    prior = db.execute("SELECT id FROM releases ORDER BY rowid DESC LIMIT 1").fetchone()
    if prior is None:
        source_dir = data_dir / "baselines"
        seeded_from = "master"
    else:
        source_dir = data_dir / "baselines" / "releases" / prior["id"]
        seeded_from = prior["id"]
    dest_dir = data_dir / "baselines" / "releases" / release_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    file_count = 0
    for source_file in sorted(source_dir.glob("*.png")):
        shutil.copyfile(source_file, dest_dir / source_file.name)
        file_count += 1
    created_at = (
        datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    db.execute("INSERT INTO releases (id, created_at) VALUES (?, ?)", (release_id, created_at))
    db.commit()
    return {
        "id": release_id,
        "createdAt": created_at,
        "seededFrom": seeded_from,
        "fileCount": file_count,
    }, 201


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
    category = payload.get("category")
    db = get_db()
    if category is not None:
        db.execute("BEGIN IMMEDIATE")
    try:
        if category is not None:
            existing = category_viewport(db, category)
            wanted = (payload["viewport"]["width"], payload["viewport"]["height"])
            if existing is not None and existing != wanted:
                db.rollback()
                return _error(
                    f"category {category!r} is already used with viewport"
                    f" {existing[0]}x{existing[1]}",
                    400,
                )
        cursor = db.execute(
            "INSERT INTO snapshots (run_id, name, viewport_width, viewport_height, category)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                run_id, payload["name"],
                payload["viewport"]["width"], payload["viewport"]["height"],
                category,
            ),
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
    run = _get_run(run_id)
    if run is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)

    def image_url(kind: str) -> str | None:
        if not _image_file(run, snapshot, kind).exists():
            return None
        return url_for("api.get_image", run_id=run_id, name=name, kind=kind)

    return {
        "name": snapshot["name"],
        "viewport": {
            "width": snapshot["viewport_width"],
            "height": snapshot["viewport_height"],
        },
        "status": snapshot["status"],
        "category": snapshot["category"],
        "baselineUrl": image_url("baseline"),
        "candidateUrl": image_url("candidate"),
        "diffUrl": image_url("diff"),
    }


@bp.patch("/runs/<run_id>/snapshots/<name>")
def update_snapshot_category(run_id: str, name: str) -> tuple[Response, int] | tuple[dict[str, object], int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "category" not in payload:
        return _error("request body must be a JSON object with a 'category' key", 400)
    category = payload["category"]
    if category is not None and (not isinstance(category, str) or not category):
        return _error("category must be a non-empty string or null", 400)
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    if category is not None:
        existing = category_viewport(db, category, exclude_snapshot_id=snapshot["id"])
        wanted = (snapshot["viewport_width"], snapshot["viewport_height"])
        if existing is not None and existing != wanted:
            db.rollback()
            return _error(
                f"category {category!r} is already used with viewport {existing[0]}x{existing[1]}",
                400,
            )
    db.execute(
        "UPDATE snapshots SET category = ? WHERE run_id = ? AND name = ?",
        (category, run_id, name),
    )
    db.commit()
    return {"name": name, "category": category}, 200


@bp.get("/runs/<run_id>/snapshots/<name>/images/<any(baseline,candidate,diff):kind>")
def get_image(run_id: str, name: str, kind: str) -> Response | tuple[Response, int]:
    run = _get_run(run_id)
    if run is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    path = _image_file(run, snapshot, kind)
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
    run = _get_run(run_id)
    if run is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    candidate = _image_file(run, snapshot, "candidate")
    if not candidate.exists():
        return _error("no candidate image exists yet; snapshot has not been rendered", 409)
    data_dir = current_app.config["DATA_DIR"]
    baseline = scoped_baseline_write_path(
        data_dir, run["scope_kind"], run["scope_id"],
        snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
    )
    baseline.parent.mkdir(parents=True, exist_ok=True)
    if baseline.exists():
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        history_path = scoped_baseline_history_path(
            data_dir, run["scope_kind"], run["scope_id"],
            snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
            timestamp,
        )
        history_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(baseline, history_path)
    shutil.copyfile(candidate, baseline)
    db = get_db()
    if run["scope_kind"] is None:
        # NOTE: POST /api/branches/<id>/merge promotes baselines to master by content hash
        # only (it has no (name, viewport) tuple to work with), so it does not update this
        # index -- GET /api/runs' removedCount can undercount for baselines established via
        # branch merge. Known, deliberately deferred gap (see docs/API.md).
        db.execute(
            "INSERT OR REPLACE INTO approved_baselines (name, viewport_width, viewport_height)"
            " VALUES (?, ?, ?)",
            (snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"]),
        )
    db.execute("UPDATE snapshots SET status = 'pass' WHERE run_id = ? AND name = ?", (run_id, name))
    db.commit()
    return {"name": name, "status": "pass"}, 200


@bp.post("/branches/<branch_id>/merge")
def merge_branch(branch_id: str) -> tuple[Response, int] | tuple[dict[str, object], int]:
    id_error = _validate_scope_id(branch_id)
    if id_error is not None:
        return _error(id_error, 400)
    data_dir = current_app.config["DATA_DIR"]
    branch_dir = data_dir / "baselines" / "branches" / branch_id
    merged = []
    for branch_file in sorted(branch_dir.glob("*.png")):
        key = branch_file.stem
        master_path = data_dir / "baselines" / branch_file.name
        if master_path.exists():
            timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
            history_path = baseline_history_path_by_hash(data_dir, key, timestamp)
            history_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(master_path, history_path)
        master_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(branch_file, master_path)
        merged.append(key)
    return {"merged": merged, "count": len(merged)}, 200


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


@bp.get("/masks")
def list_masks() -> dict[str, list[dict[str, int]]]:
    rows = get_db().execute(
        "SELECT id, x, y, width, height FROM masks"
        " WHERE name IS NULL AND category IS NULL ORDER BY id"
    ).fetchall()
    return {
        "masks": [
            {"id": row["id"], "x": row["x"], "y": row["y"], "width": row["width"], "height": row["height"]}
            for row in rows
        ]
    }


@bp.post("/masks")
def create_mask() -> tuple[Response, int] | tuple[dict[str, int], int]:
    payload = request.get_json(silent=True)
    validation_error = _validate_mask_payload(payload)
    if validation_error is not None:
        return _error(validation_error, 400)
    db = get_db()
    cursor = db.execute(
        "INSERT INTO masks (name, viewport_width, viewport_height, x, y, width, height)"
        " VALUES (NULL, NULL, NULL, ?, ?, ?, ?)",
        (payload["x"], payload["y"], payload["width"], payload["height"]),
    )
    db.commit()
    return {
        "id": cursor.lastrowid,
        "x": payload["x"],
        "y": payload["y"],
        "width": payload["width"],
        "height": payload["height"],
    }, 201


@bp.delete("/masks/<int:mask_id>")
def delete_mask(mask_id: int) -> tuple[Response, int] | tuple[str, int]:
    db = get_db()
    cursor = db.execute(
        "DELETE FROM masks WHERE id = ? AND name IS NULL AND category IS NULL", (mask_id,)
    )
    db.commit()
    if cursor.rowcount == 0:
        return _error("mask not found", 404)
    return "", 204


@bp.get("/runs/<run_id>/snapshots/<name>/masks")
def list_snapshot_masks(run_id: str, name: str) -> tuple[Response, int] | dict[str, object]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    masks = applicable_masks(
        get_db(), snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"],
        snapshot["category"],
    )
    return {
        "masks": [
            {"x": mask[0], "y": mask[1], "width": mask[2], "height": mask[3]} for mask in masks
        ]
    }


@bp.post("/runs/<run_id>/snapshots/<name>/masks")
def create_snapshot_mask(run_id: str, name: str) -> tuple[Response, int] | tuple[dict[str, int], int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    payload = request.get_json(silent=True)
    validation_error = _validate_mask_payload(payload)
    if validation_error is not None:
        return _error(validation_error, 400)
    if (
        payload["x"] + payload["width"] > snapshot["viewport_width"]
        or payload["y"] + payload["height"] > snapshot["viewport_height"]
    ):
        return _error("mask exceeds snapshot viewport bounds", 400)
    db = get_db()
    cursor = db.execute(
        "INSERT INTO masks (name, viewport_width, viewport_height, x, y, width, height)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            snapshot["name"],
            snapshot["viewport_width"],
            snapshot["viewport_height"],
            payload["x"],
            payload["y"],
            payload["width"],
            payload["height"],
        ),
    )
    db.commit()
    return {
        "id": cursor.lastrowid,
        "x": payload["x"],
        "y": payload["y"],
        "width": payload["width"],
        "height": payload["height"],
    }, 201


@bp.delete("/runs/<run_id>/snapshots/<name>/masks/<int:mask_id>")
def delete_snapshot_mask(run_id: str, name: str, mask_id: int) -> tuple[Response, int] | tuple[str, int]:
    if _get_run(run_id) is None:
        return _error("run not found", 404)
    snapshot = _get_snapshot(run_id, name)
    if snapshot is None:
        return _error("snapshot not found", 404)
    db = get_db()
    cursor = db.execute(
        "DELETE FROM masks WHERE id = ? AND name = ? AND viewport_width = ? AND viewport_height = ?",
        (mask_id, snapshot["name"], snapshot["viewport_width"], snapshot["viewport_height"]),
    )
    db.commit()
    if cursor.rowcount == 0:
        return _error("mask not found", 404)
    return "", 204


@bp.get("/categories")
def list_categories() -> dict[str, list[dict[str, object]]]:
    rows = get_db().execute(
        "SELECT category,"
        " (SELECT COUNT(*) FROM snapshots s WHERE s.category = names.category) AS snapshot_count,"
        " (SELECT COUNT(*) FROM masks m WHERE m.category = names.category) AS mask_count"
        " FROM ("
        "   SELECT category FROM snapshots WHERE category IS NOT NULL"
        "   UNION"
        "   SELECT category FROM masks WHERE category IS NOT NULL"
        " ) AS names"
        " ORDER BY category"
    ).fetchall()
    return {
        "categories": [
            {
                "name": row["category"],
                "snapshotCount": row["snapshot_count"],
                "maskCount": row["mask_count"],
            }
            for row in rows
        ]
    }


def _category_exists(db: sqlite3.Connection, category: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM snapshots WHERE category = ?"
        " UNION SELECT 1 FROM masks WHERE category = ? LIMIT 1",
        (category, category),
    ).fetchone()
    return row is not None


@bp.patch("/categories/<category>")
def rename_category(category: str) -> tuple[Response, int] | tuple[dict[str, str], int]:
    payload = request.get_json(silent=True)
    new_name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(new_name, str) or not new_name:
        return _error("name must be a non-empty string", 400)
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    if not _category_exists(db, category):
        db.rollback()
        return _error(f"category {category!r} not found", 404)
    if new_name != category and _category_exists(db, new_name):
        db.rollback()
        return _error(f"category {new_name!r} already exists", 409)
    db.execute("UPDATE snapshots SET category = ? WHERE category = ?", (new_name, category))
    db.execute("UPDATE masks SET category = ? WHERE category = ?", (new_name, category))
    db.commit()
    return {"name": new_name}, 200


@bp.delete("/categories/<category>")
def delete_category(category: str) -> tuple[Response, int] | tuple[str, int]:
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    if not _category_exists(db, category):
        db.rollback()
        return _error(f"category {category!r} not found", 404)
    snapshot_count = db.execute(
        "SELECT COUNT(*) AS n FROM snapshots WHERE category = ?", (category,)
    ).fetchone()["n"]
    if snapshot_count > 0:
        db.rollback()
        return _error(
            f"cannot delete category {category!r} while {snapshot_count} snapshot(s) are still"
            " tagged with it",
            409,
        )
    db.execute("DELETE FROM masks WHERE category = ?", (category,))
    db.commit()
    return "", 204


@bp.get("/categories/<category>/masks")
def list_category_masks(category: str) -> dict[str, list[dict[str, int]]]:
    rows = get_db().execute(
        "SELECT id, x, y, width, height FROM masks WHERE category = ? ORDER BY id", (category,)
    ).fetchall()
    return {
        "masks": [
            {"id": row["id"], "x": row["x"], "y": row["y"], "width": row["width"], "height": row["height"]}
            for row in rows
        ]
    }


@bp.post("/categories/<category>/masks")
def create_category_mask(category: str) -> tuple[Response, int] | tuple[dict[str, int], int]:
    viewport = category_viewport(get_db(), category)
    if viewport is None:
        return _error(f"category {category!r} is not used by any snapshot", 404)
    payload = request.get_json(silent=True)
    validation_error = _validate_mask_payload(payload)
    if validation_error is not None:
        return _error(validation_error, 400)
    width, height = viewport
    if payload["x"] + payload["width"] > width or payload["y"] + payload["height"] > height:
        return _error("mask exceeds category viewport bounds", 400)
    db = get_db()
    cursor = db.execute(
        "INSERT INTO masks (name, viewport_width, viewport_height, category, x, y, width, height)"
        " VALUES (NULL, NULL, NULL, ?, ?, ?, ?, ?)",
        (category, payload["x"], payload["y"], payload["width"], payload["height"]),
    )
    db.commit()
    return {
        "id": cursor.lastrowid,
        "x": payload["x"],
        "y": payload["y"],
        "width": payload["width"],
        "height": payload["height"],
    }, 201


@bp.delete("/categories/<category>/masks/<int:mask_id>")
def delete_category_mask(category: str, mask_id: int) -> tuple[Response, int] | tuple[str, int]:
    db = get_db()
    cursor = db.execute(
        "DELETE FROM masks WHERE id = ? AND category = ?", (mask_id, category)
    )
    db.commit()
    if cursor.rowcount == 0:
        return _error("mask not found", 404)
    return "", 204
