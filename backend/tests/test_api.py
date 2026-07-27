import json
import re
import sqlite3
from pathlib import Path
from urllib.parse import quote

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
        "category": None,
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
    # A cross-origin browser can't send Authorization unless the preflight explicitly allows it --
    # without this, PPS_API_TOKEN + PPS_ALLOWED_ORIGIN together silently break every authenticated
    # cross-origin request, even though the preflight itself (exempted from the token check) and
    # the actual request (if the header were let through) would both otherwise succeed.
    assert "Authorization" in response.headers["Access-Control-Allow-Headers"]


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


def test_cors_preflight_patch_route(tmp_path, monkeypatch):
    # PATCH is never CORS-safelisted, so it always preflights -- category rename/snapshot-category
    # update are real cross-origin PATCH calls the viewer makes (viewer/src/api.ts).
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com,https://b.example.com")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.options(
        "/api/categories/Example",
        headers={
            "Origin": "https://a.example.com",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "Content-Type, Authorization",
        },
    )
    assert response.headers["Access-Control-Allow-Origin"] == "https://a.example.com"
    assert "PATCH" in response.headers["Access-Control-Allow-Methods"]
    assert "Authorization" in response.headers["Access-Control-Allow-Headers"]


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


# --- mask categories --------------------------------------------------------

CATEGORY = "Example Base"
CATEGORY_URL = quote(CATEGORY, safe="")


def test_upload_snapshot_with_category(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}")
    assert response.get_json()["category"] == CATEGORY


def test_list_categories_empty(client):
    response = client.get("/api/categories")
    assert response.status_code == 200
    assert response.get_json() == {"categories": []}


def test_list_categories_includes_orphaned_mask_only_category(client):
    # A category can have masks with zero currently-tagged snapshots: category_viewport() only
    # requires a snapshot to exist at mask-creation time, not to still carry that category now.
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))
    client.post(f"/api/categories/{CATEGORY_URL}/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})

    # Re-tag the only snapshot away, orphaning the category's mask.
    client.patch(f"/api/runs/{run_id}/snapshots/{example['name']}", json={"category": "Other"})

    response = client.get("/api/categories")
    assert response.status_code == 200
    categories = {c["name"]: c for c in response.get_json()["categories"]}
    assert categories[CATEGORY] == {"name": CATEGORY, "snapshotCount": 0, "maskCount": 1}
    assert categories["Other"] == {"name": "Other", "snapshotCount": 1, "maskCount": 0}


def test_rename_category_cascades_to_snapshots_and_masks(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))
    client.post(f"/api/categories/{CATEGORY_URL}/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})

    response = client.patch(f"/api/categories/{CATEGORY_URL}", json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.get_json() == {"name": "Renamed"}

    assert (
        client.get(f"/api/runs/{run_id}/snapshots/{example['name']}").get_json()["category"]
        == "Renamed"
    )
    renamed_masks = client.get("/api/categories/Renamed/masks").get_json()["masks"]
    assert len(renamed_masks) == 1
    assert {k: v for k, v in renamed_masks[0].items() if k != "id"} == {
        "x": 0, "y": 0, "width": 5, "height": 5,
    }
    assert client.get(f"/api/categories/{CATEGORY_URL}/masks").get_json() == {"masks": []}
    names = {c["name"] for c in client.get("/api/categories").get_json()["categories"]}
    assert "Renamed" in names
    assert CATEGORY not in names


def test_rename_category_to_self_is_not_a_conflict(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.patch(f"/api/categories/{CATEGORY_URL}", json={"name": CATEGORY})
    assert response.status_code == 200


def test_rename_category_conflict_with_different_existing_category_409(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category="Alpha"))
    run_2 = create_run(client)
    upload_snapshot(client, run_2, dict(example, name="other-page", category="Beta"))

    response = client.patch("/api/categories/Alpha", json={"name": "Beta"})
    assert response.status_code == 409
    assert "error" in response.get_json()

    # Neither category was touched by the rejected rename.
    categories = {c["name"] for c in client.get("/api/categories").get_json()["categories"]}
    assert categories == {"Alpha", "Beta"}


def test_rename_category_unknown_404(client):
    response = client.patch("/api/categories/no-such-category", json={"name": "New"})
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_rename_category_validation_400(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    for payload in [{}, {"name": ""}, {"name": 123}, {"name": None}]:
        response = client.patch(f"/api/categories/{CATEGORY_URL}", json=payload)
        assert response.status_code == 400, payload
        assert "error" in response.get_json()


def test_delete_category_refuses_while_snapshot_tagged_409(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.delete(f"/api/categories/{CATEGORY_URL}")
    assert response.status_code == 409
    assert "error" in response.get_json()
    # Untouched: category still resolves.
    assert (
        client.get(f"/api/runs/{run_id}/snapshots/{example['name']}").get_json()["category"]
        == CATEGORY
    )


def test_delete_category_succeeds_once_no_snapshots_tagged(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))
    client.post(f"/api/categories/{CATEGORY_URL}/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})
    client.patch(f"/api/runs/{run_id}/snapshots/{example['name']}", json={"category": None})

    response = client.delete(f"/api/categories/{CATEGORY_URL}")
    assert response.status_code == 204

    names = {c["name"] for c in client.get("/api/categories").get_json()["categories"]}
    assert CATEGORY not in names


def test_delete_category_unknown_404(client):
    response = client.delete("/api/categories/no-such-category")
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_list_categories_distinct_and_sorted(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category="Zeta"))
    run_2 = create_run(client)
    upload_snapshot(client, run_2, dict(example, name="other-page", category="Alpha"))
    run_3 = create_run(client)
    upload_snapshot(client, run_3, dict(example, name="third-page", category="Zeta"))
    run_4 = create_run(client)
    upload_snapshot(client, run_4, dict(example, name="fourth-page"))  # no category

    response = client.get("/api/categories")
    assert response.status_code == 200
    assert response.get_json() == {
        "categories": [
            {"name": "Alpha", "snapshotCount": 1, "maskCount": 0},
            {"name": "Zeta", "snapshotCount": 2, "maskCount": 0},
        ]
    }


def test_upload_snapshot_category_viewport_conflict_400(client):
    example = load_example()  # viewport 1280x720
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category=CATEGORY))

    run_2 = create_run(client)
    conflicting = dict(example, category=CATEGORY, viewport={"width": 640, "height": 480})
    response = client.post(f"/api/runs/{run_2}/snapshots", json=conflicting)
    assert response.status_code == 400
    assert "error" in response.get_json()
    # Rejected snapshot must not have been inserted.
    assert client.get(f"/api/runs/{run_2}").get_json()["snapshots"] == []


def test_upload_snapshot_category_same_viewport_ok(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category=CATEGORY))

    run_2 = create_run(client)
    other_name = dict(example, name="other-page", category=CATEGORY)
    response = client.post(f"/api/runs/{run_2}/snapshots", json=other_name)
    assert response.status_code == 201


