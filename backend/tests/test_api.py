import json
import re
import sqlite3
from pathlib import Path

import pytest
from PIL import Image

from app import create_app, render

DOCS = Path(__file__).resolve().parents[2] / "docs"

CREATED_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture
def client(tmp_path):
    return create_app(data_dir=tmp_path).test_client()


def load_example() -> dict:
    return json.loads((DOCS / "examples" / "example-snapshot.json").read_text())


def create_run(client) -> str:
    response = client.post("/api/runs", json={})
    assert response.status_code == 201
    return response.get_json()["id"]


def test_create_run(client):
    response = client.post("/api/runs", json={})
    assert response.status_code == 201
    body = response.get_json()
    assert isinstance(body["id"], str) and body["id"]
    assert CREATED_AT_RE.match(body["createdAt"])

    # Empty body (no JSON at all) must also work per the contract.
    response = client.post("/api/runs")
    assert response.status_code == 201


def test_upload_example_snapshot(client, tmp_path):
    example = load_example()
    run_id = create_run(client)
    response = client.post(f"/api/runs/{run_id}/snapshots", json=example)
    assert response.status_code == 201
    assert response.get_json() == {"name": example["name"], "status": "pending"}

    blobs = list((tmp_path / "blobs" / run_id).glob("*.json"))
    assert len(blobs) == 1
    assert json.loads(blobs[0].read_text()) == example


def test_list_runs_newest_first(client):
    first = create_run(client)
    second = create_run(client)
    response = client.post(f"/api/runs/{first}/snapshots", json=load_example())
    assert response.status_code == 201

    response = client.get("/api/runs")
    assert response.status_code == 200
    runs = response.get_json()["runs"]
    assert [run["id"] for run in runs] == [second, first]
    assert runs[0]["snapshotCount"] == 0
    assert runs[1]["snapshotCount"] == 1
    assert all(CREATED_AT_RE.match(run["createdAt"]) for run in runs)


def test_run_detail_upload_order(client):
    example = load_example()
    renamed = dict(example)
    renamed["name"] = "renamed-page"
    run_id = create_run(client)
    for doc in (example, renamed):
        response = client.post(f"/api/runs/{run_id}/snapshots", json=doc)
        assert response.status_code == 201

    response = client.get(f"/api/runs/{run_id}")
    assert response.status_code == 200
    body = response.get_json()
    assert body["id"] == run_id
    assert CREATED_AT_RE.match(body["createdAt"])
    assert body["snapshots"] == [
        {
            "name": doc["name"],
            "viewport": {
                "width": doc["viewport"]["width"],
                "height": doc["viewport"]["height"],
            },
            "status": "pending",
        }
        for doc in (example, renamed)
    ]


def test_snapshot_detail(client):
    example = load_example()
    run_id = create_run(client)
    client.post(f"/api/runs/{run_id}/snapshots", json=example)

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}")
    assert response.status_code == 200
    assert response.get_json() == {
        "name": example["name"],
        "viewport": example["viewport"],
        "status": "pending",
        "baselineUrl": None,
        "candidateUrl": None,
        "diffUrl": None,
    }


def test_schema_invalid_400(client):
    run_id = create_run(client)

    response = client.post(f"/api/runs/{run_id}/snapshots", json={"formatVersion": 0})
    assert response.status_code == 400
    assert "error" in response.get_json()

    response = client.post(f"/api/runs/{run_id}/snapshots", json=[1, 2, 3])
    assert response.status_code == 400
    assert "error" in response.get_json()

    response = client.post(
        f"/api/runs/{run_id}/snapshots",
        data="not json",
        content_type="application/json",
    )
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_unknown_run_404(client):
    for method, url in [
        ("post", "/api/runs/bogus/snapshots"),
        ("get", "/api/runs/bogus"),
        ("get", "/api/runs/bogus/snapshots/example-page"),
        ("post", "/api/runs/bogus/process"),
        ("get", "/api/runs/bogus/snapshots/example-page/history"),
        ("get", "/api/runs/bogus/snapshots/example-page/history/some-timestamp"),
    ]:
        response = getattr(client, method)(url, json=load_example())
        assert response.status_code == 404
        assert "error" in response.get_json()


