import hashlib
import json
from pathlib import Path

from flask import current_app
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

from app.db import get_db

REHYDRATE_JS = Path(__file__).resolve().parents[2] / "packages" / "client" / "dist" / "rehydrate.js"

_SETTLE_CSS = "*{animation:none!important;transition:none!important;caret-color:transparent!important}"
_DOUBLE_RAF = "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"


def baseline_path(data_dir: Path, name: str, width: int, height: int) -> Path:
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return data_dir / "baselines" / f"{key}.png"


def image_path(data_dir: Path, run_id: str, snapshot_id: int, kind: str) -> Path:
    return data_dir / "images" / run_id / str(snapshot_id) / f"{kind}.png"


def compare(
    baseline: Path, candidate: Path, diff_out: Path, pixel_threshold: int, max_diff_ratio: float
) -> bool:
    baseline_img = Image.open(baseline).convert("RGB")
    candidate_img = Image.open(candidate).convert("RGB")
    channels = ImageChops.difference(baseline_img, candidate_img).split()
    max_channel = channels[0]
    for channel in channels[1:]:
        max_channel = ImageChops.lighter(max_channel, channel)
    mask = max_channel.point(lambda v: 255 if v > pixel_threshold else 0)
    differing = mask.histogram()[255]
    white = Image.new("RGB", baseline_img.size, (255, 255, 255))
    background = Image.blend(baseline_img.convert("L").convert("RGB"), white, 0.5)
    red = Image.new("RGB", baseline_img.size, (255, 0, 0))
    diff_out.parent.mkdir(parents=True, exist_ok=True)
    Image.composite(red, background, mask).save(diff_out)
    width, height = baseline_img.size
    return differing / (width * height) <= max_diff_ratio


def process_pending() -> list[tuple[str, str, str]]:
    db = get_db()
    rows = db.execute(
        "SELECT id, run_id, name, viewport_width, viewport_height"
        " FROM snapshots WHERE status = 'pending' ORDER BY id"
    ).fetchall()
    if not rows:
        return []
    if not REHYDRATE_JS.exists():
        raise FileNotFoundError(
            f"missing {REHYDRATE_JS} — build it via"
            " `npm ci && npm run build -w packages/client` at the repo root"
        )
    data_dir = current_app.config["DATA_DIR"]
    results: list[tuple[str, str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for row in rows:
            doc = json.loads(
                (data_dir / "blobs" / row["run_id"] / f"{row['id']}.json").read_text()
            )
            candidate = image_path(data_dir, row["run_id"], row["id"], "candidate")
            candidate.parent.mkdir(parents=True, exist_ok=True)
            context = browser.new_context(
                viewport={"width": row["viewport_width"], "height": row["viewport_height"]},
                device_scale_factor=1,
            )
            page = context.new_page()
            page.route("**/*", lambda route: route.abort())
            page.set_content(doc["html"], wait_until="domcontentloaded")
            page.add_style_tag(content=_SETTLE_CSS)
            page.add_script_tag(path=str(REHYDRATE_JS))
            page.evaluate("s => window.__ppsRehydrate(s)", doc)
            page.evaluate(_DOUBLE_RAF)
            page.screenshot(path=str(candidate))
            context.close()
            baseline = baseline_path(
                data_dir, row["name"], row["viewport_width"], row["viewport_height"]
            )
            if not baseline.exists():
                status = "approved-baseline-missing"
            else:
                within_tolerance = compare(
                    baseline,
                    candidate,
                    image_path(data_dir, row["run_id"], row["id"], "diff"),
                    current_app.config["PIXEL_THRESHOLD"],
                    current_app.config["MAX_DIFF_RATIO"],
                )
                status = "pass" if within_tolerance else "fail"
            db.execute("UPDATE snapshots SET status = ? WHERE id = ?", (status, row["id"]))
            results.append((row["run_id"], row["name"], status))
        browser.close()
    db.commit()
    return results
