import pytest

from app import create_app


@pytest.fixture
def client(tmp_path):
    return create_app(data_dir=tmp_path).test_client()


def test_auth_default_off(client):
    response = client.get("/api/runs")
    assert response.status_code == 200


def test_auth_missing_header_401(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_API_TOKEN", "s3cr3t")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.get("/api/runs")
    assert response.status_code == 401
    assert "error" in response.get_json()


def test_auth_wrong_token_401(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_API_TOKEN", "s3cr3t")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.get("/api/runs", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401
    assert "error" in response.get_json()


def test_auth_correct_token_200(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_API_TOKEN", "s3cr3t")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.get("/api/runs", headers={"Authorization": "Bearer s3cr3t"})
    assert response.status_code == 200


def test_auth_options_exempt(tmp_path, monkeypatch):
    monkeypatch.setenv("PPS_API_TOKEN", "s3cr3t")
    monkeypatch.setenv("PPS_ALLOWED_ORIGIN", "https://a.example.com")
    client = create_app(data_dir=tmp_path).test_client()

    response = client.options(
        "/api/runs/abc123/snapshots",
        headers={
            "Origin": "https://a.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert response.status_code != 401
    assert response.headers["Access-Control-Allow-Origin"] == "https://a.example.com"
