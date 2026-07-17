FROM node:22-slim AS viewer-builder
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build -w viewer

FROM nginx:1.27-alpine AS viewer
COPY --from=viewer-builder /repo/viewer/dist /usr/share/nginx/html
COPY viewer/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
