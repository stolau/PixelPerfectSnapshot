import hashlib
import json
import sqlite3
from pathlib import Path

from flask import current_app
from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import sync_playwright

from app.db import get_db

REHYDRATE_JS = Path(__file__).resolve().parents[2] / "packages" / "client" / "dist" / "rehydrate.js"

_SETTLE_CSS = "*{animation:none!important;transition:none!important;caret-color:transparent!important}"
_DOUBLE_RAF = "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
# Rendered layout of every visible element under <body>, keyed by its tag/nth-of-type path:
# the box comes from getBoundingClientRect() (CSS px) and the text is the element's own
# direct text nodes, so a CSS-only change that moves or resizes an element is seen.
_COLLECT_STRUCTURE = """() => {
  const out = [];
  const walk = (parent, path) => {
    const seen = {};
    for (const el of parent.children) {
      const tag = el.tagName.toLowerCase();
      seen[tag] = (seen[tag] || 0) + 1;
      const elPath = `${path}>${tag}:nth-of-type(${seen[tag]})`;
      const r = el.getBoundingClientRect();
      if ((r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden") {
        let text = "";
        for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
        out.push({path: elPath, x: r.x, y: r.y, width: r.width, height: r.height, text: text.trim()});
      }
      walk(el, elPath);
    }
  };
  walk(document.body, "body");
  return out;
}"""


def baseline_path(data_dir: Path, name: str, width: int, height: int) -> Path:
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return data_dir / "baselines" / f"{key}.png"


def baseline_structure_path(png: Path) -> Path:
    """The rendered-layout structure recorded beside a baseline PNG. Only ever derive it from a
    PNG path a scoped_baseline_* helper (or baseline_path) returned, so it lives where its PNG does."""
    return png.with_suffix(".structure.json")


def baseline_history_dir(data_dir: Path, name: str, width: int, height: int) -> Path:
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return data_dir / "baselines" / "history" / key


def baseline_history_path_by_hash(data_dir: Path, key: str, timestamp: str) -> Path:
    return data_dir / "baselines" / "history" / key / f"{timestamp}.png"


def baseline_history_path(data_dir: Path, name: str, width: int, height: int, timestamp: str) -> Path:
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return baseline_history_path_by_hash(data_dir, key, timestamp)


def _scope_dir(data_dir: Path, scope_kind: str, scope_id: str) -> Path:
    if scope_kind == "branch":
        return data_dir / "baselines" / "branches" / scope_id
    if scope_kind == "release":
        return data_dir / "baselines" / "releases" / scope_id
    raise ValueError(f"unknown scope_kind: {scope_kind!r}")


def scoped_baseline_write_path(
    data_dir: Path, scope_kind: str | None, scope_id: str | None,
    name: str, width: int, height: int,
) -> Path:
    if scope_kind is None:
        return baseline_path(data_dir, name, width, height)
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return _scope_dir(data_dir, scope_kind, scope_id) / f"{key}.png"


def scoped_baseline_read_path(
    data_dir: Path, scope_kind: str | None, scope_id: str | None,
    name: str, width: int, height: int,
) -> Path:
    if scope_kind != "branch":
        return scoped_baseline_write_path(data_dir, scope_kind, scope_id, name, width, height)
    branch_path = scoped_baseline_write_path(data_dir, "branch", scope_id, name, width, height)
    return branch_path if branch_path.exists() else baseline_path(data_dir, name, width, height)


def scoped_baseline_history_dir(
    data_dir: Path, scope_kind: str | None, scope_id: str | None,
    name: str, width: int, height: int,
) -> Path:
    if scope_kind is None:
        return baseline_history_dir(data_dir, name, width, height)
    key = hashlib.sha256(f"{name}\n{width}x{height}".encode()).hexdigest()
    return _scope_dir(data_dir, scope_kind, scope_id) / "history" / key


def scoped_baseline_history_path(
    data_dir: Path, scope_kind: str | None, scope_id: str | None,
    name: str, width: int, height: int, timestamp: str,
) -> Path:
    return scoped_baseline_history_dir(
        data_dir, scope_kind, scope_id, name, width, height
    ) / f"{timestamp}.png"


def image_path(data_dir: Path, run_id: str, snapshot_id: int, kind: str) -> Path:
    return data_dir / "images" / run_id / str(snapshot_id) / f"{kind}.png"


def structure_path(data_dir: Path, run_id: str, snapshot_id: int, kind: str) -> Path:
    return data_dir / "images" / run_id / str(snapshot_id) / f"{kind}.json"


def _box(entry: dict) -> dict:
    return {k: entry[k] for k in ("x", "y", "width", "height", "text")}


def structure_diff(before: list[dict], after: list[dict]) -> list[dict]:
    """Per-element layout changes between two collected structures, one entry per kind."""
    old = {entry["path"]: entry for entry in before}
    new = {entry["path"]: entry for entry in after}
    changes: list[dict] = []
    for path, was in old.items():
        now = new.get(path)
        if now is None:
            changes.append({"path": path, "kind": "disappeared", "before": _box(was), "after": None})
            continue
        for kind, keys in (("moved", ("x", "y")), ("resized", ("width", "height")), ("text", ("text",))):
            if any(was[k] != now[k] for k in keys):
                changes.append({"path": path, "kind": kind, "before": _box(was), "after": _box(now)})
    for path, now in new.items():
        if path not in old:
            changes.append({"path": path, "kind": "appeared", "before": None, "after": _box(now)})
    return changes


