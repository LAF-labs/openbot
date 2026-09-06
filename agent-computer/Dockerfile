# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Bun, taken from the official image at the exact version the rest of the repository builds with.
#
# It used to be `curl -fsSL https://bun.sh/install | bash`, which installs whatever is newest at
# build time: the service that drives a browser holding somebody's real logins ran on a runtime
# version no commit here named, and two builds of one commit could differ. A COPY from a pinned
# image also drops the apt layer that only existed because bun's installer needs unzip.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# The repository's lockfile, filtered to this workspace. Installing without one resolved Playwright
# and its friends at build time, which is exactly the drift the pinned base image exists to prevent
# one layer up. Every workspace manifest is copied because bun refuses to install against a lockfile
# whose workspaces it cannot all find.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
COPY agent-computer/package.json agent-computer/package.json
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile --filter=agent-computer

# The log's shape lives beside the workspaces (`shared/log.ts`), imported as `../../shared/log`;
# the layout is preserved so the import resolves the same in the image and locally.
COPY shared ./shared
COPY agent-computer/src ./agent-computer/src

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the caller need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "agent-computer/src/index.ts"]
