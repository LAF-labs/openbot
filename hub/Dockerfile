# The company hub (hub/): one Bun process, its migrations, and the shared contract it imports.
#
# Run from source rather than bundled, as agent-bot is: the hub imports three packages and a few
# files of its own, so a start resolves little, and the migration chain is read from beside the
# source (`src/db/client.ts`), which a bundle in another directory would have to be told about.
#
# The bun tag is exact and pinned by digest — the same alpine build agent-bot uses, so the two never
# run different runtimes under one name (tests/dockerfiles.test.ts).
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app

# Every workspace manifest is copied because bun refuses a `--frozen-lockfile` install against a
# lockfile whose workspaces it cannot all find; `--filter` then narrows the install to the hub's
# three run-time packages, and `--production` leaves drizzle-kit (generating only) behind.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
COPY agent-computer/package.json agent-computer/package.json
COPY desktop/package.json desktop/package.json
COPY hub/package.json hub/package.json
RUN bun install --frozen-lockfile --filter=hub --production

# The layout of the repository, so `../../shared/…` resolves in the image as it does in a checkout.
COPY tsconfig.base.json ./
COPY hub/tsconfig.json hub/tsconfig.json
COPY shared/hub shared/hub
COPY shared/channel-socket.ts shared/log.ts shared/failure-text.ts shared/memory-guards.ts shared/
# The VM's skill-slug rule, so a team skill is named the way a person's VM calls one.
COPY shared/tools/skills.ts shared/tools/standard-schema.ts shared/tools/
COPY hub/src hub/src
COPY hub/drizzle hub/drizzle

# Which build this is, for the `boot` line (`buildOf` in shared/log.ts), filled by images.yml.
ARG REVISION=
ARG CHANNEL=
ENV GIT_SHA=${REVISION} \
    BUILD_CHANNEL=${CHANNEL}

# Nothing here writes to the image's disk, so it needs no root.
USER bun
ENV PORT=7200
EXPOSE 7200
CMD ["bun", "hub/src/index.ts"]
