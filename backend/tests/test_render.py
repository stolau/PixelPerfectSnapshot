import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from app import create_app, render

REPO_ROOT = Path(__file__).resolve().parents[2]
REHYDRATE_JS = REPO_ROOT / "packages" / "client" / "dist" / "rehydrate.js"


@pytest.fixture(scope="session")
def browser_env():
    """Build the real rehydrate bundle and ensure Chromium is installed."""
    if not REHYDRATE_JS.exists():
        for cmd in (["npm", "ci"], ["npm", "run", "build", "-w", "packages/client"]):
            try:
                subprocess.run(cmd, cwd=REPO_ROOT, check=True)
            except FileNotFoundError as exc:
                raise RuntimeError(
                    f"node/npm is required to build {REHYDRATE_JS} — install Node.js"
                ) from exc
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)


@pytest.fixture
def app(tmp_path):
    return create_app(data_dir=tmp_path)


@pytest.fixture
def client(app):
    return app.test_client()


def make_snapshot(name: str, background: str) -> dict:
    # The background color lives ONLY in the external stylesheet; the network is
    # aborted during rendering, so seeing it in the screenshot proves the real
    # rehydrate.js injected the captured CSS.
    return {
        "formatVersion": 0,
        "name": name,
        "viewport": {"width": 320, "height": 240},
        "html": (
            "<!DOCTYPE html><html><head>"
            '<link rel="stylesheet" href="http://localhost/main.css">'
            '</head><body><div id="box"></div></body></html>'
        ),
        "stylesheets": [
            {
                "href": "http://localhost/main.css",
                "content": (
                    f"body{{margin:0;background:{background}}}"
                    " #box{width:100px;height:80px;background:#123456}"
                ),
            }
        ],
    }


def create_run(client) -> str:
    response = client.post("/api/runs", json={})
    assert response.status_code == 201
    return response.get_json()["id"]


def upload(client, run_id: str, doc: dict) -> None:
    response = client.post(f"/api/runs/{run_id}/snapshots", json=doc)
    assert response.status_code == 201
    assert response.get_json() == {"name": doc["name"], "status": "pending"}


def process(app) -> list[tuple[str, str, str]]:
    with app.app_context():
        return render.process_pending()


def test_compare_negative_controls(tmp_path):
    identical = tmp_path / "identical.png"
    Image.new("RGB", (50, 50), (10, 20, 30)).save(identical)
    diff_same = tmp_path / "diff-same.png"
    assert render.compare(identical, identical, diff_same, 3, 0.001) is True
    assert diff_same.exists()

    red = tmp_path / "red.png"
    blue = tmp_path / "blue.png"
    Image.new("RGB", (50, 50), (255, 0, 0)).save(red)
    Image.new("RGB", (50, 50), (0, 0, 255)).save(blue)
    diff_out = tmp_path / "diff.png"
    assert render.compare(red, blue, diff_out, 3, 0.001) is False
    diff_img = Image.open(diff_out).convert("RGB")
    assert diff_img.size == (50, 50)
    assert diff_img.getpixel((25, 25)) == (255, 0, 0)  # differing pixels highlighted red


def test_render_no_baseline(browser_env, app, client, tmp_path):
    doc = make_snapshot("page", "#2e7d32")
    run_id = create_run(client)
    upload(client, run_id, doc)

    assert process(app) == [(run_id, "page", "approved-baseline-missing")]

    candidates = list((tmp_path / "images" / run_id).glob("*/candidate.png"))
    assert len(candidates) == 1
    img = Image.open(candidates[0]).convert("RGB")
    assert img.size == (320, 240)
    # Proof the real rehydrate ran: these colors exist only in the stylesheet.
    # (5, 5) is inside the 100x80 #box at the top-left; (200, 200) is the body.
    assert img.getpixel((5, 5)) == (0x12, 0x34, 0x56)
    assert img.getpixel((200, 200)) == (0x2E, 0x7D, 0x32)

    response = client.get(f"/api/runs/{run_id}/snapshots/page")
    assert response.status_code == 200
    assert response.get_json() == {
        "name": "page",
        "viewport": {"width": 320, "height": 240},
        "status": "approved-baseline-missing",
        "baselineUrl": None,
        "candidateUrl": f"/api/runs/{run_id}/snapshots/page/images/candidate",
        "diffUrl": None,
    }

    response = client.get(f"/api/runs/{run_id}/snapshots/page/images/candidate")
    assert response.status_code == 200
    assert response.mimetype == "image/png"

    response = client.get(f"/api/runs/{run_id}/snapshots/page/images/baseline")
    assert response.status_code == 404


def test_approve_then_pass(browser_env, app, client, tmp_path):
    doc = make_snapshot("page", "#2e7d32")
    run_id = create_run(client)
    upload(client, run_id, doc)
    process(app)

    response = client.post(f"/api/runs/{run_id}/snapshots/page/approve")
    assert response.status_code == 200
    assert response.get_json() == {"name": "page", "status": "pass"}
    assert list((tmp_path / "baselines").glob("*.png"))

    response = client.get(f"/api/runs/{run_id}/snapshots/page/images/baseline")
    assert response.status_code == 200
    assert response.mimetype == "image/png"

    response = client.get(f"/api/runs/{run_id}/snapshots/page")
    assert response.get_json()["status"] == "pass"

    # A new run of the same document must now compare against the baseline and pass.
    run_2 = create_run(client)
    upload(client, run_2, doc)
    assert process(app) == [(run_2, "page", "pass")]

    body = client.get(f"/api/runs/{run_2}/snapshots/page").get_json()
    assert body["status"] == "pass"
    assert body["baselineUrl"] == f"/api/runs/{run_2}/snapshots/page/images/baseline"
    assert body["candidateUrl"] == f"/api/runs/{run_2}/snapshots/page/images/candidate"
    assert body["diffUrl"] == f"/api/runs/{run_2}/snapshots/page/images/diff"


def test_visual_regression_fails(browser_env, app, client, tmp_path):
    run_id = create_run(client)
    upload(client, run_id, make_snapshot("page", "#2e7d32"))
    process(app)
    assert client.post(f"/api/runs/{run_id}/snapshots/page/approve").status_code == 200

    run_2 = create_run(client)
    upload(client, run_2, make_snapshot("page", "#b71c1c"))
    assert process(app) == [(run_2, "page", "fail")]

    response = client.get(f"/api/runs/{run_2}/snapshots/page/images/diff")
    assert response.status_code == 200
    assert response.mimetype == "image/png"

    diffs = list((tmp_path / "images" / run_2).glob("*/diff.png"))
    assert len(diffs) == 1
    diff_img = Image.open(diffs[0]).convert("RGB")
    # The body background differs; (200, 200) is outside the unchanged #box.
    assert diff_img.getpixel((200, 200)) == (255, 0, 0)


def test_approve_without_candidate_409(client):
    run_id = create_run(client)
    upload(client, run_id, make_snapshot("page", "#2e7d32"))

    response = client.post(f"/api/runs/{run_id}/snapshots/page/approve")
    assert response.status_code == 409
    assert "error" in response.get_json()


def test_process_pending_cli(app):
    result = app.test_cli_runner().invoke(args=["process-pending"])
    assert result.exit_code == 0
