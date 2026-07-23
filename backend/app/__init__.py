import os
from pathlib import Path

import click
from flask import Flask, request

from app import api, db, render


def create_app(data_dir: str | os.PathLike | None = None) -> Flask:
    app = Flask(__name__)

    if data_dir is None:
        data_dir = os.environ.get("PPS_DATA_DIR") or Path(__file__).resolve().parents[1] / "data"
    app.config["DATA_DIR"] = Path(data_dir)
    app.config["PIXEL_THRESHOLD"] = int(os.environ.get("PPS_PIXEL_THRESHOLD", 3))
    app.config["MAX_DIFF_RATIO"] = float(os.environ.get("PPS_MAX_DIFF_RATIO", 0.001))
    app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("PPS_MAX_UPLOAD_BYTES", 25 * 1024 * 1024))
    allowed_origin_env = os.environ.get("PPS_ALLOWED_ORIGIN")
    app.config["ALLOWED_ORIGIN"] = (
        None
        if allowed_origin_env is None
        else {origin.strip() for origin in allowed_origin_env.split(",") if origin.strip()}
    )

    db.init_app(app)
    app.register_blueprint(api.bp)

    @app.cli.command("process-pending")
    def process_pending() -> None:
        for run_id, name, status in render.process_pending():
            click.echo(f"{run_id}/{name}: {status}")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.errorhandler(404)
    def not_found(exc) -> tuple[dict[str, str], int]:
        return {"error": "not found"}, 404

    @app.errorhandler(405)
    def method_not_allowed(exc) -> tuple[dict[str, str], int]:
        return {"error": "method not allowed"}, 405

    @app.errorhandler(413)
    def request_entity_too_large(exc) -> tuple[dict[str, str], int]:
        return {"error": "request body too large"}, 413

    @app.after_request
    def add_cors_headers(response):
        allowed_origins = app.config["ALLOWED_ORIGIN"]
        if allowed_origins is None:
            return response
        origin = request.headers.get("Origin")
        if origin in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            if request.method == "OPTIONS":
                response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE"
                response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    return app
