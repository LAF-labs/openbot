# The built-in Bot only speaks AG-UI and a model provider; the browser runs in a separate computer
# container so either side can be replaced independently.
#
# The bun tag is exact. `1.3-alpine` floats: two builds of the same commit, a week apart, ran on
# different bun versions and nothing recorded which — the same class of failure as installing
# without a lockfile, one layer down.
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# The repository's own lockfile, and only this workspace's dependencies out of it. `bun install`
# with no lockfile resolved whatever the registry served that minute, which is how an image and the
# repository that built it end up on different versions of the model client with nothing to say so.
#
# Every workspace manifest is copied because bun refuses to install against a lockfile whose
# workspaces it cannot all find; `--filter` then narrows what is actually installed, so this image
# carries the Bot's three dependencies and not the app's build toolchain.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY agent-bot/package.json agent-bot/package.json
COPY agent-computer/package.json agent-computer/package.json
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile --filter=agent-bot

# Preserve the repo layout so `../../shared/bot-prompt` resolves the same in the image and locally.
COPY shared ./shared
COPY agent-bot/src ./agent-bot/src

ENV PORT=4200
EXPOSE 4200
CMD ["bun", "agent-bot/src/index.ts"]
