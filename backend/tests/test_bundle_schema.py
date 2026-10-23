import json
from pathlib import Path

import jsonschema
import pytest

DOCS = Path(__file__).resolve().parents[2] / "docs"


@pytest.fixture(scope="module")
def validator():
    schema = json.loads((DOCS / "bundle.schema.json").read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


def entry(n: int, status, **overrides) -> dict:
    base = {
        "name": f"page-{n}",
        "viewport": {"width": 1280, "height": 720},
        "category": None,
        "spec": None,
        "when": None,
        "status": status,
        "files": {"snapshot": f"snapshots/{n:04d}/snapshot.json"},
    }
    base.update(overrides)
    return base


def server_manifest() -> dict:
    return {
        "bundleVersion": 0,
        "producer": "server",
        "run": {
            "id": "run-2",
            "createdAt": "2026-07-15T09:30:00Z",
            "scope": {"kind": "branch", "id": "feature-x"},
        },
        "snapshots": [
            entry(
                1,
                "fail",
                category="Example Base",
                spec="pps-checkout",
                when="cart has two items",
                files={
                    "snapshot": "snapshots/0001/snapshot.json",
                    "candidate": "snapshots/0001/candidate.png",
                    "baseline": "snapshots/0001/baseline.png",
                    "diff": "snapshots/0001/diff.png",
                    "structureDiff": "snapshots/0001/structure-diff.json",
                },
            ),
            entry(2, "pass", spec="pps-cart"),
            entry(3, "approved-baseline-missing"),
        ],
    }


def client_manifest() -> dict:
    return {
        "bundleVersion": 0,
        "producer": "client",
        "run": None,
        "snapshots": [
            entry(1, None, spec="pps-checkout", when="cart has two items"),
            entry(2, None),
        ],
    }


def release_scoped() -> dict:
    manifest = server_manifest()
    manifest["run"]["scope"] = {"kind": "release", "id": "v2"}
    return manifest


def unscoped() -> dict:
    manifest = server_manifest()
    manifest["run"]["scope"] = None
    return manifest


def empty_server() -> dict:
    return dict(server_manifest(), snapshots=[])


def category_with_slash() -> dict:
    # PATCH and category rename store any non-empty string, and the manifest takes the DB value.
    manifest = server_manifest()
    manifest["snapshots"][1]["category"] = "a/b"
    return manifest


def unknown_files_key() -> dict:
    manifest = client_manifest()
    manifest["snapshots"][0]["files"]["html"] = "snapshots/0001/page.html"
    return manifest


@pytest.mark.parametrize(
    "build",
    [
        server_manifest,
        client_manifest,
        release_scoped,
        unscoped,
        empty_server,
        unknown_files_key,
        category_with_slash,
    ],
)
def test_valid_manifests(validator, build):
    errors = [error.message for error in validator.iter_errors(build())]
    assert errors == []


def _del_files_snapshot(m):
    del m["snapshots"][0]["files"]["snapshot"]


def _when_without_spec(m):
    m["snapshots"][2]["when"] = "cart has two items"


def _client_status(m):
    m["snapshots"][0]["status"] = "pass"


def _client_run(m):
    m["run"] = server_manifest()["run"]


def _server_no_run(m):
    m["run"] = None


def _server_null_status(m):
    m["snapshots"][0]["status"] = None


def _status_pending(m):
    m["snapshots"][0]["status"] = "pending"


def _bundle_version_1(m):
    m["bundleVersion"] = 1


def _unknown_top_level(m):
    m["extra"] = True


def _entry_missing_spec(m):
    del m["snapshots"][0]["spec"]


def _entry_unknown_key(m):
    m["snapshots"][0]["extra"] = True


def _run_unknown_key(m):
    m["run"]["extra"] = True


def _scope_kind_master(m):
    m["run"]["scope"]["kind"] = "master"


def _when_too_long(m):
    m["snapshots"][0]["when"] = "x" * 501


def _spec_slash(m):
    m["snapshots"][0]["spec"] = "a/b"


def _missing_snapshots_key(m):
    del m["snapshots"]


def _producer_other(m):
    m["producer"] = "ci"


def _run_missing_scope(m):
    del m["run"]["scope"]


def _run_id_empty(m):
    m["run"]["id"] = ""


def _name_slash(m):
    m["snapshots"][0]["name"] = "a/b"


def _viewport_missing_height(m):
    del m["snapshots"][0]["viewport"]["height"]


def _viewport_unknown_key(m):
    m["snapshots"][0]["viewport"]["dpr"] = 2


def _viewport_zero(m):
    m["snapshots"][0]["viewport"]["width"] = 0


def _category_empty(m):
    m["snapshots"][0]["category"] = ""


def _path(value):
    def mutate(m):
        m["snapshots"][0]["files"]["candidate"] = value

    return mutate


INVALID = {
    "missing-files-snapshot": (server_manifest, _del_files_snapshot),
    "when-without-spec": (server_manifest, _when_without_spec),
    "client-with-status": (client_manifest, _client_status),
    "client-with-run": (client_manifest, _client_run),
    "server-without-run": (server_manifest, _server_no_run),
    "server-null-status": (server_manifest, _server_null_status),
    "status-pending": (server_manifest, _status_pending),
    "bundle-version-1": (server_manifest, _bundle_version_1),
    "unknown-top-level-key": (server_manifest, _unknown_top_level),
    "entry-missing-spec": (server_manifest, _entry_missing_spec),
    "entry-unknown-key": (server_manifest, _entry_unknown_key),
    "run-unknown-key": (server_manifest, _run_unknown_key),
    "scope-kind-master": (server_manifest, _scope_kind_master),
    "when-too-long": (server_manifest, _when_too_long),
    "spec-slash": (server_manifest, _spec_slash),
    "missing-snapshots-key": (server_manifest, _missing_snapshots_key),
    "producer-other": (server_manifest, _producer_other),
    "run-missing-scope": (server_manifest, _run_missing_scope),
    "run-id-empty": (server_manifest, _run_id_empty),
    "name-slash": (server_manifest, _name_slash),
    "viewport-missing-height": (server_manifest, _viewport_missing_height),
    "viewport-unknown-key": (server_manifest, _viewport_unknown_key),
    "viewport-zero": (server_manifest, _viewport_zero),
    "category-empty": (server_manifest, _category_empty),
    "path-parent": (server_manifest, _path("../x")),
    "path-absolute": (server_manifest, _path("/abs")),
    "path-dot-segment": (server_manifest, _path("snapshots/./a")),
}


@pytest.mark.parametrize("case", list(INVALID), ids=list(INVALID))
def test_invalid_manifests(validator, case):
    build, mutate = INVALID[case]
    manifest = build()
    mutate(manifest)
    assert not validator.is_valid(manifest)
