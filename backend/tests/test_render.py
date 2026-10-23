import sqlite3
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
        "category": None,
        "baselineUrl": None,
        "candidateUrl": f"/api/runs/{run_id}/snapshots/page/images/candidate",
        "diffUrl": None,
        "structureDiff": None,
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


def test_approve_preserves_prior_baseline_in_history(browser_env, app, client, tmp_path):
    run_1 = create_run(client)
    upload(client, run_1, make_snapshot("page", "#2e7d32"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    history_dir = tmp_path / "baselines" / "history"
    # No prior baseline existed before the first approve — nothing to preserve yet.
    assert not history_dir.exists() or not list(history_dir.rglob("*.png"))

    baseline_files = list((tmp_path / "baselines").glob("*.png"))
    assert len(baseline_files) == 1
    v1_bytes = baseline_files[0].read_bytes()

    run_2 = create_run(client)
    upload(client, run_2, make_snapshot("page", "#b71c1c"))
    process(app)
    assert client.post(f"/api/runs/{run_2}/snapshots/page/approve").status_code == 200

    v2_bytes = baseline_files[0].read_bytes()
    assert v2_bytes != v1_bytes

    history_files = list(history_dir.rglob("*.png"))
    assert len(history_files) == 1
    assert history_files[0].read_bytes() == v1_bytes


def test_snapshot_history_endpoints(browser_env, app, client, tmp_path):
    run_1 = create_run(client)
    upload(client, run_1, make_snapshot("page", "#2e7d32"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    baseline_files = list((tmp_path / "baselines").glob("*.png"))
    assert len(baseline_files) == 1
    v1_bytes = baseline_files[0].read_bytes()  # will be archived by the 2nd approve

    run_2 = create_run(client)
    upload(client, run_2, make_snapshot("page", "#b71c1c"))
    process(app)
    assert client.post(f"/api/runs/{run_2}/snapshots/page/approve").status_code == 200

    v2_bytes = baseline_files[0].read_bytes()  # will be archived by the 3rd approve
    assert v2_bytes != v1_bytes

    run_3 = create_run(client)
    upload(client, run_3, make_snapshot("page", "#1565c0"))
    process(app)
    assert client.post(f"/api/runs/{run_3}/snapshots/page/approve").status_code == 200

    v3_bytes = baseline_files[0].read_bytes()
    assert v3_bytes not in (v1_bytes, v2_bytes)

    response = client.get(f"/api/runs/{run_3}/snapshots/page/history")
    assert response.status_code == 200
    body = response.get_json()
    timestamps = [entry["timestamp"] for entry in body["history"]]
    assert len(timestamps) == 2
    assert timestamps == sorted(timestamps, reverse=True)  # newest first

    older_ts, newer_ts = sorted(timestamps)
    history_dir = tmp_path / "baselines" / "history"
    history_files = list(history_dir.rglob("*.png"))
    assert len(history_files) == 2
    bytes_by_stem = {p.stem: p.read_bytes() for p in history_files}
    assert bytes_by_stem[older_ts] == v1_bytes  # archived by 2nd approve
    assert bytes_by_stem[newer_ts] == v2_bytes  # archived by 3rd approve

    response = client.get(f"/api/runs/{run_3}/snapshots/page/history/{newer_ts}")
    assert response.status_code == 200
    assert response.mimetype == "image/png"
    assert response.data == v2_bytes

    response = client.get(f"/api/runs/{run_3}/snapshots/page/history/{older_ts}")
    assert response.status_code == 200
    assert response.mimetype == "image/png"
    assert response.data == v1_bytes

    response = client.get(
        f"/api/runs/{run_3}/snapshots/page/history/does-not-exist-timestamp"
    )
    assert response.status_code == 404
    assert "error" in response.get_json()


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


def make_box_snapshot(
    name: str, box_id: str, left: int, top: int, width: int, height: int, color: str
) -> dict:
    return {
        "formatVersion": 0,
        "name": name,
        "viewport": {"width": 320, "height": 240},
        "html": (
            "<!DOCTYPE html><html><head>"
            '<link rel="stylesheet" href="http://localhost/main.css">'
            f'</head><body><div id="{box_id}"></div></body></html>'
        ),
        "stylesheets": [
            {
                "href": "http://localhost/main.css",
                "content": (
                    "body{margin:0;background:#ffffff}"
                    f"#{box_id}{{position:absolute;left:{left}px;top:{top}px;"
                    f"width:{width}px;height:{height}px;background:{color}}}"
                ),
            }
        ],
    }


def insert_mask(
    tmp_path,
    name: str | None,
    viewport_width: int | None,
    viewport_height: int | None,
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "INSERT INTO masks (name, viewport_width, viewport_height, x, y, width, height)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, viewport_width, viewport_height, x, y, width, height),
        )
        conn.commit()
    finally:
        conn.close()


def insert_category_mask(tmp_path, category: str, x: int, y: int, width: int, height: int) -> None:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "INSERT INTO masks (name, viewport_width, viewport_height, category, x, y, width, height)"
            " VALUES (NULL, NULL, NULL, ?, ?, ?, ?, ?)",
            (category, x, y, width, height),
        )
        conn.commit()
    finally:
        conn.close()


def test_mask_covers_region_no_fail(browser_env, app, client, tmp_path):
    # Baseline box is 21x20 at (10,10) — deliberately 1px wider than the 20x20 mask,
    # to discriminate correct inclusive-corner rectangle math from an off-by-one bug.
    run_1 = create_run(client)
    upload(client, run_1, make_box_snapshot("page", "box", 10, 10, 21, 20, "#204060"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    insert_mask(tmp_path, "page", 320, 240, 10, 10, 20, 20)

    run_2 = create_run(client)
    upload(client, run_2, make_box_snapshot("page", "box", 10, 10, 21, 20, "#d02040"))
    assert process(app) == [(run_2, "page", "pass")]

    diffs = list((tmp_path / "images" / run_2).glob("*/diff.png"))
    assert len(diffs) == 1
    diff_img = Image.open(diffs[0]).convert("RGB")
    # Column 30 is the box's real-diff footprint (cols 10-30) but outside the
    # correct mask (cols 10-29) — must stay red. A buggy mask (missing the -1)
    # would incorrectly swallow this column too.
    assert diff_img.getpixel((30, 20)) == (255, 0, 0)
    # Interior of the masked region must not be red.
    assert diff_img.getpixel((20, 20)) != (255, 0, 0)


def test_mask_outside_region_still_fails(browser_env, app, client, tmp_path):
    run_1 = create_run(client)
    upload(client, run_1, make_snapshot("page", "#2e7d32"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    # Mask sits inside the unchanged #box area (top-left 100x80); it does not
    # overlap the differing body background region.
    insert_mask(tmp_path, "page", 320, 240, 0, 0, 50, 50)

    run_2 = create_run(client)
    upload(client, run_2, make_snapshot("page", "#b71c1c"))
    assert process(app) == [(run_2, "page", "fail")]

    diffs = list((tmp_path / "images" / run_2).glob("*/diff.png"))
    diff_img = Image.open(diffs[0]).convert("RGB")
    assert diff_img.getpixel((200, 200)) == (255, 0, 0)


def test_global_mask_applies_to_any_snapshot(browser_env, app, client, tmp_path):
    run_1 = create_run(client)
    upload(client, run_1, make_box_snapshot("page", "box", 10, 10, 20, 20, "#204060"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    # Global mask row: name/viewport are NULL, so it applies to any snapshot.
    insert_mask(tmp_path, None, None, None, 10, 10, 20, 20)

    run_2 = create_run(client)
    upload(client, run_2, make_box_snapshot("page", "box", 10, 10, 20, 20, "#d02040"))
    assert process(app) == [(run_2, "page", "pass")]


def test_global_and_per_image_masks_combine(browser_env, app, client, tmp_path):
    baseline_doc = {
        "formatVersion": 0,
        "name": "page",
        "viewport": {"width": 320, "height": 240},
        "html": (
            "<!DOCTYPE html><html><head>"
            '<link rel="stylesheet" href="http://localhost/main.css">'
            '</head><body><div id="box1"></div><div id="box2"></div></body></html>'
        ),
        "stylesheets": [
            {
                "href": "http://localhost/main.css",
                "content": (
                    "body{margin:0;background:#ffffff}"
                    "#box1{position:absolute;left:10px;top:10px;width:10px;height:10px;"
                    "background:#111111}"
                    "#box2{position:absolute;left:100px;top:100px;width:10px;height:10px;"
                    "background:#222222}"
                ),
            }
        ],
    }
    candidate_doc = {
        **baseline_doc,
        "stylesheets": [
            {
                "href": "http://localhost/main.css",
                "content": (
                    "body{margin:0;background:#ffffff}"
                    "#box1{position:absolute;left:10px;top:10px;width:10px;height:10px;"
                    "background:#eeeeee}"
                    "#box2{position:absolute;left:100px;top:100px;width:10px;height:10px;"
                    "background:#cccccc}"
                ),
            }
        ],
    }

    run_1 = create_run(client)
    upload(client, run_1, baseline_doc)
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    # Without both masks, 200 differing pixels (2x100) exceeds the 0.001 ratio
    # (76.8px) on a 320x240 viewport, so this proves the masks must combine.
    insert_mask(tmp_path, "page", 320, 240, 10, 10, 10, 10)  # per-image mask covers box1
    insert_mask(tmp_path, None, None, None, 100, 100, 10, 10)  # global mask covers box2

    run_2 = create_run(client)
    upload(client, run_2, candidate_doc)
    assert process(app) == [(run_2, "page", "pass")]


def test_category_mask_applies_across_snapshot_names_in_same_category(browser_env, app, client, tmp_path):
    # A category mask, defined once, must suppress the same-position diff on two
    # independently-named snapshots that both carry the category — the whole point
    # of the feature (vs. repeating a per-image mask on each one).
    run_1 = create_run(client)
    upload(client, run_1, dict(make_box_snapshot("page-a", "box", 10, 10, 20, 20, "#204060"), category="Example Base"))
    upload(client, run_1, dict(make_box_snapshot("page-b", "box", 10, 10, 20, 20, "#204060"), category="Example Base"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page-a/approve").status_code == 200
    assert client.post(f"/api/runs/{run_1}/snapshots/page-b/approve").status_code == 200

    insert_category_mask(tmp_path, "Example Base", 10, 10, 20, 20)

    run_2 = create_run(client)
    upload(client, run_2, dict(make_box_snapshot("page-a", "box", 10, 10, 20, 20, "#d02040"), category="Example Base"))
    upload(client, run_2, dict(make_box_snapshot("page-b", "box", 10, 10, 20, 20, "#00ff00"), category="Example Base"))
    results = process(app)
    assert (run_2, "page-a", "pass") in results
    assert (run_2, "page-b", "pass") in results


def test_category_mask_does_not_apply_outside_category(browser_env, app, client, tmp_path):
    run_1 = create_run(client)
    upload(client, run_1, dict(make_box_snapshot("page-c", "box", 10, 10, 20, 20, "#204060"), category="Example Base"))
    upload(client, run_1, make_box_snapshot("page-d", "box", 10, 10, 20, 20, "#204060"))  # no category
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page-c/approve").status_code == 200
    assert client.post(f"/api/runs/{run_1}/snapshots/page-d/approve").status_code == 200

    insert_category_mask(tmp_path, "Example Base", 10, 10, 20, 20)

    run_2 = create_run(client)
    upload(client, run_2, dict(make_box_snapshot("page-c", "box", 10, 10, 20, 20, "#d02040"), category="Example Base"))
    upload(client, run_2, make_box_snapshot("page-d", "box", 10, 10, 20, 20, "#d02040"))  # not in category

    results = process(app)
    assert (run_2, "page-c", "pass") in results
    assert (run_2, "page-d", "fail") in results


def test_http_created_global_mask_suppresses_diff(browser_env, app, client, tmp_path):
    # The box is 20x20 = 400 differing pixels on a 320x240 (76800px) viewport,
    # i.e. a 0.0052 ratio that exceeds the 0.001 max_diff_ratio — so without the
    # mask this run would fail. The mask is created through the real HTTP
    # POST /api/masks endpoint (not inserted directly into the DB), proving the
    # new route actually flows into applicable_masks()/compare().
    run_1 = create_run(client)
    upload(client, run_1, make_box_snapshot("page", "box", 10, 10, 20, 20, "#204060"))
    process(app)
    assert client.post(f"/api/runs/{run_1}/snapshots/page/approve").status_code == 200

    response = client.post("/api/masks", json={"x": 10, "y": 10, "width": 20, "height": 20})
    assert response.status_code == 201

    run_2 = create_run(client)
    upload(client, run_2, make_box_snapshot("page", "box", 10, 10, 20, 20, "#d02040"))
    assert process(app) == [(run_2, "page", "pass")]


def test_masks_check_constraint_rejects_malformed_row(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO masks (name, viewport_width, viewport_height, x, y, width, height)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("page", None, 240, 0, 0, 10, 10),
            )
    finally:
        conn.close()


def test_masks_check_constraint_rejects_name_and_category_both_set(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO masks"
                " (name, viewport_width, viewport_height, category, x, y, width, height)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("page", 320, 240, "Example Base", 0, 0, 10, 10),
            )
    finally:
        conn.close()


def test_approve_without_candidate_409(client):
    run_id = create_run(client)
    upload(client, run_id, make_snapshot("page", "#2e7d32"))

    response = client.post(f"/api/runs/{run_id}/snapshots/page/approve")
    assert response.status_code == 409
    assert "error" in response.get_json()


def test_process_pending_cli(app):
    result = app.test_cli_runner().invoke(args=["process-pending"])
    assert result.exit_code == 0


def test_process_endpoint_renders_run(browser_env, app, client, monkeypatch):
    run_a = create_run(client)
    upload(client, run_a, make_snapshot("page-a", "#2e7d32"))
    run_b = create_run(client)
    upload(client, run_b, make_snapshot("page-b", "#2e7d32"))

    response = client.post(f"/api/runs/{run_a}/process")
    assert response.status_code == 200
    body = response.get_json()
    assert body == client.get(f"/api/runs/{run_a}").get_json()
    assert [s["status"] for s in body["snapshots"]] == ["approved-baseline-missing"]

    # Run-scoped: run B's snapshot must be untouched.
    run_b_body = client.get(f"/api/runs/{run_b}").get_json()
    assert [s["status"] for s in run_b_body["snapshots"]] == ["pending"]

    # Nothing pending in run A anymore: the endpoint must short-circuit before Playwright.
    def explode():
        raise AssertionError("sync_playwright must not be called when nothing is pending")

    monkeypatch.setattr(render, "sync_playwright", explode)
    response = client.post(f"/api/runs/{run_a}/process")
    assert response.status_code == 200
    assert response.get_json() == body


def test_process_endpoint_missing_rehydrate_500(client, monkeypatch, tmp_path):
    run_id = create_run(client)
    upload(client, run_id, make_snapshot("page", "#2e7d32"))
    monkeypatch.setattr(render, "REHYDRATE_JS", tmp_path / "missing" / "rehydrate.js")

    response = client.post(f"/api/runs/{run_id}/process")
    assert response.status_code == 500
    body = response.get_json()
    assert "error" in body
    # Regression guard: the error must not leak the server's filesystem path.
    assert str(tmp_path) not in body["error"]
    assert "rehydrate.js" not in body["error"]
    assert client.get(f"/api/runs/{run_id}/snapshots/page").get_json()["status"] == "pending"


def test_process_pending_cli_all_runs(browser_env, app, client):
    run_a = create_run(client)
    upload(client, run_a, make_snapshot("page-a", "#2e7d32"))
    run_b = create_run(client)
    upload(client, run_b, make_snapshot("page-b", "#2e7d32"))

    result = app.test_cli_runner().invoke(args=["process-pending"])
    assert result.exit_code == 0
    assert f"{run_a}/page-a: approved-baseline-missing" in result.output
    assert f"{run_b}/page-b: approved-baseline-missing" in result.output

    for run_id, name in ((run_a, "page-a"), (run_b, "page-b")):
        status = client.get(f"/api/runs/{run_id}/snapshots/{name}").get_json()["status"]
        assert status != "pending"


def test_concurrent_write_during_processing(browser_env, app, client, tmp_path, monkeypatch):
    # Regression proof for per-snapshot commits: before the fix, process_pending()
    # kept one write transaction open (SQLite RESERVED lock) across the whole render
    # loop, so any other connection writing mid-run failed with "database is locked".
    # Pre-fix this test fails inside the wrapper's INSERT below.
    run_id = create_run(client)
    upload(client, run_id, make_snapshot("one", "#2e7d32"))
    upload(client, run_id, make_snapshot("two", "#b71c1c"))

    real_baseline_path = render.baseline_path
    calls = []

    def baseline_path_with_concurrent_write(data_dir, name, width, height):
        calls.append(name)
        if len(calls) == 2:
            # The first snapshot's UPDATE ran already; its commit must have released
            # the write lock. timeout=0: fail immediately instead of waiting on it.
            conn = sqlite3.connect(tmp_path / "pps.sqlite3", timeout=0)
            try:
                conn.execute(
                    "INSERT INTO runs (id, created_at) VALUES (?, ?)",
                    ("concurrent-run", "2026-01-01T00:00:00Z"),
                )
                conn.commit()
                first = conn.execute(
                    "SELECT status FROM snapshots WHERE run_id = ? AND name = 'one'",
                    (run_id,),
                ).fetchone()[0]
                assert first == "approved-baseline-missing"  # committed per snapshot
            finally:
                conn.close()
        return real_baseline_path(data_dir, name, width, height)

    monkeypatch.setattr(render, "baseline_path", baseline_path_with_concurrent_write)

    response = client.post(f"/api/runs/{run_id}/process")
    assert response.status_code == 200
    assert calls == ["one", "two"]
    statuses = {s["name"]: s["status"] for s in response.get_json()["snapshots"]}
    assert statuses == {"one": "approved-baseline-missing", "two": "approved-baseline-missing"}

    run_ids = [run["id"] for run in client.get("/api/runs").get_json()["runs"]]
    assert "concurrent-run" in run_ids


def insert_scoped_run(tmp_path, run_id: str, scope_kind: str, scope_id: str) -> None:
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
            (run_id, "2026-01-01T00:00:00Z", scope_kind, scope_id),
        )
        conn.commit()
    finally:
        conn.close()


def test_process_pending_branch_scope_prefers_branch_baseline_over_master(
    browser_env, app, client, tmp_path
):
    # Master baseline: approve a run with a RED body — this becomes the master
    # baseline for "page" and would MISMATCH a green candidate.
    master_run = create_run(client)
    upload(client, master_run, make_snapshot("page", "#b71c1c"))
    process(app)
    assert client.post(f"/api/runs/{master_run}/snapshots/page/approve").status_code == 200

    # Render a real GREEN "page" candidate (via a throwaway unscoped run) and use
    # its actual candidate bytes as the branch-scoped baseline, so the branch file
    # is guaranteed to byte-match what the scoped run will render.
    green_run = create_run(client)
    upload(client, green_run, make_snapshot("page", "#2e7d32"))
    process(app)
    green_candidates = list((tmp_path / "images" / green_run).glob("*/candidate.png"))
    assert len(green_candidates) == 1
    green_bytes = green_candidates[0].read_bytes()

    scope_id = "feature-x"
    branch_path = render.scoped_baseline_write_path(tmp_path, "branch", scope_id, "page", 320, 240)
    branch_path.parent.mkdir(parents=True, exist_ok=True)
    branch_path.write_bytes(green_bytes)

    scoped_run_id = "scoped-run-branch"
    insert_scoped_run(tmp_path, scoped_run_id, "branch", scope_id)
    upload(client, scoped_run_id, make_snapshot("page", "#2e7d32"))

    response = client.post(f"/api/runs/{scoped_run_id}/process")
    assert response.status_code == 200
    statuses = {s["name"]: s["status"] for s in response.get_json()["snapshots"]}
    assert statuses == {"page": "pass"}


def test_process_pending_branch_scope_falls_back_to_master_when_no_branch_file(
    browser_env, app, client, tmp_path
):
    # Master baseline matches what the scoped run will render; no branch file
    # is ever written, so process_pending() must fall back to the master path.
    master_run = create_run(client)
    upload(client, master_run, make_snapshot("page", "#2e7d32"))
    process(app)
    assert client.post(f"/api/runs/{master_run}/snapshots/page/approve").status_code == 200

    scope_id = "feature-y"
    scoped_run_id = "scoped-run-fallback"
    insert_scoped_run(tmp_path, scoped_run_id, "branch", scope_id)
    upload(client, scoped_run_id, make_snapshot("page", "#2e7d32"))

    # Sanity: no branch-scoped baseline exists on disk for this scope.
    branch_path = render.scoped_baseline_write_path(tmp_path, "branch", scope_id, "page", 320, 240)
    assert not branch_path.exists()

    response = client.post(f"/api/runs/{scoped_run_id}/process")
    assert response.status_code == 200
    statuses = {s["name"]: s["status"] for s in response.get_json()["snapshots"]}
    assert statuses == {"page": "pass"}


# --- rendered-layout structure (LLM-PPS-8) ----------------------------------


def make_layout_snapshot(name: str, body: str, css: str) -> dict:
    # As make_snapshot: the CSS lives only in the captured stylesheet, so layout seen in the
    # structure comes from the real rehydrated render, not from the html string.
    return {
        "formatVersion": 0,
        "name": name,
        "viewport": {"width": 320, "height": 240},
        "html": (
            "<!DOCTYPE html><html><head>"
            '<link rel="stylesheet" href="http://localhost/main.css">'
            f"</head><body>{body}</body></html>"
        ),
        "stylesheets": [
            {"href": "http://localhost/main.css", "content": "body{margin:0;background:#fff}" + css}
        ],
    }


def create_scoped_run(client, kind: str, scope_id: str) -> str:
    response = client.post("/api/runs", json={"scope": {"kind": kind, "id": scope_id}})
    assert response.status_code == 201
    return response.get_json()["id"]


def approve(client, run_id: str, name: str = "page") -> None:
    assert client.post(f"/api/runs/{run_id}/snapshots/{name}/approve").status_code == 200


def baseline_png(tmp_path, scope_kind=None, scope_id=None, name="page") -> Path:
    return render.scoped_baseline_write_path(tmp_path, scope_kind, scope_id, name, 320, 240)


def run_once(app, client, doc: dict) -> tuple[str, str]:
    run_id = create_run(client)
    upload(client, run_id, doc)
    [(_, _, status)] = process(app)
    return run_id, status


def structure_diff_of(client, run_id: str, name: str = "page"):
    return client.get(f"/api/runs/{run_id}/snapshots/{name}").get_json()["structureDiff"]


def test_structure_never_decides_status(browser_env, app, client, tmp_path):
    # Plant 1: the layout changes (a transparent, empty block moves) but no pixel does.
    invisible = ".ghost{display:block;width:10px;height:10px;margin-top:%s}"
    run_1, _ = run_once(app, client, make_layout_snapshot(
        "page", '<div class="ghost"></div>', invisible % "0px"))
    approve(client, run_1)
    run_2, status = run_once(app, client, make_layout_snapshot(
        "page", '<div class="ghost"></div>', invisible % "30px"))
    assert status == "pass"
    assert structure_diff_of(client, run_2) is None

    # Plant 2: the pixels change (a colour) and the layout does not.
    run_3, _ = run_once(app, client, make_snapshot("other", "#2e7d32"))
    approve(client, run_3, "other")
    run_4, status = run_once(app, client, make_snapshot("other", "#b71c1c"))
    assert status == "fail"
    assert structure_diff_of(client, run_4, "other") == []


def test_structure_diff_only_on_fail(browser_env, app, client, tmp_path):
    run_1, _ = run_once(app, client, make_snapshot("page", "#2e7d32"))
    approve(client, run_1)
    run_2, status = run_once(app, client, make_snapshot("page", "#2e7d32"))
    assert status == "pass"
    assert list((tmp_path / "images" / run_2).glob("*/structure.json"))
    assert not list((tmp_path / "images" / run_2).glob("*/structure-diff.json"))
    assert structure_diff_of(client, run_2) is None


@pytest.mark.parametrize("scope_kind", [None, "branch", "release"])
def test_approve_writes_structure_beside_scoped_baseline(
    browser_env, app, client, tmp_path, scope_kind
):
    scope_id = {None: None, "branch": "feature-s", "release": "v1"}[scope_kind]
    if scope_kind is None:
        run_id = create_run(client)
    else:
        if scope_kind == "release":
            assert client.post("/api/releases", json={"id": scope_id}).status_code == 201
        run_id = create_scoped_run(client, scope_kind, scope_id)
    upload(client, run_id, make_snapshot("page", "#2e7d32"))
    process(app)
    approve(client, run_id)

    png = baseline_png(tmp_path, scope_kind, scope_id)
    structure = render.baseline_structure_path(png)
    assert png.exists() and structure.exists()
    candidate_structure = next((tmp_path / "images" / run_id).glob("*/structure.json"))
    assert structure.read_bytes() == candidate_structure.read_bytes()
    if scope_kind is not None:
        assert not render.baseline_structure_path(baseline_png(tmp_path)).exists()


def test_legacy_baseline_without_structure(browser_env, app, client, tmp_path):
    run_1, _ = run_once(app, client, make_snapshot("page", "#2e7d32"))
    approve(client, run_1)
    render.baseline_structure_path(baseline_png(tmp_path)).unlink()  # approved before LLM-PPS-8

    run_2, status = run_once(app, client, make_snapshot("page", "#b71c1c"))
    assert status == "fail"
    assert structure_diff_of(client, run_2) is None
    assert not list((tmp_path / "images" / run_2).glob("*/structure-diff.json"))


def test_structure_diff_reports_css_only_move(browser_env, app, client, tmp_path):
    body = '<div id="box">Hi</div>'
    css = "#box{width:100px;height:40px;background:#123456;color:#fff;margin-top:%s}"
    first = make_layout_snapshot("page", body, css % "0px")
    second = make_layout_snapshot("page", body, css % "20px")
    assert first["html"] == second["html"]  # only the stylesheet differs

    run_1, _ = run_once(app, client, first)
    approve(client, run_1)
    run_2, status = run_once(app, client, second)
    assert status == "fail"
    assert structure_diff_of(client, run_2) == [
        {
            "path": "body>div:nth-of-type(1)",
            "kind": "moved",
            "before": {"x": 0, "y": 0, "width": 100, "height": 40, "text": "Hi"},
            "after": {"x": 0, "y": 20, "width": 100, "height": 40, "text": "Hi"},
        }
    ]


_KIND_CSS = (
    "div,span{position:absolute;top:0;width:50px;height:20px;background:#123456;color:#fff}"
    ".a{left:0}.b{left:100px}.c{left:200px}"
)
_KIND_BASE = '<div class="a">A</div><div class="b">B</div>'


@pytest.mark.parametrize(
    "kind, body, css, path",
    [
        ("moved", _KIND_BASE, _KIND_CSS + ".b{top:30px}", "body>div:nth-of-type(2)"),
        ("resized", _KIND_BASE, _KIND_CSS + ".b{width:80px}", "body>div:nth-of-type(2)"),
        ("text", '<div class="a">A</div><div class="b">Z</div>', _KIND_CSS, "body>div:nth-of-type(2)"),
        # Inserted before .b: keyed by tag/nth-of-type, .b keeps its path and is not reported.
        (
            "appeared",
            '<div class="a">A</div><span class="c">C</span><div class="b">B</div>',
            _KIND_CSS,
            "body>span:nth-of-type(1)",
        ),
        ("disappeared", '<div class="a">A</div>', _KIND_CSS, "body>div:nth-of-type(2)"),
    ],
)
def test_structure_diff_kinds(browser_env, app, client, tmp_path, kind, body, css, path):
    run_1, _ = run_once(app, client, make_layout_snapshot("page", _KIND_BASE, _KIND_CSS))
    approve(client, run_1)
    run_2, status = run_once(app, client, make_layout_snapshot("page", body, css))
    assert status == "fail"
    diff = structure_diff_of(client, run_2)
    assert [(entry["path"], entry["kind"]) for entry in diff] == [(path, kind)]
    entry = diff[0]
    assert (entry["before"] is None) == (kind == "appeared")
    assert (entry["after"] is None) == (kind == "disappeared")


def test_pass_fills_missing_structure(browser_env, app, client, tmp_path):
    run_1, _ = run_once(app, client, make_snapshot("page", "#2e7d32"))
    approve(client, run_1)
    png = baseline_png(tmp_path)
    structure = render.baseline_structure_path(png)
    structure.unlink()
    png_bytes = png.read_bytes()

    run_2, status = run_once(app, client, make_snapshot("page", "#2e7d32"))
    assert status == "pass"
    assert structure.exists()
    candidate_structure = next((tmp_path / "images" / run_2).glob("*/structure.json"))
    assert structure.read_bytes() == candidate_structure.read_bytes()
    assert png.read_bytes() == png_bytes


def test_pass_does_not_overwrite_existing_structure(browser_env, app, client, tmp_path):
    run_1, _ = run_once(app, client, make_snapshot("page", "#2e7d32"))
    approve(client, run_1)
    structure = render.baseline_structure_path(baseline_png(tmp_path))
    structure.write_text("[]")  # recorded earlier; must survive a pass untouched

    _, status = run_once(app, client, make_snapshot("page", "#2e7d32"))
    assert status == "pass"
    assert structure.read_text() == "[]"


def test_branch_fallback_fill_writes_beside_master_png(browser_env, app, client, tmp_path):
    run_1, _ = run_once(app, client, make_snapshot("page", "#2e7d32"))
    approve(client, run_1)
    master_structure = render.baseline_structure_path(baseline_png(tmp_path))
    master_structure.unlink()

    branch_run = create_scoped_run(client, "branch", "feature-f")
    upload(client, branch_run, make_snapshot("page", "#2e7d32"))
    assert process(app) == [(branch_run, "page", "pass")]
    assert master_structure.exists()
    assert not (tmp_path / "baselines" / "branches" / "feature-f").exists()
