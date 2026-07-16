import os
from pathlib import Path

from flask import Flask

from app import api, db


def create_app(data_dir: str | os.PathLike | None = None) -> Flask:
    app = Flask(__name__)

    if data_dir is None:
        data_dir = os.environ.get("PPS_DATA_DIR") or Path(__file__).resolve().parents[1] / "data"
    app.config["DATA_DIR"] = Path(data_dir)

    db.init_app(app)
    app.register_blueprint(api.bp)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.errorhandler(404)
    def not_found(exc) -> tuple[dict[str, str], int]:
        return {"error": "not found"}, 404

    @app.errorhandler(405)
    def method_not_allowed(exc) -> tuple[dict[str, str], int]:
        return {"error": "method not allowed"}, 405

    return app