def test_unknown_snapshot_404(client):
    run_id = create_run(client)
    for url in [
        f"/api/runs/{run_id}/snapshots/no-such-name",
        f"/api/runs/{run_id}/snapshots/no-such-name/history",
        f"/api/runs/{run_id}/snapshots/no-such-name/history/some-timestamp",
    ]:
        response = client.get(url)
        assert response.status_code == 404
        assert "error" in response.get_json()


def test_snapshot_history_never_approved(client):
    example = load_example()
    run_id = create_run(client)
    client.post(f"/api/runs/{run_id}/snapshots", json=example)

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}/history")
    assert response.status_code == 200
    assert response.get_json() == {"history": []}


def test_duplicate_name_409(client):
    example = load_example()
    run_id = create_run(client)
    assert client.post(f"/api/runs/{run_id}/snapshots", json=example).status_code == 201
    response = client.post(f"/api/runs/{run_id}/snapshots", json=example)
    assert response.status_code == 409
    assert "error" in response.get_json()


def test_approve_409_and_404s(client):
    example = load_example()
    run_id = create_run(client)
    client.post(f"/api/runs/{run_id}/snapshots", json=example)

    # Uploaded but not yet rendered: no candidate PNG exists to promote.
    response = client.post(f"/api/runs/{run_id}/snapshots/{example['name']}/approve")
    assert response.status_code == 409
    assert "error" in response.get_json()

    response = client.post(f"/api/runs/{run_id}/snapshots/no-such-name/approve")
    assert response.status_code == 404
    assert "error" in response.get_json()

    response = client.post(f"/api/runs/bogus/snapshots/{example['name']}/approve")
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_image_404(client):
    example = load_example()
    run_id = create_run(client)
    client.post(f"/api/runs/{run_id}/snapshots", json=example)

    response = client.get(
        f"/api/runs/{run_id}/snapshots/{example['name']}/images/baseline"
    )
    assert response.status_code == 404
    assert "error" in response.get_json()

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}/images/bogus")
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_persistence_across_apps(tmp_path):
    example = load_example()
    client_a = create_app(data_dir=tmp_path).test_client()
    run_id = create_run(client_a)
    assert (
        client_a.post(f"/api/runs/{run_id}/snapshots", json=example).status_code == 201
    )

    client_b = create_app(data_dir=tmp_path).test_client()
    response = client_b.get("/api/runs")
    assert response.status_code == 200
    runs = response.get_json()["runs"]
    assert [run["id"] for run in runs] == [run_id]
    assert runs[0]["snapshotCount"] == 1

    response = client_b.get(f"/api/runs/{run_id}")
    assert response.status_code == 200
    assert [s["name"] for s in response.get_json()["snapshots"]] == [example["name"]]


def test_env_var_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_DATA_DIR", str(tmp_path))
    client = create_app().test_client()
    response = client.post("/api/runs", json={})
    assert response.status_code == 201
    assert (tmp_path / "pps.sqlite3").exists()