def test_patch_snapshot_category(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)

    response = client.patch(
        f"/api/runs/{run_id}/snapshots/{example['name']}", json={"category": CATEGORY}
    )
    assert response.status_code == 200
    assert response.get_json() == {"name": example["name"], "category": CATEGORY}
    assert (
        client.get(f"/api/runs/{run_id}/snapshots/{example['name']}").get_json()["category"]
        == CATEGORY
    )


def test_patch_snapshot_category_clear_to_null(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.patch(f"/api/runs/{run_id}/snapshots/{example['name']}", json={"category": None})
    assert response.status_code == 200
    assert (
        client.get(f"/api/runs/{run_id}/snapshots/{example['name']}").get_json()["category"] is None
    )


def test_patch_snapshot_category_viewport_conflict_400(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category=CATEGORY))

    run_2 = create_run(client)
    upload_snapshot(client, run_2, dict(example, viewport={"width": 640, "height": 480}))

    response = client.patch(f"/api/runs/{run_2}/snapshots/{example['name']}", json={"category": CATEGORY})
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_patch_snapshot_category_self_reassign_not_blocked(client):
    # Re-saving the same category on the snapshot that already established it
    # must not self-block (exclude_snapshot_id must exclude the row being edited).
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.patch(f"/api/runs/{run_id}/snapshots/{example['name']}", json={"category": CATEGORY})
    assert response.status_code == 200


def test_patch_snapshot_category_validation_400(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)

    for payload in [{}, {"category": ""}, {"category": 123}, {"category": True}]:
        response = client.patch(f"/api/runs/{run_id}/snapshots/{example['name']}", json=payload)
        assert response.status_code == 400, payload
        assert "error" in response.get_json()


def test_patch_snapshot_unknown_run_or_snapshot_404(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, example)

    response = client.patch(f"/api/runs/bogus/snapshots/{example['name']}", json={"category": "x"})
    assert response.status_code == 404

    response = client.patch(f"/api/runs/{run_id}/snapshots/no-such-name", json={"category": "x"})
    assert response.status_code == 404


