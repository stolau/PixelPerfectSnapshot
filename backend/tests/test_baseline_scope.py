import hashlib
import sqlite3

import pytest

from app import api, create_app, render


@pytest.fixture
def app(tmp_path):
    return create_app(data_dir=tmp_path)


# --- _validate_scope_id --------------------------------------------------


@pytest.mark.parametrize(
    "scope_id",
    ["../../etc", "..", ".", "", "feature/x"],
)
def test_validate_scope_id_rejects_invalid(scope_id):
    assert api._validate_scope_id(scope_id) is not None


@pytest.mark.parametrize(
    "scope_id",
    ["feature-x", "v1.2.0", "release_2024_01"],
)
def test_validate_scope_id_accepts_valid(scope_id):
    assert api._validate_scope_id(scope_id) is None


# --- scope_kind=None delegates byte-identically to the unscoped helpers --


def test_scoped_write_path_none_matches_baseline_path(tmp_path):
    assert render.scoped_baseline_write_path(
        tmp_path, None, None, "page", 320, 240
    ) == render.baseline_path(tmp_path, "page", 320, 240)


def test_scoped_read_path_none_matches_baseline_path(tmp_path):
    assert render.scoped_baseline_read_path(
        tmp_path, None, None, "page", 320, 240
    ) == render.baseline_path(tmp_path, "page", 320, 240)


def test_scoped_history_dir_none_matches_baseline_history_dir(tmp_path):
    assert render.scoped_baseline_history_dir(
        tmp_path, None, None, "page", 320, 240
    ) == render.baseline_history_dir(tmp_path, "page", 320, 240)


def test_scoped_history_path_none_matches_baseline_history_path(tmp_path):
    ts = "20260101T000000000000Z"
    assert render.scoped_baseline_history_path(
        tmp_path, None, None, "page", 320, 240, ts
    ) == render.baseline_history_path(tmp_path, "page", 320, 240, ts)


# --- branch scope: read prefers branch file, falls back to master -------


def test_branch_read_falls_back_to_master_when_no_branch_file(tmp_path):
    master = render.baseline_path(tmp_path, "page", 320, 240)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master-bytes")

    result = render.scoped_baseline_read_path(tmp_path, "branch", "feature-x", "page", 320, 240)
    assert result == master
    assert result.read_bytes() == b"master-bytes"


def test_branch_read_prefers_branch_file_when_it_exists(tmp_path):
    master = render.baseline_path(tmp_path, "page", 320, 240)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master-bytes")

    branch_path = render.scoped_baseline_write_path(tmp_path, "branch", "feature-x", "page", 320, 240)
    branch_path.parent.mkdir(parents=True, exist_ok=True)
    branch_path.write_bytes(b"branch-bytes")

    result = render.scoped_baseline_read_path(tmp_path, "branch", "feature-x", "page", 320, 240)
    assert result == branch_path
    assert result.read_bytes() == b"branch-bytes"


def test_branch_write_path_is_always_the_branch_path(tmp_path):
    master = render.baseline_path(tmp_path, "page", 320, 240)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master-bytes")

    write_path = render.scoped_baseline_write_path(tmp_path, "branch", "feature-x", "page", 320, 240)
    assert write_path != master
    assert write_path == tmp_path / "baselines" / "branches" / "feature-x" / write_path.name

    # Even with a branch file already present on disk, the write path is unchanged.
    write_path.parent.mkdir(parents=True, exist_ok=True)
    write_path.write_bytes(b"existing-branch-bytes")
    assert render.scoped_baseline_write_path(
        tmp_path, "branch", "feature-x", "page", 320, 240
    ) == write_path


# --- release scope: read and write are always the release path, no fallback --


def test_release_read_and_write_are_always_the_release_path(tmp_path):
    master = render.baseline_path(tmp_path, "page", 320, 240)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master-bytes")

    write_path = render.scoped_baseline_write_path(tmp_path, "release", "v1", "page", 320, 240)
    read_path = render.scoped_baseline_read_path(tmp_path, "release", "v1", "page", 320, 240)

    assert write_path == read_path
    assert write_path == tmp_path / "baselines" / "releases" / "v1" / write_path.name
    # No fallback to master, even though a master baseline exists on disk.
    assert not write_path.exists()


