import json
import re
from pathlib import Path

import pytest

from app import create_app

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
