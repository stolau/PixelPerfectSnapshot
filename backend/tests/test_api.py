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
    ]:
        response = getattr(client, method)(url, json=load_example())
        assert response.status_code == 404
        assert "error" in response.get_json()


def test_unknown_snapshot_404(client):
    run_id = create_run(client)
    response = client.get(f"/api/runs/{run_id}/snapshots/no-such-name")
    assert response.status_code == 404
    assert "error" in response.get_json()


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
