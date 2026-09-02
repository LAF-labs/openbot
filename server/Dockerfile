FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
COPY agent-computer/package.json agent-computer/package.json
# The shell is a workspace even though no image builds it, and bun refuses to install against a
# lockfile whose workspaces it cannot all find. Omitting this builds locally, where the install
# layer is cached, and fails the first time somebody builds on a fresh machine — which is a
# deployment.
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile

COPY server server
# The tenant package is read at run time, so the image that runs the API has to carry it. Without
# this the container starts, reads TENANT_PACKAGE_DIR, and dies looking for a directory that only
# ever existed on the machine the image was built from.
COPY tenant tenant

WORKDIR /app/server

# The migration service overrides this with its own command; everything else wants the API.
CMD ["bun", "src/index.ts"]