def test_release_read_does_not_fall_back_even_when_release_file_missing_and_master_exists(tmp_path):
    master = render.baseline_path(tmp_path, "page", 320, 240)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master-bytes")

    result = render.scoped_baseline_read_path(tmp_path, "release", "v1", "page", 320, 240)
    assert result != master
    assert not result.exists()


# --- history path shapes ---------------------------------------------------


def test_branch_history_path_shape(tmp_path):
    ts = "20260101T000000000000Z"
    key_dir = render.scoped_baseline_history_dir(tmp_path, "branch", "feature-x", "page", 320, 240)
    path = render.scoped_baseline_history_path(tmp_path, "branch", "feature-x", "page", 320, 240, ts)

    unscoped_key = render.baseline_history_dir(tmp_path, "page", 320, 240).name
    assert key_dir == tmp_path / "baselines" / "branches" / "feature-x" / "history" / unscoped_key
    assert path == key_dir / f"{ts}.png"


def test_release_history_path_shape(tmp_path):
    ts = "20260101T000000000000Z"
    key_dir = render.scoped_baseline_history_dir(tmp_path, "release", "v1", "page", 320, 240)
    path = render.scoped_baseline_history_path(tmp_path, "release", "v1", "page", 320, 240, ts)

    unscoped_key = render.baseline_history_dir(tmp_path, "page", 320, 240).name
    assert key_dir == tmp_path / "baselines" / "releases" / "v1" / "history" / unscoped_key
    assert path == key_dir / f"{ts}.png"


def test_baseline_history_path_by_hash_matches_baseline_history_path(tmp_path):
    ts = "20260101T000000000000Z"
    key = hashlib.sha256(b"page\n320x240").hexdigest()
    assert render.baseline_history_path_by_hash(tmp_path, key, ts) == render.baseline_history_path(
        tmp_path, "page", 320, 240, ts
    )


# --- runs table CHECK constraints ------------------------------------------


def test_runs_check_constraint_rejects_scope_kind_without_scope_id(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
                ("run-missing-id", "2026-01-01T00:00:00Z", "branch", None),
            )
    finally:
        conn.close()


def test_runs_check_constraint_rejects_scope_id_without_scope_kind(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
                ("run-missing-kind", "2026-01-01T00:00:00Z", None, "feature-x"),
            )
    finally:
        conn.close()


def test_runs_check_constraint_rejects_invalid_scope_kind(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
                ("run-bad-kind", "2026-01-01T00:00:00Z", "master", "main"),
            )
    finally:
        conn.close()


def test_runs_check_constraint_allows_valid_rows(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
            ("run-unscoped", "2026-01-01T00:00:00Z", None, None),
        )
        conn.execute(
            "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
            ("run-branch", "2026-01-01T00:00:00Z", "branch", "feature-x"),
        )
        conn.execute(
            "INSERT INTO runs (id, created_at, scope_kind, scope_id) VALUES (?, ?, ?, ?)",
            ("run-release", "2026-01-01T00:00:00Z", "release", "v1"),
        )
        conn.commit()
        count = conn.execute(
            "SELECT COUNT(*) FROM runs WHERE id IN (?, ?, ?)",
            ("run-unscoped", "run-branch", "run-release"),
        ).fetchone()[0]
        assert count == 3
    finally:
        conn.close()


# --- releases table ----------------------------------------------------


def test_releases_table_round_trip(app, tmp_path):
    conn = sqlite3.connect(tmp_path / "pps.sqlite3")
    try:
        conn.execute(
            "INSERT INTO releases (id, created_at) VALUES (?, ?)", ("v1", "2026-01-01T00:00:00Z")
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, created_at FROM releases WHERE id = ?", ("v1",)
        ).fetchone()
        assert row == ("v1", "2026-01-01T00:00:00Z")
    finally:
        conn.close()