def test_upload_too_large_413(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_MAX_UPLOAD_BYTES", "100")
    client = create_app(data_dir=tmp_path).test_client()
    run_id = create_run(client)

    example = load_example()
    assert len(json.dumps(example)) > 100  # sanity: payload exceeds the cap

    response = client.post(f"/api/runs/{run_id}/snapshots", json=example)
    assert response.status_code == 413
    assert response.get_json() == {"error": "request body too large"}


def test_cors_default_off(client):
    response = client.get("/api/health", headers={"Origin": "https://example.com"})
    assert response.status_code == 200
    assert "Access-Control-Allow-Origin" not in response.headers


def test_cors_matching_origin(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com,https://b.example.com")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.get("/api/health", headers={"Origin": "https://b.example.com"})
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "https://b.example.com"


def test_cors_non_matching_origin(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com,https://b.example.com")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert response.status_code == 200
    assert "Access-Control-Allow-Origin" not in response.headers


def test_cors_preflight(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com,https://b.example.com")
    client = create_app(data_dir=tmp_path).test_client()
    run_id = create_run(client)

    response = client.options(
        f"/api/runs/{run_id}/snapshots",
        headers={
            "Origin": "https://a.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert response.headers["Access-Control-Allow-Origin"] == "https://a.example.com"
    assert "POST" in response.headers["Access-Control-Allow-Methods"]
    assert "Content-Type" in response.headers["Access-Control-Allow-Headers"]


def test_cors_preflight_delete_only_route(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com,https://b.example.com")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.options(
        "/api/masks/1",
        headers={
            "Origin": "https://a.example.com",
            "Access-Control-Request-Method": "DELETE",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert response.headers["Access-Control-Allow-Origin"] == "https://a.example.com"
    assert "DELETE" in response.headers["Access-Control-Allow-Methods"]


def upload_snapshot(client, run_id: str, doc: dict) -> None:
    response = client.post(f"/api/runs/{run_id}/snapshots", json=doc)
    assert response.status_code == 201


INVALID_MASK_PAYLOADS = [
    {"x": -1, "y": 0, "width": 10, "height": 10},  # negative x
    {"x": 0, "y": -1, "width": 10, "height": 10},  # negative y
    {"x": 0, "y": 0, "width": 0, "height": 10},  # zero width
    {"x": 0, "y": 0, "width": -5, "height": 10},  # negative width
    {"x": 0, "y": 0, "width": 10, "height": 0},  # zero height
    {"x": 0, "y": 0, "width": 10, "height": -5},  # negative height
    {"x": 0, "y": 0, "width": 10},  # missing height
    {"x": "0", "y": 0, "width": 10, "height": 10},  # string type
    {"x": 0, "y": 0, "width": 10.5, "height": 10},  # float type
    {"x": True, "y": 0, "width": 10, "height": 10},  # bool type
]


def test_global_mask_create_and_list(client):
    response = client.post("/api/masks", json={"x": 10, "y": 20, "width": 30, "height": 40})
    assert response.status_code == 201
    created = response.get_json()
    assert isinstance(created["id"], int)
    assert created == {"id": created["id"], "x": 10, "y": 20, "width": 30, "height": 40}

    response = client.get("/api/masks")
    assert response.status_code == 200
    assert response.get_json() == {"masks": [created]}


def test_snapshot_mask_create_and_list_includes_global(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)

    client.post("/api/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})
    per_image = client.post(
        f"/api/runs/{run_id}/snapshots/{example['name']}/masks",
        json={"x": 100, "y": 100, "width": 10, "height": 10},
    )
    assert per_image.status_code == 201
    per_image_body = per_image.get_json()
    assert isinstance(per_image_body["id"], int)
    assert per_image_body == {
        "id": per_image_body["id"], "x": 100, "y": 100, "width": 10, "height": 10,
    }

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}/masks")
    assert response.status_code == 200
    masks = response.get_json()["masks"]
    assert {"x": 0, "y": 0, "width": 5, "height": 5} in masks
    assert {"x": 100, "y": 100, "width": 10, "height": 10} in masks
    assert len(masks) == 2


def test_snapshot_mask_not_shared_across_different_viewport(client):
    example = load_example()
    other_viewport = dict(example, viewport={"width": 640, "height": 480})

    run_1 = create_run(client)
    upload_snapshot(client, run_1, example)
    run_2 = create_run(client)
    upload_snapshot(client, run_2, other_viewport)

    client.post("/api/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})
    client.post(
        f"/api/runs/{run_1}/snapshots/{example['name']}/masks",
        json={"x": 100, "y": 100, "width": 10, "height": 10},
    )

    response = client.get(f"/api/runs/{run_2}/snapshots/{example['name']}/masks")
    assert response.status_code == 200
    assert response.get_json() == {"masks": [{"x": 0, "y": 0, "width": 5, "height": 5}]}

    response = client.get(f"/api/runs/{run_1}/snapshots/{example['name']}/masks")
    assert response.status_code == 200
    masks = response.get_json()["masks"]
    assert {"x": 0, "y": 0, "width": 5, "height": 5} in masks
    assert {"x": 100, "y": 100, "width": 10, "height": 10} in masks
    assert len(masks) == 2


def test_delete_global_mask(client):
    mask = client.post("/api/masks", json={"x": 1, "y": 2, "width": 3, "height": 4}).get_json()

    response = client.delete(f"/api/masks/{mask['id']}")
    assert response.status_code == 204

    assert client.get("/api/masks").get_json() == {"masks": []}


def test_delete_snapshot_mask(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)
    mask = client.post(
        f"/api/runs/{run_id}/snapshots/{example['name']}/masks",
        json={"x": 1, "y": 2, "width": 3, "height": 4},
    ).get_json()

    response = client.delete(f"/api/runs/{run_id}/snapshots/{example['name']}/masks/{mask['id']}")
    assert response.status_code == 204

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}/masks")
    assert response.get_json() == {"masks": []}


def test_global_mask_validation_400(client):
    for payload in INVALID_MASK_PAYLOADS:
        response = client.post("/api/masks", json=payload)
        assert response.status_code == 400, payload
        assert "error" in response.get_json()


def test_snapshot_mask_validation_400(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)

    for payload in INVALID_MASK_PAYLOADS:
        response = client.post(
            f"/api/runs/{run_id}/snapshots/{example['name']}/masks", json=payload
        )
        assert response.status_code == 400, payload
        assert "error" in response.get_json()


def test_snapshot_mask_bounds_400(client):
    example = load_example()  # viewport is 1280x720
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)
    url = f"/api/runs/{run_id}/snapshots/{example['name']}/masks"

    response = client.post(url, json={"x": 1270, "y": 0, "width": 20, "height": 10})
    assert response.status_code == 400
    assert "error" in response.get_json()

    response = client.post(url, json={"x": 0, "y": 710, "width": 10, "height": 20})
    assert response.status_code == 400
    assert "error" in response.get_json()

    # Sanity: a mask that exactly fits the viewport is accepted.
    response = client.post(url, json={"x": 1260, "y": 700, "width": 20, "height": 20})
    assert response.status_code == 201


def test_mask_delete_cross_scope_404s(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, example)

    global_mask = client.post(
        "/api/masks", json={"x": 1, "y": 1, "width": 2, "height": 2}
    ).get_json()
    per_image = client.post(
        f"/api/runs/{run_1}/snapshots/{example['name']}/masks",
        json={"x": 10, "y": 10, "width": 5, "height": 5},
    ).get_json()

    # A per-image mask id 404s through the global route, and is not deleted.
    response = client.delete(f"/api/masks/{per_image['id']}")
    assert response.status_code == 404
    assert "error" in response.get_json()
    masks = client.get(f"/api/runs/{run_1}/snapshots/{example['name']}/masks").get_json()["masks"]
    assert {"x": 10, "y": 10, "width": 5, "height": 5} in masks

    # A global mask id 404s through the per-image route, and is not deleted.
    response = client.delete(f"/api/runs/{run_1}/snapshots/{example['name']}/masks/{global_mask['id']}")
    assert response.status_code == 404
    assert "error" in response.get_json()
    assert global_mask in client.get("/api/masks").get_json()["masks"]

    # Nonexistent ids 404 on both routes.
    response = client.delete("/api/masks/999999")
    assert response.status_code == 404
    assert "error" in response.get_json()
    response = client.delete(f"/api/runs/{run_1}/snapshots/{example['name']}/masks/999999")
    assert response.status_code == 404
    assert "error" in response.get_json()

    # Wrong snapshot name in the same run: 404, mask untouched.
    other_name = dict(example, name="other-page")
    upload_snapshot(client, run_1, other_name)
    response = client.delete(f"/api/runs/{run_1}/snapshots/other-page/masks/{per_image['id']}")
    assert response.status_code == 404
    assert "error" in response.get_json()
    masks = client.get(f"/api/runs/{run_1}/snapshots/{example['name']}/masks").get_json()["masks"]
    assert {"x": 10, "y": 10, "width": 5, "height": 5} in masks

    # Same name, different viewport, different run: 404, mask untouched.
    run_2 = create_run(client)
    upload_snapshot(client, run_2, dict(example, viewport={"width": 640, "height": 480}))
    response = client.delete(f"/api/runs/{run_2}/snapshots/{example['name']}/masks/{per_image['id']}")
    assert response.status_code == 404
    assert "error" in response.get_json()
    masks = client.get(f"/api/runs/{run_1}/snapshots/{example['name']}/masks").get_json()["masks"]
    assert {"x": 10, "y": 10, "width": 5, "height": 5} in masks


def test_mask_endpoints_unknown_run_404(client):
    example = load_example()
    for method, url in [
        ("get", f"/api/runs/bogus/snapshots/{example['name']}/masks"),
        ("post", f"/api/runs/bogus/snapshots/{example['name']}/masks"),
        ("delete", f"/api/runs/bogus/snapshots/{example['name']}/masks/1"),
    ]:
        response = getattr(client, method)(
            url, json={"x": 0, "y": 0, "width": 10, "height": 10}
        )
        assert response.status_code == 404
        assert "error" in response.get_json()


def test_mask_endpoints_unknown_snapshot_404(client):
    run_id = create_run(client)
    for method, url in [
        ("get", f"/api/runs/{run_id}/snapshots/no-such-name/masks"),
        ("post", f"/api/runs/{run_id}/snapshots/no-such-name/masks"),
        ("delete", f"/api/runs/{run_id}/snapshots/no-such-name/masks/1"),
    ]:
        response = getattr(client, method)(
            url, json={"x": 0, "y": 0, "width": 10, "height": 10}
        )
        assert response.status_code == 404
        assert "error" in response.get_json()


def test_cors_headers_on_413(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_MAX_UPLOAD_BYTES", "100")
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com")
    client = create_app(data_dir=tmp_path).test_client()
    run_id = create_run(client)

    example = load_example()
    assert len(json.dumps(example)) > 100  # sanity: payload exceeds the cap

    response = client.post(
        f"/api/runs/{run_id}/snapshots",
        json=example,
        headers={"Origin": "https://a.example.com"},
    )
    assert response.status_code == 413
    assert response.headers["Access-Control-Allow-Origin"] == "https://a.example.com"


# --- scope-aware runs / branches / releases --------------------------------


def create_scoped_run(client, kind: str, scope_id: str) -> str:
    response = client.post("/api/runs", json={"scope": {"kind": kind, "id": scope_id}})
    assert response.status_code == 201
    return response.get_json()["id"]


def run_scope_row(tmp_path, run_id: str) -> tuple:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        return conn.execute(
            "SELECT scope_kind, scope_id FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
    finally:
        conn.close()


def write_candidate_bytes(tmp_path, run_id: str, name: str, color: tuple[int, int, int]) -> bytes:
    """Place real candidate PNG bytes at the exact path approve_snapshot reads from,
    the same real render.image_path() helper process_pending() uses — without paying
    for a full Playwright render."""
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        snapshot_id = conn.execute(
            "SELECT id FROM snapshots WHERE run_id = ? AND name = ?", (run_id, name)
        ).fetchone()[0]
    finally:
        conn.close()
    path = render.image_path(tmp_path, run_id, snapshot_id, "candidate")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4), color).save(path)
    return path.read_bytes()


def test_create_run_branch_scope(client, tmp_path):
    response = client.post("/api/runs", json={"scope": {"kind": "branch", "id": "feature-x"}})
    assert response.status_code == 201
    run_id = response.get_json()["id"]
    assert run_scope_row(tmp_path, run_id) == ("branch", "feature-x")


def test_create_run_release_scope_existing_release(client, tmp_path):
    assert client.post("/api/releases", json={"id": "v1"}).status_code == 201

    response = client.post("/api/runs", json={"scope": {"kind": "release", "id": "v1"}})
    assert response.status_code == 201
    run_id = response.get_json()["id"]
    assert run_scope_row(tmp_path, run_id) == ("release", "v1")


def test_create_run_release_scope_nonexistent_404(client):
    response = client.post("/api/runs", json={"scope": {"kind": "release", "id": "no-such-release"}})
    assert response.status_code == 404
    assert response.get_json() == {"error": "release not found"}


def test_create_run_invalid_scope_kind_400(client):
    response = client.post("/api/runs", json={"scope": {"kind": "master", "id": "main"}})
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_create_run_invalid_scope_id_400(client):
    response = client.post("/api/runs", json={"scope": {"kind": "branch", "id": "../etc"}})
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_approve_branch_first_time_does_not_touch_master(client, tmp_path):
    # THE CRITICAL TRAP TEST: the first approve on a branch-scoped run must write
    # only the branch's own baseline file. If approve_snapshot ever resolved the
    # "does a baseline already exist?" check via the read-with-fallback path
    # (scoped_baseline_read_path, which falls back to master for branches) instead
    # of the write-scoped path, it would wrongly believe a baseline already existed
    # (master's) and archive a phantom history entry — this proves it does not.
    example = load_example()
    width, height = example["viewport"]["width"], example["viewport"]["height"]
    run_id = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_id, example)
    candidate_bytes = write_candidate_bytes(tmp_path, run_id, example["name"], (10, 20, 30))

    response = client.post(f"/api/runs/{run_id}/snapshots/{example['name']}/approve")
    assert response.status_code == 200

    master_baseline = render.baseline_path(tmp_path, example["name"], width, height)
    assert not master_baseline.exists()

    branch_baseline = render.scoped_baseline_write_path(
        tmp_path, "branch", "feature-x", example["name"], width, height
    )
    assert branch_baseline.exists()
    assert branch_baseline.read_bytes() == candidate_bytes

    master_history = render.baseline_history_dir(tmp_path, example["name"], width, height)
    assert not master_history.exists() or not list(master_history.glob("*.png"))

    branch_history = render.scoped_baseline_history_dir(
        tmp_path, "branch", "feature-x", example["name"], width, height
    )
    assert not branch_history.exists() or not list(branch_history.glob("*.png"))


def test_approve_branch_replace_writes_branch_history_not_master(client, tmp_path):
    example = load_example()
    width, height = example["viewport"]["width"], example["viewport"]["height"]
    run_1 = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_1, example)
    first_bytes = write_candidate_bytes(tmp_path, run_1, example["name"], (1, 2, 3))
    assert client.post(f"/api/runs/{run_1}/snapshots/{example['name']}/approve").status_code == 200

    run_2 = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_2, example)
    second_bytes = write_candidate_bytes(tmp_path, run_2, example["name"], (4, 5, 6))
    assert first_bytes != second_bytes
    assert client.post(f"/api/runs/{run_2}/snapshots/{example['name']}/approve").status_code == 200

    branch_baseline = render.scoped_baseline_write_path(
        tmp_path, "branch", "feature-x", example["name"], width, height
    )
    assert branch_baseline.read_bytes() == second_bytes

    branch_history = render.scoped_baseline_history_dir(
        tmp_path, "branch", "feature-x", example["name"], width, height
    )
    history_files = list(branch_history.glob("*.png"))
    assert len(history_files) == 1
    assert history_files[0].read_bytes() == first_bytes

    master_history = render.baseline_history_dir(tmp_path, example["name"], width, height)
    assert not master_history.exists() or not list(master_history.glob("*.png"))


def test_merge_branch_promotes_files_to_master(client, tmp_path):
    example = load_example()
    width, height = example["viewport"]["width"], example["viewport"]["height"]
    other = dict(example, name="other-page")

    # Case A: a master baseline already exists for "example-page".
    master_run = create_run(client)
    upload_snapshot(client, master_run, example)
    master_original_bytes = write_candidate_bytes(tmp_path, master_run, example["name"], (100, 0, 0))
    assert client.post(f"/api/runs/{master_run}/snapshots/{example['name']}/approve").status_code == 200

    branch_run = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, branch_run, example)
    branch_a_bytes = write_candidate_bytes(tmp_path, branch_run, example["name"], (0, 100, 0))
    assert branch_a_bytes != master_original_bytes
    assert client.post(f"/api/runs/{branch_run}/snapshots/{example['name']}/approve").status_code == 200

    # Case B: no master baseline exists yet for "other-page".
    branch_run_2 = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, branch_run_2, other)
    branch_b_bytes = write_candidate_bytes(tmp_path, branch_run_2, other["name"], (0, 0, 100))
    assert client.post(f"/api/runs/{branch_run_2}/snapshots/{other['name']}/approve").status_code == 200

    master_other_baseline = render.baseline_path(tmp_path, other["name"], width, height)
    assert not master_other_baseline.exists()  # sanity before merge

    response = client.post("/api/branches/feature-x/merge")
    assert response.status_code == 200
    body = response.get_json()
    assert body["count"] == 2
    assert set(body["merged"]) == {
        render.scoped_baseline_write_path(
            tmp_path, "branch", "feature-x", example["name"], width, height
        ).stem,
        render.scoped_baseline_write_path(
            tmp_path, "branch", "feature-x", other["name"], width, height
        ).stem,
    }

    master_example_baseline = render.baseline_path(tmp_path, example["name"], width, height)
    assert master_example_baseline.read_bytes() == branch_a_bytes

    master_example_history = render.baseline_history_dir(tmp_path, example["name"], width, height)
    example_history_files = list(master_example_history.glob("*.png"))
    assert len(example_history_files) == 1
    assert example_history_files[0].read_bytes() == master_original_bytes

    assert master_other_baseline.exists()
    assert master_other_baseline.read_bytes() == branch_b_bytes

    master_other_history = render.baseline_history_dir(tmp_path, other["name"], width, height)
    assert not master_other_history.exists() or not list(master_other_history.glob("*.png"))


def test_merge_empty_branch_returns_zero(client):
    response = client.post("/api/branches/no-such-branch/merge")
    assert response.status_code == 200
    assert response.get_json() == {"merged": [], "count": 0}


def test_merge_invalid_branch_id_400(client):
    response = client.post("/api/branches/bad!id/merge")
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_create_release_seeds_from_master(client, tmp_path):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)
    candidate_bytes = write_candidate_bytes(tmp_path, run_id, example["name"], (10, 20, 30))
    assert client.post(f"/api/runs/{run_id}/snapshots/{example['name']}/approve").status_code == 200

    master_files = list((tmp_path / "baselines").glob("*.png"))
    assert len(master_files) == 1

    response = client.post("/api/releases", json={"id": "v1"})
    assert response.status_code == 201
    body = response.get_json()
    assert body["seededFrom"] == "master"
    assert body["fileCount"] == 1

    release_file = tmp_path / "baselines" / "releases" / "v1" / master_files[0].name
    assert release_file.exists()
    assert release_file.read_bytes() == candidate_bytes


def test_create_release_seeds_from_prior_release_not_current_master(client, tmp_path):
    # THE DIVERGENCE TEST: proves v2 copies from v1's stored content, not whatever
    # master happens to hold at cut time.
    example = load_example()
    width, height = example["viewport"]["width"], example["viewport"]["height"]

    run_1 = create_run(client)
    upload_snapshot(client, run_1, example)
    content_a = write_candidate_bytes(tmp_path, run_1, example["name"], (255, 0, 0))
    assert client.post(f"/api/runs/{run_1}/snapshots/{example['name']}/approve").status_code == 200

    response = client.post("/api/releases", json={"id": "v1"})
    assert response.status_code == 201
    assert response.get_json()["seededFrom"] == "master"

    run_2 = create_run(client)
    upload_snapshot(client, run_2, example)
    content_b = write_candidate_bytes(tmp_path, run_2, example["name"], (0, 255, 0))
    assert content_b != content_a
    assert client.post(f"/api/runs/{run_2}/snapshots/{example['name']}/approve").status_code == 200

    master_baseline = render.baseline_path(tmp_path, example["name"], width, height)
    assert master_baseline.read_bytes() == content_b  # master has diverged since v1 was cut

    response = client.post("/api/releases", json={"id": "v2"})
    assert response.status_code == 201
    body = response.get_json()
    assert body["seededFrom"] == "v1"

    v2_file = tmp_path / "baselines" / "releases" / "v2" / master_baseline.name
    assert v2_file.exists()
    assert v2_file.read_bytes() == content_a  # from v1, explicitly NOT current master


def test_create_release_duplicate_id_409(client):
    assert client.post("/api/releases", json={"id": "v1"}).status_code == 201
    response = client.post("/api/releases", json={"id": "v1"})
    assert response.status_code == 409
    assert "error" in response.get_json()
