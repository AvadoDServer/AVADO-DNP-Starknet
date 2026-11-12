# AVADO Starknet Validator package image.
#
# One container runs three things, looked after by a small Node.js service:
#   - Juno, Nethermind's Starknet full node (Apache-2.0)
#   - starknet-staking-v2, Nethermind's attestation tool for Starknet staking (Apache-2.0)
#   - the plain-language page on port 80
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.
#
# Upstream images are pinned by their multi-arch index digest; the tag is only
# a label. Update tag and digest together: `docker buildx imagetools inspect
# <image>:<tag>` prints the "Digest:" line. Checked 2026-11-04.
ARG JUNO_IMAGE=nethermind/juno:v0.17.0@sha256:7695dc36baedc08e5e49178ad0bcb55259b07550cec7359ce06a9ae16726daec
ARG VALIDATOR_IMAGE=nethermind/starknet-staking-v2:v0.4.0@sha256:ef3054987025e8a5d2a026126a1f3f83c3fb27c449aa48de8f488391291da95c
# Same Node.js base as AVADO-DNP-Care and AVADO-DNP-Rocketpool (bookworm, glibc,
# runs on today's AVADO boxes with Docker 20.10).
ARG NODE_SLIM_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM --platform=linux/amd64 ${JUNO_IMAGE} AS juno
FROM --platform=linux/amd64 ${VALIDATOR_IMAGE} AS validator

########## Tests: a failing test fails the image build
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE} AS test
WORKDIR /usr/src/service
COPY build/service/ ./
RUN node --test test/*.test.mjs && touch /tested

########## Port 80 without root: give the node binary cap_net_bind_service
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE} AS caps
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_bind_service=+ep /usr/local/bin/node \
    && getcap /usr/local/bin/node | grep -q cap_net_bind_service

########## Runtime
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE}

# zstd and tar unpack the "fast start" database copy; ca-certificates for https downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends zstd ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=caps /usr/local/bin/node /usr/local/bin/node
COPY --from=juno /usr/local/bin/juno /usr/local/bin/juno
COPY --from=validator /ko-app/validator /usr/local/bin/validator
COPY --from=test /tested /tmp/tested
COPY build/service/src /usr/src/service/src
COPY build/service/public /usr/src/service/public
COPY build/service/package.json /usr/src/service/package.json
COPY build/NOTICE /usr/src/service/NOTICE

# Package version, read from the manifest so a version bump can never leave it stale.
COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/service/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json /tmp/tested \
    && juno --help > /dev/null \
    && validator --version \
    && zstd --version \
    && mkdir -p /data && chown node:node /data

USER node
ENV NODE_ENV=production \
    STATE_DIR=/data \
    HTTP_PORT=80
WORKDIR /usr/src/service
# 80: the page; 6060 / 6061: Juno's Starknet RPC (http / websocket) for wallets on the AVADO network
EXPOSE 80 6060 6061
CMD ["node", "src/server.mjs"]