def test_category_mask_create_list_delete(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    response = client.post(
        f"/api/categories/{CATEGORY_URL}/masks", json={"x": 10, "y": 20, "width": 30, "height": 40}
    )
    assert response.status_code == 201
    created = response.get_json()
    assert created == {"id": created["id"], "x": 10, "y": 20, "width": 30, "height": 40}

    response = client.get(f"/api/categories/{CATEGORY_URL}/masks")
    assert response.status_code == 200
    assert response.get_json() == {"masks": [created]}

    response = client.delete(f"/api/categories/{CATEGORY_URL}/masks/{created['id']}")
    assert response.status_code == 204
    assert client.get(f"/api/categories/{CATEGORY_URL}/masks").get_json() == {"masks": []}


def test_category_mask_unknown_category_404(client):
    response = client.post(
        f"/api/categories/{CATEGORY_URL}/masks", json={"x": 0, "y": 0, "width": 10, "height": 10}
    )
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_category_mask_bounds_400(client):
    example = load_example()  # viewport is 1280x720
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))
    url = f"/api/categories/{CATEGORY_URL}/masks"

    response = client.post(url, json={"x": 1270, "y": 0, "width": 20, "height": 10})
    assert response.status_code == 400
    assert "error" in response.get_json()

    # Sanity: a mask that exactly fits the category's established viewport is accepted.
    response = client.post(url, json={"x": 1260, "y": 700, "width": 20, "height": 20})
    assert response.status_code == 201


def test_category_mask_validation_400(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    for payload in INVALID_MASK_PAYLOADS:
        response = client.post(f"/api/categories/{CATEGORY_URL}/masks", json=payload)
        assert response.status_code == 400, payload
        assert "error" in response.get_json()


def test_category_masks_not_leaked_via_global_endpoints(client):
    # Regression test: list_masks/delete_mask must not treat category masks as global,
    # since both share "name IS NULL" and only category now distinguishes them.
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))
    category_mask = client.post(
        f"/api/categories/{CATEGORY_URL}/masks", json={"x": 1, "y": 2, "width": 3, "height": 4}
    ).get_json()

    assert client.get("/api/masks").get_json() == {"masks": []}

    response = client.delete(f"/api/masks/{category_mask['id']}")
    assert response.status_code == 404
    assert client.get(f"/api/categories/{CATEGORY_URL}/masks").get_json()["masks"] == [category_mask]


def test_snapshot_masks_include_category_layer(client):
    example = load_example()
    run_id = create_run(client)
    upload_snapshot(client, run_id, dict(example, category=CATEGORY))

    client.post("/api/masks", json={"x": 0, "y": 0, "width": 5, "height": 5})
    client.post(
        f"/api/runs/{run_id}/snapshots/{example['name']}/masks",
        json={"x": 50, "y": 50, "width": 5, "height": 5},
    )
    client.post(f"/api/categories/{CATEGORY_URL}/masks", json={"x": 100, "y": 100, "width": 5, "height": 5})

    masks = client.get(f"/api/runs/{run_id}/snapshots/{example['name']}/masks").get_json()["masks"]
    assert {"x": 0, "y": 0, "width": 5, "height": 5} in masks
    assert {"x": 50, "y": 50, "width": 5, "height": 5} in masks
    assert {"x": 100, "y": 100, "width": 5, "height": 5} in masks
    assert len(masks) == 3


def test_snapshot_without_category_gets_no_category_masks(client):
    example = load_example()
    run_1 = create_run(client)
    upload_snapshot(client, run_1, dict(example, category=CATEGORY))
    client.post(f"/api/categories/{CATEGORY_URL}/masks", json={"x": 100, "y": 100, "width": 5, "height": 5})

    run_2 = create_run(client)
    upload_snapshot(client, run_2, example)  # same name/viewport, no category

    response = client.get(f"/api/runs/{run_2}/snapshots/{example['name']}/masks")
    assert response.get_json() == {"masks": []}


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


