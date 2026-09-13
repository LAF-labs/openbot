# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

# Bun, taken from the official image at the exact version the rest of the repository builds with.
#
# It used to be `curl -fsSL https://bun.sh/install | bash`, which installs whatever is newest at
# build time: the service that drives a browser holding somebody's real logins ran on a runtime
# version no commit here named, and two builds of one commit could differ. A COPY from a pinned
# image also drops the apt layer that only existed because bun's installer needs unzip.
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun

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
#
# Both volume roots are created here and owned by `pwuser`, because a named volume Docker creates
# fresh takes the ownership of the image directory it is mounted over. A volume that already exists
# keeps the ownership it has — root, on every deployment that ran the earlier image — which is what
# the `post_start` chown on the service in docker-compose.yml is for.
RUN mkdir -p /workspace /profiles && chown pwuser:pwuser /workspace /profiles
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the caller need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

# NOT ROOT. This process opens pages a model chose, holding somebody's bank and 홈택스 cookies and
# the computer token, and until 2026-09-13 it did so as uid 0 with Chromium's sandbox switched off
# (audit A5 §1: `docker exec … id` → `uid=0(root)`). One renderer bug was the whole container, every
# Bot's profile included. `pwuser` is the account the Playwright image ships for this, and with
# `--no-sandbox` gone from profiles.ts the renderers run in namespaces of their own — which Docker's
# default seccomp profile refuses, so docker-compose.yml hands the container Playwright's profile.
# Without it the browser does not start at all ("No usable sandbox!"), which is the honest failure:
# a deployment that loses the profile finds out on its first page, not after a renderer is owned.
USER pwuser

CMD ["bun", "agent-computer/src/index.ts"]
