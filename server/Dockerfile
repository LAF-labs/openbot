# The API server — and, with its command overridden, the `migrate` one-shot (docker-compose.yml).
#
# TWO STAGES, AND THE SECOND ONE IS THE IMAGE. Until 2026-09-10 this was one stage that ran a bare
# `bun install --frozen-lockfile` and then `COPY server server`: every workspace's production AND
# development dependencies, the app's icon sets and its bundler, three esbuild builds, the Tauri
# CLI, biome, the test files and bun's own download cache — 1.95 GB measured, of which the server's
# production closure was 392 MB. The rest was pulled by every customer VM on every upgrade and sat
# inside the container that faces the internet.
#
# So the install happens in a stage that is thrown away, filtered to this workspace and to what it
# needs at run time, and only the resulting `node_modules` cross over. `drizzle-kit` is a production
# dependency of this workspace on purpose: the `migrate` service runs it from this image, so an
# install that dropped it would build an image whose migration step fails on the first deployment.
#
# Base images are pinned by digest as well as by tag. A tag is a name that moves; the digest is the
# bytes. `.github/dependabot.yml` (the `docker` entries) is what re-pins them, and
# `tests/dockerfiles.test.ts` is what refuses a FROM without one.

# oven/bun:1.3.14 — the same bun the lockfile and CI use.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS install

WORKDIR /app

# Every workspace manifest is copied because bun refuses to install against a lockfile whose
# workspaces it cannot all find (the shell included, though no image builds it — omitting it builds
# on a machine with a cached install layer and fails on a fresh one, which is a deployment).
# `--filter` then narrows what is actually installed, and `--production` leaves the test doubles
# behind.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
COPY agent-computer/package.json agent-computer/package.json
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile --filter=server --production

# THE SERVER RUNS AS ONE BUNDLE, BUILT HERE. From TS source it resolved and transpiled ~2,500 modules
# on every start, and a start is exactly what the person waits through during an upgrade: the
# `/health` 502 window. Measured 2026-09-25, both images alternating three rounds under the same
# host load, `--cpus 1`: `docker start` to `/health` 200 went from 19.5 s to 4.0 s (median), and the
# gap a compose-style replacement leaves (stop, remove, create, start) from 27.3 s to 9.3 s.
# `--target=bun` keeps Bun's own APIs (`bun:sql`, `Bun.serve`) as they are; every other import is
# inlined, so nothing at run time resolves a module path. The sources still cross to the image
# below: `drizzle.config.ts`, which the `migrate` service runs from this image, names the schema
# files.
COPY tsconfig.base.json ./
COPY server/tsconfig.json server/
COPY server/src server/src
COPY shared shared
RUN bun build server/src/index.ts --target=bun --outfile server/dist/index.js

# oven/bun:1.3.14 — the same digest as the install stage, so the two never run different runtimes.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

WORKDIR /app

# Both trees, because bun's isolated linker puts the store under the root `node_modules/.bun` and
# fills `server/node_modules` with symlinks into it. One without the other is a tree of dangling
# links, and `bun x drizzle-kit` reads the bin out of the workspace's own tree.
COPY --from=install /app/node_modules node_modules
COPY --from=install /app/server/node_modules server/node_modules
COPY --from=install /app/server/dist server/dist

# What the server reads at run time, and nothing beside it: the sources, the migration chain the
# `migrate` service replays, the two configs bun and drizzle-kit read. Not `server/tests`, not
# `server/scripts`.
COPY tsconfig.base.json ./
COPY server/package.json server/tsconfig.json server/drizzle.config.ts server/
COPY server/src server/src
COPY server/drizzle server/drizzle
# The prompt and the tool catalogue live beside the workspaces, not inside one; the app imports
# them through the @shared alias and the server through a relative path, so both images need them.
COPY shared shared
# The tenant package is read at run time, so the image that runs the API has to carry it. Without
# this the container starts, reads TENANT_PACKAGE_DIR, and dies looking for a directory that only
# ever existed on the machine the image was built from.
COPY tenant tenant

# Which build this is, baked in so `GET /api/version` and the `boot` log line can say. Filled by
# images.yml (`--build-arg REVISION`, `--build-arg CHANNEL`); a local build leaves both empty, and
# `buildOf` in shared/log.ts then reads `source` rather than inventing a version. Declared after
# the copies so a new commit changes only this layer's config, not the install above it.
ARG REVISION=
ARG CHANNEL=
ENV GIT_SHA=${REVISION} \
    BUILD_CHANNEL=${CHANNEL}

WORKDIR /app/server

# The migration service overrides this with its own command; everything else wants the API, as the
# bundle built above.
CMD ["bun", "dist/index.js"]
