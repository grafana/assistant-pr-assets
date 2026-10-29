FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS publisher
WORKDIR /renderer
COPY LICENSE buttons.mjs publish.mjs publish.test.mjs ./
RUN node --test publish.test.mjs
ENTRYPOINT ["node", "publish.mjs"]

FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 AS generator

# Freeze the converter and its libraries, not just Chromium.
RUN rm -f /etc/apt/sources.list.d/ubuntu.sources && \
    printf 'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble main universe\ndeb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble-updates main universe\ndeb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble-security main universe\n' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends poppler-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /renderer
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY grafana_icon.svg buttons.mjs generate.mjs ./
ENV PUBLICATION_ASSETS_OUTPUT_DIR=/output
ENTRYPOINT ["node", "generate.mjs"]