def test_branch_scoped_history_endpoints_read_back_what_approve_wrote(client, tmp_path):
    # Regression test: the two GET history endpoints used to always resolve the UNSCOPED history
    # location, while approve_snapshot() already wrote branch-scoped history to the scoped
    # location -- so a branch's real history was written but could never be read back through the
    # API. This drives both GET endpoints for real, through the run they belong to, rather than
    # asserting on the filesystem directly (test_approve_branch_replace_writes_branch_history_not_master
    # already proves the write side; this proves the read side actually reaches it).
    example = load_example()
    run_1 = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_1, example)
    first_bytes = write_candidate_bytes(tmp_path, run_1, example["name"], (1, 2, 3))
    assert client.post(f"/api/runs/{run_1}/snapshots/{example['name']}/approve").status_code == 200

    run_2 = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_2, example)
    write_candidate_bytes(tmp_path, run_2, example["name"], (4, 5, 6))
    assert client.post(f"/api/runs/{run_2}/snapshots/{example['name']}/approve").status_code == 200

    history = client.get(f"/api/runs/{run_2}/snapshots/{example['name']}/history").get_json()
    assert len(history["history"]) == 1
    timestamp = history["history"][0]["timestamp"]

    image_response = client.get(
        f"/api/runs/{run_2}/snapshots/{example['name']}/history/{timestamp}"
    )
    assert image_response.status_code == 200
    assert image_response.data == first_bytes

    # A master (unscoped) run for the same (name, viewport) key sees no history at all -- proving
    # the branch's history isn't just visible, it's visible from the correct scope only.
    master_run = create_run(client)
    upload_snapshot(client, master_run, example)
    master_history = client.get(f"/api/runs/{master_run}/snapshots/{example['name']}/history")
    assert master_history.get_json() == {"history": []}


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


def set_snapshot_status(tmp_path, run_id: str, name: str, status: str) -> None:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "UPDATE snapshots SET status = ? WHERE run_id = ? AND name = ?",
            (status, run_id, name),
        )
        conn.commit()
    finally:
        conn.close()


def approved_baseline_rows(tmp_path) -> list[tuple]:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        return conn.execute(
            "SELECT name, viewport_width, viewport_height FROM approved_baselines"
        ).fetchall()
    finally:
        conn.close()


def run_by_id(client, run_id: str) -> dict:
    runs = {r["id"]: r for r in client.get("/api/runs").get_json()["runs"]}
    return runs[run_id]


def test_list_runs_status_fail_wins(client):
    run_id = create_run(client)
    example = load_example()
    upload_snapshot(client, run_id, example)
    other = dict(example)
    other["name"] = "second-page"
    upload_snapshot(client, run_id, other)
    set_snapshot_status(client.application.config["DATA_DIR"], run_id, example["name"], "fail")
    set_snapshot_status(client.application.config["DATA_DIR"], run_id, other["name"], "pass")

    assert run_by_id(client, run_id)["status"] == "fail"


def test_list_runs_status_all_pass(client):
    run_id = create_run(client)
    example = load_example()
    upload_snapshot(client, run_id, example)
    set_snapshot_status(client.application.config["DATA_DIR"], run_id, example["name"], "pass")

    assert run_by_id(client, run_id)["status"] == "pass"


def test_list_runs_status_pending_bucket(client):
    run_id = create_run(client)
    example = load_example()
    upload_snapshot(client, run_id, example)
    other = dict(example)
    other["name"] = "second-page"
    upload_snapshot(client, run_id, other)
    set_snapshot_status(
        client.application.config["DATA_DIR"], run_id, other["name"], "approved-baseline-missing"
    )
    # example stays at its default "pending" status.

    assert run_by_id(client, run_id)["status"] == "pending"


def test_list_runs_status_zero_snapshots_is_pending(client):
    run_id = create_run(client)

    assert run_by_id(client, run_id)["status"] == "pending"


def test_approve_upserts_approved_baselines_no_duplicate(client, tmp_path):
    example = load_example()

    run_1 = create_run(client)
    upload_snapshot(client, run_1, example)
    write_candidate_bytes(tmp_path, run_1, example["name"], (10, 20, 30))
    assert client.post(f"/api/runs/{run_1}/snapshots/{example['name']}/approve").status_code == 200
    assert approved_baseline_rows(tmp_path) == [
        (example["name"], example["viewport"]["width"], example["viewport"]["height"])
    ]

    run_2 = create_run(client)
    upload_snapshot(client, run_2, example)
    write_candidate_bytes(tmp_path, run_2, example["name"], (40, 50, 60))
    assert client.post(f"/api/runs/{run_2}/snapshots/{example['name']}/approve").status_code == 200

    assert len(approved_baseline_rows(tmp_path)) == 1


def test_branch_scoped_approve_does_not_write_approved_baselines(client, tmp_path):
    example = load_example()
    run_id = create_scoped_run(client, "branch", "feature-x")
    upload_snapshot(client, run_id, example)
    write_candidate_bytes(tmp_path, run_id, example["name"], (1, 2, 3))

    assert client.post(f"/api/runs/{run_id}/snapshots/{example['name']}/approve").status_code == 200
    assert approved_baseline_rows(tmp_path) == []


