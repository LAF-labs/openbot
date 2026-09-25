# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# Bun, taken from the official image at the exact version the rest of the repository builds with.
#
# It used to be `curl -fsSL https://bun.sh/install | bash`, which installs whatever is newest at
# build time: the service that drives a browser holding somebody's real logins ran on a runtime
# version no commit here named, and two builds of one commit could differ. A COPY from a pinned
# image also drops the apt layer that only existed because bun's installer needs unzip.
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun

# A Korean typeface, which the base image does not carry. Its only CJK face is WenQuanYi Zen Hei, a
# Chinese font with Hangul in it (`fc-list :lang=ko`, measured 2026-09-25), so every Korean page the
# person watches on the live screen was drawn in it. Nanum Gothic is the face Korean sites name in
# their CSS (`"나눔고딕", NanumGothic`), and at 10 MB it is a sixth of Noto CJK. Pinned to the one
# version noble ships, like everything else in this file.
#
# Installed is not chosen: fontconfig still answered `fc-match :lang=ko` with WenQuanYi afterwards,
# because both claim Korean. The rule puts Nanum Gothic first for Korean text, which is what Chromium
# asks fontconfig when a Korean page's own font is not here (measured: NanumGothic after, WenQuanYi
# before; Latin text keeps its own face).
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-nanum=20200506-1 iptables=1.8.10-3ubuntu2 \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    '<?xml version="1.0"?>' \
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
    '<fontconfig>' \
    '  <match target="pattern">' \
    '    <test name="lang" compare="contains"><string>ko</string></test>' \
    '    <edit name="family" mode="prepend"><string>NanumGothic</string></edit>' \
    '  </match>' \
    '</fontconfig>' > /etc/fonts/local.conf

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
COPY --chmod=755 agent-computer/egress-firewall.sh /usr/local/bin/egress-firewall

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
#
# STILL NOT ROOT, BUT ROOT FIRST, FOR ONE SCRIPT. The egress firewall (security review 2026-09-25 F1)
# is written in this container's network namespace, which takes root and NET_ADMIN; the script then
# becomes `pwuser` with an empty capability bounding set and no_new_privs before `bun` starts, so the
# computer and every Chromium process under it run exactly as they did, minus the ability to undo the
# rules. `agent-computer/tests/sandbox.test.ts` holds both halves.
ENTRYPOINT ["/usr/local/bin/egress-firewall"]
CMD ["bun", "agent-computer/src/index.ts"]
