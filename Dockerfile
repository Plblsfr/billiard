# ---- 1. Build : tests + site statique ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests
COPY web ./web
COPY public ./public
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
RUN npm test && npm run build

# ---- 2. Runtime : nginx non root, port 8080 ----
FROM nginxinc/nginx-unprivileged:stable-alpine
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="billard-anglais" \
      org.opencontainers.image.description="Billard anglais (blackball) à 2 ou 3 joueurs" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
