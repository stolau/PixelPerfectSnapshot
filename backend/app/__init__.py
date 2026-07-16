from flask import Flask


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
