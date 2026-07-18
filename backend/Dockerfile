FROM node:22-slim AS client-builder
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build -w packages/client

FROM python:3.12-slim AS backend
WORKDIR /app/backend
COPY backend/pyproject.toml ./pyproject.toml
COPY backend/app ./app
RUN pip install --no-cache-dir -e .
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install --with-deps chromium
RUN useradd -m appuser && chmod -R o+rX /ms-playwright && mkdir -p /data && chown appuser:appuser /data
COPY --from=client-builder /repo/packages/client/dist /app/packages/client/dist
COPY docs /app/docs

EXPOSE 5000
ENV FLASK_APP=app
USER appuser
CMD ["flask", "--app", "app", "run", "--host=0.0.0.0", "--port=5000"]