def test_list_runs_new_and_removed_counts(client, tmp_path):
    example = load_example()
    other = dict(example)
    other["name"] = "login-page"

    # Run A approves both example and other on master.
    run_a = create_run(client)
    upload_snapshot(client, run_a, example)
    upload_snapshot(client, run_a, other)
    write_candidate_bytes(tmp_path, run_a, example["name"], (1, 1, 1))
    write_candidate_bytes(tmp_path, run_a, other["name"], (2, 2, 2))
    assert client.post(f"/api/runs/{run_a}/snapshots/{example['name']}/approve").status_code == 200
    assert client.post(f"/api/runs/{run_a}/snapshots/{other['name']}/approve").status_code == 200

    # Run B only re-uploads example (still pending; not approved-baseline-missing).
    run_b = create_run(client)
    upload_snapshot(client, run_b, example)

    # Run C uploads a brand-new page with no baseline anywhere.
    run_c = create_run(client)
    new_page = dict(example)
    new_page["name"] = "new-page"
    upload_snapshot(client, run_c, new_page)
    set_snapshot_status(
        client.application.config["DATA_DIR"], run_c, new_page["name"], "approved-baseline-missing"
    )

    assert run_by_id(client, run_a)["removedCount"] == 0
    assert run_by_id(client, run_a)["newCount"] == 0
    assert run_by_id(client, run_b)["removedCount"] == 1  # missing "login-page"
    assert run_by_id(client, run_b)["newCount"] == 0
    assert run_by_id(client, run_c)["newCount"] == 1
    assert run_by_id(client, run_c)["removedCount"] == 2  # neither example nor other covered


def test_list_runs_counts_for_scoped_run_compare_against_master_only(client, tmp_path):
    # MASTER already has one approved baseline.
    example = load_example()
    master_run = create_run(client)
    upload_snapshot(client, master_run, example)
    write_candidate_bytes(tmp_path, master_run, example["name"], (1, 2, 3))
    assert (
        client.post(f"/api/runs/{master_run}/snapshots/{example['name']}/approve").status_code
        == 200
    )

    # A branch-scoped run that doesn't cover that key at all, with its own snapshot flagged
    # approved-baseline-missing (as a real render would set it for a first-time branch key).
    branch_run = create_scoped_run(client, "branch", "feature-x")
    other = dict(example)
    other["name"] = "new-widget"
    upload_snapshot(client, branch_run, other)
    set_snapshot_status(
        client.application.config["DATA_DIR"], branch_run, other["name"], "approved-baseline-missing"
    )

    branch_row = run_by_id(client, branch_run)
    # newCount reflects this run's own snapshot statuses (scope-aware at render time).
    assert branch_row["newCount"] == 1
    # removedCount is intentionally MASTER-only: the example key is approved on master and not
    # covered by this branch run's snapshots, even though this run was never itself compared
    # against master baselines during rendering.
    assert branch_row["removedCount"] == 1


def test_list_runs_includes_scope(client):
    master_run = create_run(client)
    branch_run = create_scoped_run(client, "branch", "feature-x")
    client.post("/api/releases", json={"id": "v1"})
    release_run = create_scoped_run(client, "release", "v1")

    assert run_by_id(client, master_run)["scope"] is None
    assert run_by_id(client, branch_run)["scope"] == {"kind": "branch", "id": "feature-x"}
    assert run_by_id(client, release_run)["scope"] == {"kind": "release", "id": "v1"}


def test_list_branches_empty(client):
    response = client.get("/api/branches")
    assert response.status_code == 200
    assert response.get_json() == {"branches": []}


def test_list_branches_distinct_and_sorted(client):
    create_scoped_run(client, "branch", "zeta")
    create_scoped_run(client, "branch", "alpha")
    create_scoped_run(client, "branch", "zeta")  # second run on the same branch
    create_run(client)  # master run, must not appear

    response = client.get("/api/branches")
    assert response.status_code == 200
    assert response.get_json() == {"branches": ["alpha", "zeta"]}


def test_list_releases_empty(client):
    response = client.get("/api/releases")
    assert response.status_code == 200
    assert response.get_json() == {"releases": []}


def test_list_releases_newest_first(client):
    r1 = client.post("/api/releases", json={"id": "v1"}).get_json()
    r2 = client.post("/api/releases", json={"id": "v2"}).get_json()

    response = client.get("/api/releases")
    assert response.status_code == 200
    assert response.get_json() == {
        "releases": [
            {"id": "v2", "createdAt": r2["createdAt"]},
            {"id": "v1", "createdAt": r1["createdAt"]},
        ]
    }
