import json
from pathlib import Path

import jsonschema

from app import create_app

DOCS = Path(__file__).resolve().parents[2] / "docs"


def test_health(tmp_path):
    client = create_app(data_dir=tmp_path).test_client()
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_example_snapshot_matches_schema():
    schema = json.loads((DOCS / "snapshot.schema.json").read_text())
    example = json.loads((DOCS / "examples" / "example-snapshot.json").read_text())
    jsonschema.validate(example, schema)
