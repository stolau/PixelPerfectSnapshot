FROM node:22-slim AS viewer-builder
ARG VITE_API_BASE=""
WORKDIR /repo
COPY . .
RUN npm ci
RUN VITE_API_BASE=$VITE_API_BASE npm run build -w viewer

FROM nginx:1.27-alpine AS viewer
ARG VITE_API_BASE=""
COPY --from=viewer-builder /repo/viewer/dist /usr/share/nginx/html
COPY viewer/nginx.conf /etc/nginx/conf.d/default.conf
# When VITE_API_BASE is set, the built JS already calls an absolute backend URL directly -- the
# same-origin /api/ proxy below is not just unused, its static "backend:5000" upstream reference
# makes nginx refuse to even start when that hostname isn't resolvable (no compose network, no
# "backend" service). Drop the block entirely in that case; the default (empty VITE_API_BASE,
# same-host deployment) keeps it, byte-for-byte unchanged.
RUN if [ -n "$VITE_API_BASE" ]; then \
      sed -i '/location \/api\/ {/,/^    }/d' /etc/nginx/conf.d/default.conf; \
    fi
EXPOSE 80