def compare(
    baseline: Path,
    candidate: Path,
    diff_out: Path,
    pixel_threshold: int,
    max_diff_ratio: float,
    masks: list[tuple[int, int, int, int]] = (),
) -> bool:
    baseline_img = Image.open(baseline).convert("RGB")
    candidate_img = Image.open(candidate).convert("RGB")
    channels = ImageChops.difference(baseline_img, candidate_img).split()
    max_channel = channels[0]
    for channel in channels[1:]:
        max_channel = ImageChops.lighter(max_channel, channel)
    diff_mask = max_channel.point(lambda v: 255 if v > pixel_threshold else 0)
    draw = ImageDraw.Draw(diff_mask)
    for mx, my, mw, mh in masks:
        draw.rectangle([mx, my, mx + mw - 1, my + mh - 1], fill=0)
    differing = diff_mask.histogram()[255]
    white = Image.new("RGB", baseline_img.size, (255, 255, 255))
    background = Image.blend(baseline_img.convert("L").convert("RGB"), white, 0.5)
    red = Image.new("RGB", baseline_img.size, (255, 0, 0))
    diff_out.parent.mkdir(parents=True, exist_ok=True)
    Image.composite(red, background, diff_mask).save(diff_out)
    width, height = baseline_img.size
    return differing / (width * height) <= max_diff_ratio


def applicable_masks(
    db: sqlite3.Connection, name: str, width: int, height: int, category: str | None = None
) -> list[tuple[int, int, int, int]]:
    rows = db.execute(
        "SELECT x, y, width, height FROM masks"
        " WHERE (name IS NULL AND category IS NULL)"
        " OR (name = ? AND viewport_width = ? AND viewport_height = ?)"
        " OR (category IS NOT NULL AND category = ?)",
        (name, width, height, category),
    ).fetchall()
    return [(row["x"], row["y"], row["width"], row["height"]) for row in rows]


def category_viewport(
    db: sqlite3.Connection, category: str, exclude_snapshot_id: int | None = None
) -> tuple[int, int] | None:
    query = "SELECT DISTINCT viewport_width, viewport_height FROM snapshots WHERE category = ?"
    params: tuple[object, ...] = (category,)
    if exclude_snapshot_id is not None:
        query += " AND id != ?"
        params += (exclude_snapshot_id,)
    row = db.execute(query + " LIMIT 1", params).fetchone()
    return (row["viewport_width"], row["viewport_height"]) if row is not None else None


def process_pending(run_id: str | None = None) -> list[tuple[str, str, str]]:
    db = get_db()
    query = (
        "SELECT snapshots.id AS id, snapshots.run_id AS run_id, snapshots.name AS name,"
        " snapshots.viewport_width AS viewport_width, snapshots.viewport_height AS viewport_height,"
        " snapshots.category AS category,"
        " runs.scope_kind AS scope_kind, runs.scope_id AS scope_id"
        " FROM snapshots JOIN runs ON runs.id = snapshots.run_id"
        " WHERE snapshots.status = 'pending'"
    )
    params: tuple[str, ...] = ()
    if run_id is not None:
        query += " AND snapshots.run_id = ?"
        params = (run_id,)
    rows = db.execute(query + " ORDER BY snapshots.id", params).fetchall()
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
            structure = page.evaluate(_COLLECT_STRUCTURE)
            context.close()
            structure_path(data_dir, row["run_id"], row["id"], "structure").write_text(
                json.dumps(structure)
            )
            baseline = scoped_baseline_read_path(
                data_dir, row["scope_kind"], row["scope_id"],
                row["name"], row["viewport_width"], row["viewport_height"],
            )
            if not baseline.exists():
                status = "approved-baseline-missing"
            else:
                masks = applicable_masks(
                    db, row["name"], row["viewport_width"], row["viewport_height"], row["category"]
                )
                within_tolerance = compare(
                    baseline,
                    candidate,
                    image_path(data_dir, row["run_id"], row["id"], "diff"),
                    current_app.config["PIXEL_THRESHOLD"],
                    current_app.config["MAX_DIFF_RATIO"],
                    masks,
                )
                status = "pass" if within_tolerance else "fail"
                # The structure only explains the pixel verdict above; it never feeds it.
                baseline_structure = baseline_structure_path(baseline)
                if status == "fail" and baseline_structure.exists():
                    structure_path(data_dir, row["run_id"], row["id"], "structure-diff").write_text(
                        json.dumps(structure_diff(json.loads(baseline_structure.read_text()), structure))
                    )
                elif status == "pass" and not baseline_structure.exists():
                    # A baseline approved before structures were recorded gets one from its next
                    # pass, beside the PNG that was actually read (master, for a branch fallback).
                    baseline_structure.write_text(json.dumps(structure))
            db.execute("UPDATE snapshots SET status = ? WHERE id = ?", (status, row["id"]))
            db.commit()
            results.append((row["run_id"], row["name"], status))
        browser.close()
    return results
