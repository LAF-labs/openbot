# The web surface of a deployment: the built app and the proxy in front of the API, in one image.
#
# The app is built here rather than handed to the web server through a shared volume, so there is
# no step at which a stale `dist` outlives the build that produced it. What Caddy serves and what
# this image built cannot drift apart, because they are the same layer.

FROM oven/bun:1.3.14 AS build

WORKDIR /app

# The same package.json set the API image copies. Workspaces resolve from the root lockfile, so
# these have to land before the install and the sources after it, or every source edit reinstalls.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
# The shell is a workspace even though no image builds it, and bun refuses to install against a
# lockfile whose workspaces it cannot all find. Omitting this builds locally, where the install
# layer is cached, and fails the first time somebody builds on a fresh machine — which is a
# deployment.
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile

COPY app app
COPY server server
COPY tenant tenant
COPY scripts scripts
# Every workspace's tsconfig extends this one, and vite resolves the chain while building. Missing,
# the build fails on index.html with a message about "extends" that names no missing file.
COPY tsconfig.base.json ./

# The brand and the sign-in providers the surface offers are read out of the tenant package and
# written into a generated module at BUILD time, not read at run time. So the package has to be
# present and named here — a deployment that changes packages is a rebuild, not a restart.
ARG TENANT_PACKAGE_DIR=../tenant/laf
ENV TENANT_PACKAGE_DIR=${TENANT_PACKAGE_DIR}
# Names only, never credentials — a build arg is readable in the finished image's history. The
# server decides whether sign-in actually works; this decides whether the button is drawn, and the
# two are keyed off the same variable in docker-compose.yml so they cannot disagree.
ARG AUTH_PROVIDERS=""
ENV AUTH_PROVIDERS=${AUTH_PROVIDERS}
RUN bun scripts/generate-app-config.ts

WORKDIR /app/app
RUN bun run build

FROM caddy:2-alpine

# Certificates and the ACME account live in /data, which compose gives a volume. Without that
# volume every restart asks Let's Encrypt for the same certificate again, and five of those in a
# week is a rate limit that locks the deployment out for days.
COPY --from=build /app/app/dist /srv
COPY app/Caddyfile /etc/caddy/Caddyfile
