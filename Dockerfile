# noro: Node 24 + Python 3 + the CLI, so the host needs only Docker.
#   docker build -t noro .
#   docker run --rm -it -v "$PWD:/work" -w /work --env-file .env noro this exports/google-ads.csv
# Published as ghcr.io/noro-to/noro (linux/amd64, linux/arm64) by .github/workflows/release.yml.

FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
# python3, not python3-minimal: the engine needs json and argparse from libpython3-stdlib.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/noro
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY engine/noro.py engine/rules.json ./engine/
COPY personas ./personas
COPY LICENSE README.md ./
RUN ln -s /opt/noro/dist/cli.js /usr/local/bin/noro \
 && mkdir -p /work && chown node:node /work
# Run state (.noro/) goes to the working folder. HOME=/tmp works for any --user uid.
ENV NORO_PYTHON=python3 HOME=/tmp NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/noro-to/noro" \
      org.opencontainers.image.description="noro: paid-media reports where every number is traced" \
      org.opencontainers.image.licenses="MIT"
USER node
WORKDIR /work
ENTRYPOINT ["noro"]
CMD ["--help"]
