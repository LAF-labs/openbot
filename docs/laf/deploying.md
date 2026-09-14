# Deploying

One VM, one person, one `docker compose up`. This is what that takes and, more
usefully, what goes wrong at each step. `docs/laf/deployment-model.md` is why
the shape is a single VM; this is how to stand one up.

## What the compose file adds

Two services that did not exist before, because until now nothing served the
app to anybody:

- **`web`** — the only service published to the internet. Terminates TLS, serves
  the built app out of the image, and proxies `/api/*` to the API. Its
  certificates live in the `caddy-data` volume.
- **`server`** — the API. Deliberately unpublished. The only route in is the
  proxy, so the API is reachable on 80 and 443 and nowhere else.

`web` is not the only service with a published port, though, and on a VM that
difference is worth knowing: `postgres` (`POSTGRES_PORT`, 5432), `agent-bot`
(`BOT_PORT`, 4200) and `agent-computer` (`COMPUTER_PORT`, 4100) all publish —
but all three bind `127.0.0.1`, so what they publish to is the host and not the
network. 80 and 443 on `web` are the whole of a deployment's routed surface.

They did not always. Until then the only thing keeping Postgres off the internet
was the cloud ingress list below, which opens 22, 80 and 443 and nothing else —
so a rule there that widened a range rather than naming a port reached the
credential vault directly. The host's own firewall was no second lock either: a
rule written as `INPUT` never sees the packet, because Docker publishes by DNAT
and the packet is forwarded rather than delivered locally. The loopback bind is
the lock that does not depend on either of them being written correctly.

`server` sets `NODE_ENV=production`, which arms two refusals that are otherwise
only warnings: the public example encryption key, and `LAF_DEV_NO_AUTH`.
A development `.env` copied onto a VM fails loudly instead of quietly serving
the internet as one signed-in administrator.

Every service is bounded three ways, because a VM is finite and the failure
mode of each is the whole deployment stopping, not one service misbehaving.
`tests/compose.test.ts` walks every service for all three:

- **Logs.** Every service logs through `json-file` capped at 10MB × 5. Docker's
  default is unbounded, and a full disk stops Postgres.
- **Memory.** Every service has a ceiling, for the recommended 1 OCPU / 6GB VM
  with its 4GB swapfile. Until 2026-09-10 only the browser had one, which
  protected Postgres from Chromium and from nothing else: the process that grows
  with a long conversation is the API, and the host's OOM killer picks the
  largest process on the box — Postgres. A ceiling per service turns "the
  machine is out of memory" into "this one container restarts".

  | service | `mem_limit` | idle, measured 2026-09-10 (`docker stats`, `:stable`) |
  |---|---|---|
  | `agent-computer` | 3g (+ `shm_size: 1g`) | 97–111MB, a browser open |
  | `server` | 1536m | 205–215MB |
  | `postgres` | 1g (+ `shm_size: 256m`, `oom_score_adj: -500`) | 67–69MB |
  | `agent-bot` | 512m | 31–45MB |
  | `migrate` | 512m | one-shot, under 200MB |
  | `web` | 256m | 13–14MB |

  Ceilings, not reservations: the long-lived five sum to 6.25g and the box has
  6g, and that is fine because a service is killed at *its* ceiling long before
  the box is at its own. Measured the same day: a process inside `agent-bot`
  allocating without limit was killed after 256MB held (`OOMKilled=true` on the
  container) while the service itself stayed up, healthy, with zero restarts —
  the cgroup killer takes the largest process in the cgroup, not the container.
  Docker allows swap up to the limit again by default, so 1g is 1g of RAM and
  up to 1g of swapfile before the kill. Compose honours both spellings outside
  swarm; the file uses `mem_limit`, and `docker inspect` reads it back as
  `HostConfig.Memory` (compose 5.1.1). Postgres alone carries a negative
  `oom_score_adj`, so that when the *host* runs out it is the last of these the
  kernel chooses.
- **Postgres itself** is set for the machine rather than for the image's 2005
  defaults: `shared_buffers` 256MB, `effective_cache_size` 768MB, `work_mem`
  8MB, `random_page_cost` 1.1 (the block volume is SSD; 4 is the number for
  spinning disks, and it made the planner shun index scans it should have
  taken), and `log_min_duration_statement` 1000, so any statement over a second
  lands in `docker compose logs postgres` — the first thing to read when "the
  Bot got slow". `SHOW` inside the container reads all five back.
- **Restarts.** Every long-lived service is `unless-stopped`; the migration
  one-shot is `"no"`. A person's VM reboots and their Bots are supposed to still
  be there.

`web` also has a healthcheck that can go red — it asks its own `/health` on a
loopback address the Caddyfile keeps for that, so it is red when the API is
absent or degraded (a 503 either way; the body says which). The front door is
the one service whose death is the product's death, and it used to have nothing.

`POSTGRES_PASSWORD` comes from `.env` now, defaulting to `openbot` so that
existing deployments are unchanged. It is worth setting on a new one — but only
**before the first start**, because the password lives in the postgres volume
once that volume exists; changing it later is an `ALTER USER` inside the running
database, not an edit to `.env`.

## One value names the deployment

```
PUBLIC_ORIGIN=https://<name>.agent.laf-co.com
```

It does two jobs: Caddy takes a certificate for it, and the API issues cookies
for it and trusts it as an origin. The scheme is part of it — to a browser
`https://host` and `host` are different origins, and a mismatch reads as a
session that never sticks rather than as a configuration error.

**The installed shell no longer carries a copy of it.** Since 0.2.0 the window
opens the product's entry page, `https://agent.laf-co.com`, and
`capabilities/default.json` grants `https://*.agent.laf-co.com` alongside it, so
a deployment born at a subdomain there is reached by signing in at the entry —
one build for the whole fleet rather than a binary per deployment. The shell
then **writes that deployment down** and opens there next time (`shell.json`,
`remember_origin`), so the walk through the entry is a first launch rather than
every launch, and a link or a notice resolves against the deployment the person
is on rather than against the entry. [installing.md](installing.md) is what a
person is handed with the installer.

**The wildcard is the only supported shape.** A customer is a name under
`agent.laf-co.com` and nothing else; an apex of its own is no longer supported
(decision 2026-09-03, which retired the one deployment that had one). Two things
follow from that, and they are the reasons:

- **One build for the whole fleet.** The origin is compiled into the shell, so a
  deployment outside the wildcard is its own installer, its own signed release
  and its own update feed — per customer.
- **One sign-in entry.** People arrive at `https://agent.laf-co.com` and are
  walked to their own deployment. An origin the entry cannot hand anybody to is
  reachable only by someone who already knows the address.

The origin still lives in **two values in `desktop/src-tauri`, and they move
together** — they name the entry and the wildcard rather than one customer:

1. `tauri.conf.json` → `app.windows[0].url`
2. `capabilities/default.json` → `remote.urls`

Change the first without the second and the window loads, the app works, and
notifications and the badge silently stop. The bridge feature-detects, so there
is no error anywhere — just an app that quietly stopped being an app.
`tests/desktop-shell.test.ts` fails the build when the window's own origin is
not granted; an origin that is only granted, never opened, is a hand edit
nothing checks.

## Before compose can work

None of this is in the repository, and all of it has to be true at once.

**1. DNS.** An `A` record for the name pointing at the VM's public IP. Caddy
cannot get a certificate for an IP address — Let's Encrypt does not issue them
— so the name has to exist before the first start, not after. A deployment the
control plane provisions gets its own name under `agent.laf-co.com` and the
record written for it; one stood up by hand needs the record written by hand,
and needs it to have propagated.

**2. Cloud ingress.** In OCI, the VCN's security list (or NSG) needs ingress
rules for TCP 80 and 443 from `0.0.0.0/0`. A fresh instance has 22 and nothing
else.

**3. The host's own firewall.** This is the step that catches people, because
the cloud rule looks like it should be enough. Oracle's images ship iptables
rules that drop everything but SSH, so the port is open at the edge and closed
one hop later:

```bash
# Ubuntu images
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

```bash
# Oracle Linux images
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

The symptom of getting this wrong is not an error. Caddy retries an ACME
challenge that cannot complete, so the container comes up and the site never
answers, which looks like a server that is still starting.

## Images: CI bakes, deployments pull

Five images are published to GHCR by `.github/workflows/images.yml` — the
four runtime images and the deploy bundle — on every `v*` tag (`:vX.Y.Z` + `:stable`),
on every push to `main` that changes more than documentation (`:edge`), and
on manual dispatch (`:edge`, optionally promoting `:stable`). The compose
file names them with one channel switch:

```
IMAGE_TAG=stable   # released (default) · vX.Y.Z = pinned · edge = what main is
```

`:edge` **is** "main", since 2026-09-07. Before that it moved only when
somebody ran Images by hand, and was measured twelve days and two sign-in
changes behind main. A burst of pushes builds only the newest — the run for an
older commit is cancelled — so `:edge` can trail main by one run while a burst
settles. What each workflow costs, and why it runs when it does, is under
"비공개 저장소의 CI 비용" at the end of this document.

**Nothing is published until the checks pass.** Every build in `images.yml`
waits on `.github/workflows/checks.yml` — format, lint, types, the test floor
and the app build — run against the tag being published. It is the same file CI
runs on pull requests and branch pushes, called twice rather than copied, so
there is one definition of the gate. Before it existed, a `v*` tag moved
`:stable` in parallel with a CI run it did not wait for and that tags did not
even start: measured on v0.3.2, untested code reached the fleet's default
channel two minutes after the tag was pushed.

So a deployment — human or the external provisioner — never compiles, and
since 2026-09-10 never clones either:

```bash
docker create --name laf-deploy ghcr.io/laf-labs/openbot-deploy:$IMAGE_TAG
docker cp laf-deploy:/deploy/. /home/ubuntu/openbot/
docker rm laf-deploy
docker compose pull
docker compose up -d
```

and an upgrade is the same five lines after the channel moves. Building
locally still works (`docker compose build` produces the same names), which is
what development does; the point is that a customer's one small OCPU never
spends twenty minutes on vite.

**The fifth image is the deploy bundle.** `ghcr.io/laf-labs/openbot-deploy`
holds, under `/deploy/`, exactly what a VM needs on disk and nothing else:
`docker-compose.yml`, `scripts/upgrade.sh`, `scripts/restore.sh`,
`.env.example` and `VERSION`. `deploy/Dockerfile` builds it from `scratch` —
28KB, never run, only ever `docker create`d and `docker cp`'d out, which is
why the three lines above start nothing — and it rides the same tag as the
other four, so `IMAGE_TAG` names one consistent set of five. Until then a VM
held a full `git clone` of this repository at `/home/ubuntu/openbot` for the
sake of those files, and the fleet's upgrade ran `git pull` there: anonymous
HTTPS, which stopped working the day the repository went private, and which
had put the whole source on every customer's machine — the thing going
private is meant to end. A deployment directory now has no `.git`, nothing in
the bundle may assume one, and the copy never touches the directory's own
`.env`.

This is also the contract the external control plane (separate repository)
holds with this one: extract the bundle, write `.env` (the required values
are all in `.env.example`), `pull`, `up`, wait for healthy. Nothing else here
is load-bearing for unattended provisioning.

Recommended VM for one person: **1 OCPU / 6GB + a 4GB swapfile** (measured:
the whole stack idles at 1.1GB; Chromium spikes are what the swap absorbs).
The swapfile is the deployment's to create — cloud-init or by hand:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Standing it up

No checkout. The deployment directory is the bundle's files plus a `.env`:

```bash
mkdir -p ~/openbot && cd ~/openbot
IMAGE_TAG=stable
docker create --name laf-deploy ghcr.io/laf-labs/openbot-deploy:$IMAGE_TAG
docker cp laf-deploy:/deploy/. .
docker rm laf-deploy
cp .env.example .env
```

The packages are private with the repository, so `docker login ghcr.io` with
a token that can read them comes before the `create` — the fleet plants
root's login on every VM ahead of its first pull (laf-control
`core/registry-login.ts`); by hand it is a personal token with
`read:packages`.

Then edit `.env` by hand. The values that have no usable default:

<!-- The first column is held to server/src/config.ts: exactly the variables its ENVIRONMENT marks
"operator", by server/tests/configuration-documents.test.ts. A row added or dropped here without the
same change there fails the gate. -->

| | |
|---|---|
| `PUBLIC_ORIGIN` | the deployed address, with scheme |
| `KEY_ENCRYPTION_KEY` | `openssl rand -base64 32` — the example value is public and refused here |
| `LAF_TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` — seals the provider tokens sign-in stores in `accounts`. Required with sign-in or without: the server refuses to start without it, and refuses the example value. Rows written before it existed are sealed on the next start. Carry it with `KEY_ENCRYPTION_KEY` when a deployment moves; a different key leaves those tokens unreadable, which costs nothing today (nothing spends them) and is replaced at the next sign-in |
| `COMPUTER_TOKEN` | any high-entropy string; the Bot's browser refuses to start without one |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`, at least 32 characters |
| `AUTH_PROVIDERS` | which sign-ins this deployment offers, comma separated: `google`, `kakao`, `naver`, `laf` — see below |
| `<PROVIDER>_OAUTH_CLIENT_ID`, `<PROVIDER>_OAUTH_CLIENT_SECRET` | the pair for each direct provider `AUTH_PROVIDERS` names — `GOOGLE`, `KAKAO`, `NAVER` |
| `LAF_OIDC_ISSUER`, `LAF_OIDC_CLIENT_ID` | the broker's issuer and this deployment's public client id, when `AUTH_PROVIDERS` names `laf` |
| `INITIAL_ADMIN_EMAILS` | who is an administrator on first sign-in |
| `SIGN_IN_ALLOWED_EMAILS` | who may sign in at all. Unset means anyone the provider authenticates gets an account here, which on a one-person VM is the wrong default. It also decides who stays signed in: an address taken off it has every session it holds ended when the server starts with the new list, and any request it still makes is answered `401 laf:session_revoked` |
| `BOT_MODEL` | shipped set in `.env.example` and it must stay set: `agent-bot` refuses to start without it rather than answering on a model nobody chose. The fallback for the API server's own half is `tenant/laf/model.yaml`, and it is the only one in the repository |
| `OPENAI_API_KEY` | the key for the endpoint `OPENAI_BASE_URL` names; the API server and `agent-bot` both spend it, and no Bot answers without one |

`OPENAI_BASE_URL` goes with the key — the deployed default is served through
OpenRouter, so the key is that account's and the base URL is theirs. Every
other variable the server reads has a default, or is optional, or is supplied
by compose; `.env.example` lists all of them.

Remove `LAF_DEV_NO_AUTH` while you are in there. It is refused in
production, so leaving it in is a failed start rather than a security hole, but
a failed start at 2am is still a bad trade for a line nobody needed.

**OAuth is the only way in.** There is no email-and-password path, so a
deployment with no provider configured is one nobody can sign into — including
you. There are two shapes, and `AUTH_PROVIDERS` declares whichever is used:

**Direct apps** — `google`, `kakao`, `naver`. Register each one in its own
console with the redirect URI `{PUBLIC_ORIGIN}/api/auth/callback/<provider>`:

```
https://<name>.agent.laf-co.com/api/auth/callback/google
```

**The fleet's broker** — `laf`, one generic OIDC provider that fronts all three,
so the consoles are registered once for the fleet instead of once per
deployment:

```
AUTH_PROVIDERS=laf
LAF_OIDC_ISSUER=https://auth.agent.laf-co.com
LAF_OIDC_CLIENT_ID=<this deployment's fqdn>
```

There is no secret to set: the client is public on purpose and PKCE carries the
proof, so the pair travels together or not at all — one without the other stops
the server by name. Its callback is `/api/auth/oauth2/callback/laf`, not
`/api/auth/callback/laf`, and the broker registers it when the deployment is
provisioned rather than a person doing it in a console.

Either way the declaration and the credentials must agree, and the server
refuses to start when they do not: `AUTH_PROVIDERS` naming a provider with no
credentials would draw a button that posts into an error, and credentials
without the declaration would accept a sign-in the surface never offers.

The other half of that agreement is **read from the deployment at run time**:
the sign-in screen asks `GET /api/auth/providers` before it draws, and the
server answers with exactly what `AUTH_PROVIDERS` declared. So the buttons
follow `.env`, and a VM switched from `google` to `laf` changes its buttons on
the next restart with no image involved.

The web image still carries a list of its own, compiled at build time from the
`AUTH_PROVIDERS` build arg that `images.yml` fills from the repository variable
`IMAGE_AUTH_PROVIDERS` (`google` if it is unset) — but since 2026-09-06 that
list is only the **fallback**, used when the server cannot answer: an API image
older than the web image (the route does not exist), or a server that cannot be
reached at all. It used to be the whole answer, and the fleet measured what that
meant: an image built for `google` drew a Google button on a VM whose `.env`
said `laf`, and the button posted into a callback the deployment had never
registered. Images built before this date still behave that way, which is why
a rehearsal against the fleet's broker runs on `IMAGE_TAG=edge` until a newer
`:stable` is cut.

Then:

```bash
docker compose pull
docker compose up -d
```

`docker compose build` is for development. A build on a small ARM instance takes
a while and the app build is the memory-hungry part — Oracle's images ship
without swap, and a `docker compose build` that dies without a message is what
that looks like.

## Checking it worked

Reading the logs is not the check. Ask the deployment:

```bash
curl -sS -o /dev/null -w '%{http_code} %{scheme}\n' https://<name>.agent.laf-co.com
docker compose ps
docker compose logs web --tail=30
```

A `200 https` means DNS, both firewalls, ACME and the static build all
worked — the whole chain in one line. `docker compose ps` should show `server`
and `web` healthy; if either is restarting, its logs name the missing setting
directly, because `config.ts` refuses by name rather than crashing on an
undefined.

`server` healthy now means something. `/health` used to return the constant
`{"status":"ok"}` — it said that with the database refusing connections and with
`agent-bot` gone, so the container read healthy while the product was dead. It
now probes the database, `agent-bot` and the Bot's computer, answers 503 when
any of them is down, and names which:

```bash
docker compose exec -T server bun -e "const r = await fetch('http://localhost:3001/health'); console.log(r.status, await r.text())"
# 200 {"status":"ok","checks":{"database":"ok","agentBot":"ok","computer":"ok"}}
```

The same answer is public, at `<PUBLIC_ORIGIN>/health` and at `/api/health`,
so a monitor outside the VM reads it too:

```bash
curl -i https://<name>.agent.laf-co.com/health
# 200 {"status":"ok","checks":{"database":"ok","agentBot":"ok","computer":"ok"}}
```

It was not, until 2026-09-06: the front door handed only `/api/*` to the API, so
a `/health` asked from outside was the SPA's `index.html` — 200, 1,790 bytes,
and still 200 through a six-second API outage, which is what the fleet watcher
had been reading as "alive". A watcher can now hold the API to three things:

- **`200` and `"status":"ok"`** — serving. Anything else is not.
- **`503` with `"status":"degraded"`** — the API is up and `checks` names which
  dependency is down. A probe that is absent is not reported, so a deployment
  with no computer configured has two checks and is not degraded for it.
- **`503` with `"status":"down"`** — the API is not answering at all, and
  `checks` says `"api":"unreachable"`. That comes from the front door
  (`handle_errors` in `app/Caddyfile`), not the API, and every other `/api/*`
  answers `503 {"code":"laf:api_unreachable"}` beside it. Until 2026-09-14 it
  was a `502` with an empty body, which told a watcher nothing it could read
  (`operating.md`, "When there is no API to write the line").

The answer is cached for a few seconds, so polling it costs nothing.

`web` asks the same question of itself, on an address `app/Caddyfile` keeps for
that and compose publishes nowhere. It used to ask Caddy's admin API whether a
configuration was loaded, which is green whatever the API is doing — the same
lie the SPA fallback was telling, one layer down. A dial that cannot go red is
not a dial.

### The headers, the ceilings and the rates

Every answer carries a Content-Security-Policy, HSTS, `nosniff` and
`X-Frame-Options: DENY` — the app's from `app/Caddyfile`, the API's from
`server/src/middleware/security.ts`, never both on one answer. There were none
until 2026-09-13 (audit A8), so the approval button could be framed by any page
and pressed through the frame. Check both halves:

```bash
curl -sI https://<name>.agent.laf-co.com/ | grep -i -E 'content-security|strict-transport|x-frame'
curl -sI https://<name>.agent.laf-co.com/api/version | grep -i -E 'content-security|strict-transport|x-frame'
```

The app's policy allows inline script and nothing evaluated: a sandboxed
component's iframe inherits the page's policy, and a hash-based one refused the
component's own script (measured). A component therefore cannot load a library
from a CDN. A console line naming the policy on any screen is a bug in the app
or in the policy, not noise.

The API refuses a body over a megabyte with `413 laf:body_too_large` before any
route reads it — a Bot's file write is allowed 2.5 MB, and a conversation turn
32 MB, because CopilotKit posts the whole thread with every turn; both only for
a body that declares its length. Three doors answer `429 laf:rate_limited` with
`Retry-After` past a minute's allowance: starting a sign-in (20 per address), a
message (60 per session, 240 per address) and the routine trigger webhook
(30 per token, 60 per address). The counts are in the one API process's
memory, which on a one-VM deployment is all of them, and a restart zeroes them.

## Upgrading

```bash
scripts/upgrade.sh
```

Dump, pull, `up -d`, then wait for that `/health` to answer ok, with the exact
rollback printed if it does not. The bare `docker compose pull && up -d` is the
same upgrade without any of that: no dump to go back to, no waiting, and no
check — so an upgrade that left the deployment answering 503 finishes looking
exactly like one that worked.

The dump lands in `/var/backups/laf` (`BACKUP_DIR` moves it), beside a file
recording what was running **by digest**. That file is not a nicety: a
deployment on `IMAGE_TAG=stable` cannot recover its previous version from
`.env` after the pull, because `stable` has already moved.

Nothing pulls on its own. There is no `pull_policy: always` in the compose file
on purpose, so a reboot or an unrelated `up -d` re-runs what is already on the
machine rather than quietly moving the deployment to a new image.

**The order is the safety.** The dump is taken while everything is still
running; the pull happens before anything is replaced; only `up -d` moves
anything; and the script never writes `.env` — compose reads it, the script
reads one line of it. `tests/upgrade-script.test.ts` drills all of that with a
fake `docker` on PATH (the call order, the bytes of `.env` before and after,
the words it prints), and each case below was also run against a real compose
stack on 2026-09-10:

- **The pull fails** (a registry that refuses, a token that expired, no
  network). Nothing was stopped or replaced; every container keeps the id it
  had and `/health` keeps answering 200. The script says exactly that, names
  the dump it took, and exits 1. Measured with a tag that does not exist:
  `failed to resolve reference … not found`, exit 1, same five container ids.
- **The migration fails.** Compose recreates the changed containers first and
  starts them in dependency order, so the *old* API container is already gone
  when `migrate` exits non-zero: the new one is created and never started
  (`service "migrate" didn't complete successfully: exit 1`, and for the API
  `dependency failed to start`). The front door does **not** wait for either
  — `web` depends on nothing, on purpose — so `/` keeps serving the app (200,
  1,790 bytes) and `/health` answers 503 `down` from Caddy (an empty 502 when
  this was measured): exactly the "API is not answering" state the watcher
  list above reads. Before 2026-09-10 `web`
  waited for the API's container to exist, and one failed migration closed 80
  and 443 with it — connection refused where the monitor is written to read
  the front door's answer, and no ACME renewal while it lasted. The script
  reads `migrate`'s exit code before any health wait, prints the migration's
  own log, says that the schema is where it was (drizzle applies the missing
  migrations in one transaction), and prints the way back.
- **Not healthy** after the wait: the deployment is up and answering 503, or
  not answering. The script prints the three commands that say which
  dependency is down, and the way back.

The way back is printed by both failures and has two steps, and the second is
the *safe* restore:

```
IMAGE_TAG=<previous version> docker compose pull && docker compose up -d
scripts/restore.sh <dump> --replace       # only if the rollback does not come up clean
```

The version to name is read from the inventory file beside the dump (a
deployment on `stable` cannot read it from `.env`), or is `.env`'s own value
when it is a pinned `vX.Y.Z`. The restore line is the one in "Restoring"
below: beside the live database first, every table's row count on both
sides, and the swap only after the name is typed. It used to print
`zcat dump | psql openbot` — the form `restore.sh`'s own header calls
dangerous, and without `--clean` in the dump it half-applies on top of the
live rows. Measured 2026-09-10, the printed line run as printed against a
compose stack: restore beside, `users 2 vs 1 DIFF`, swap, API started,
`/health` ok, 22 seconds.

**The bundle first, then the script.** `laf upgrade` re-extracts the bundle
for the channel `.env` names before it pulls, so the compose file and the
scripts on the VM are the ones the new images were built beside. By hand it
is the three `docker create` / `cp` / `rm` lines above, then
`scripts/upgrade.sh`. The script pulls images only and takes its compose file
from the directory it sits in; it never reached for git, and now there is no
checkout to reach for.

### Rehearsed, not remembered

```bash
bun scripts/upgrade-e2e.ts             # :stable → the five images built from this checkout
bun scripts/upgrade-e2e.ts --to edge   # :stable → what main is, pulled the way a VM pulls it
bun scripts/upgrade-e2e.ts --keep      # …and leave the deployment up to look at
```

The upgrade from the channel customers run to the next build had been measured
by hand exactly once — the rehearsal VM, 68–136 s, data intact — and nothing
proved it again before a release. `scripts/upgrade-e2e.ts` is that rehearsal as
a program. It stands a deployment up the way a VM is stood up: the FROM tag's
bundle extracted, a `.env` with the run's own secrets (production in every way
the server checks — no `LAF_DEV_NO_AUTH`, a declared sign-in provider, keys in
their real shapes), `pull`, `up -d`, the honest `/health`. It seeds it through
the front door as a signed-in person — two Bots, a room with a few messages, a
routine that has run, the Bot's browser opened once, a site connection, and the
trail all of that leaves — and photographs every table. Then it re-extracts the
TO tag's bundle over the directory as `laf upgrade` does and runs
`scripts/upgrade.sh` as written, while `/`, `/health` and `/api/capabilities`
are asked every 0.25 s from outside. What it holds the upgrade to:

- **Every row that existed is still there, unchanged**, column by column over
  the columns both schemas have. Allowed to move, each with its reason in the
  script's `MOVING_COLUMNS`: `updated_at`, a session's `expires_at`, and the
  tenant-package row every boot re-stamps. Rows added during the upgrade are
  reported, never failed — a booting server writes to its trail.
- **The migrations applied once**: one `__drizzle_migrations` row per entry in
  the new image's journal, no hash twice.
- `/health` ok from outside; **the cookie from before still signs the person
  in**; `/api/version` is the new build; the Bot's browser answers `/health`
  **and opens the profile the old computer wrote** (as root, on any image from
  before 2026-09-13); a routine seeded before the upgrade runs after it and
  answers through the model.
- **The dump `upgrade.sh` took is a way back**: `restore.sh --dry-run` on it
  opens nothing, and restored beside the live database it holds every table with
  the row counts the photograph had.

Then it takes away every container, volume and network it made and every image
it pulled or built, and puts back a tag a pull moved.

Three things are stood in for, each the one thing a run cannot have. The model
is a fake the driver serves (`agent-bot/tests/fake-provider.ts`), reached from
the containers at `host.docker.internal` or, on Linux, the default bridge's
gateway; in a room it speaks through `send_message`, because a room member's
plain text is heard by nobody — the first run answered in prose and waited two
minutes on a silent room. The person is a session row carrying better-auth's own
cookie signature, the way the integration tests stand one up: the only real way
in is OAuth. The site connection is a row, because the only route that writes
one reads a Bot's browser signed into the real 스마트스토어.

**A local run builds the five images** as `:e2e-<commit>` and never pushes
them. `upgrade.sh` pulls before it replaces anything, and `docker compose pull`
fails the whole upgrade on a tag the registry does not have, `build:` section or
not (measured: exit 1) — so a local run adds exactly one thing, an override
through `COMPOSE_FILE` that sets `pull_policy: missing` on the services it
built. The web image is vite over sixteen thousand modules and wants most of a
4 GB Docker VM to itself — measured: built in 303 s, then killed for memory at
"rendering chunks" five times running while another checkout's containers
shared the VM, then built in 65 s once they had stopped — so `--no-build` takes
the images an earlier build left, provided each carries this commit's revision
label.

**Weekly on CI**, `.github/workflows/upgrade-e2e.yml`, Mondays 03:10 UTC and by
hand: `:stable` → `:edge`, on one arm64 runner, which is what every customer VM
is. `:edge` must be the commit the run checked out, or one whose every later
change is documentation (images.yml's own `paths-ignore`); anything else stops
the run before it stands a thing up. It did exactly that the first time it was
tried here, against an `:edge` already rebuilt from a newer main.

**Not on a tag, yet.** A tag is where this matters most, and the only run that
could stop a bad release sits between images.yml's per-architecture builds and
its `merge` job, which mints `:vX.Y.Z` and moves `:stable` in one step. A
workflow of its own starts beside images.yml and cannot hold `merge` back.
Holding it back is a job in images.yml that `merge` needs — and since a job
skipped on main skips `merge` with it, `merge` would also need a status
condition of its own to keep publishing `:edge`. That is a change to the job
that moves the fleet's default channel, and it is left to a change about that
job. Until then, before a tag: `gh workflow run upgrade-e2e.yml`, which
rehearses the `:edge` about to be tagged.

Measured 2026-09-14 on Docker Desktop, arm64: `:stable` (v0.4.5, `0e08817`)
upgraded across five migrations (0034–0038, one of which moves the roster
preview off `channels`) to two builds:

| | → this checkout's build (`e71d09e`), two runs | → `:edge` (`8272cea`), pulled |
|---|---|---|
| `upgrade.sh`, start to exit | 24.1 s, 23.6 s (images already local) | 44.7 s |
| `/` down, from outside | 3.0 s, 3.0 s, one window each | 3.0 s, one window |
| `/health` and `/api/capabilities` down | 14.3 s, 14.8 s, one window each | 16.3 s, one window |
| rows | 92 in 36 tables, none lost or changed | the same tables |
| restore beside | 38 tables · 34 equal · 4 differ | 38 · 34 · 4 |
| checks | all 13 pass, both runs | 12 of 13 (below) |
| first command to last check | 63.3 s, 62.6 s | 96.5 s |

The four that differ are the upgrade's own: five migration rows, two boot rows
on the trail (`computer.policy_loaded`, `computer.isolation_loaded`) and two new
empty tables. The `:edge` run came first and failed on a single column —
`deployment_packages.loaded_at`, which `recordTenantPackage` re-stamps on every
boot — which is why that column is on the list; nothing a person wrote moved in
either run.

What the first runs found, and the script keeps reporting until it is not true:

- **There is no `openbot-deploy:stable`.** The bundle was first published
  2026-09-10, after v0.4.5, so on a VM that follows `:stable` the three
  `docker create` / `cp` / `rm` lines above fail with `not found` — the first
  step of standing one up, and of `laf upgrade`. The driver rebuilds the
  directory from git at the commit `:stable`'s images carry, which is what a VM
  cloned then holds, and says so. The next release tag mints it.
- **`:stable`'s compose file never passes `LAF_TOKEN_ENCRYPTION_KEY`**, which
  the new server refuses to start without. A VM whose `.env` was written for
  `:stable` need not have the line, and must gain it before this upgrade. The
  run's own `.env` carries it from the start, so this is read from the two
  compose files, not measured as a failed start.

### What a VM runs

```bash
cat /home/ubuntu/openbot/VERSION
# revision=1ecd51ffa1045d90d2b9a50a4a2ece30e33c5129
# channel=edge
```

The commit the bundle was built from, and the channel that build was made for
— `edge` from main, `vX.Y.Z` from a tag. `:stable` is only ever an alias
minted onto one of those in the merge job (a release, or an `edge` build on a
`promote_stable` dispatch), so a VM on `IMAGE_TAG=stable` reads here what
stable resolved to, which is the question being asked. The four images say the
same commit in their labels
(`docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/laf-labs/openbot-server:$IMAGE_TAG`),
and they agree with `VERSION` exactly when the bundle and the images were
taken in the same upgrade — which `laf upgrade` guarantees, and a by-hand
upgrade guarantees only if the bundle was refreshed first. `git rev-parse` in
`/home/ubuntu/openbot` used to be this answer; there is no checkout to ask now.

## Backups

The trail is the product — audit rows, Bot memory, encrypted credentials all
live in the one Postgres volume — so the VM carries its own dump schedule.
Nothing in this repository runs on the VM's crontab: the control plane's
provisioning installs the script and this line, and the first one (2026-08-25)
was installed by hand.

```bash
# /etc/cron.d/laf-db-backup
0 4 * * * root /usr/bin/flock -n /run/lock/laf-backup.lock /usr/local/sbin/laf-backup-db
```

`/usr/local/sbin/laf-backup-db` pipes `pg_dump` out of the compose Postgres
into `/var/backups/laf/` (gzip, `umask 077`) and keeps the newest fourteen.

### What a backup holds, and what it does not

A backup is **the database and nothing else**. Said plainly because
`data-lifecycle.md` used to say more, and a restore that does less than the
document promised is discovered on the day it matters.

- **In it:** every table — the trail, conversations, Bot profiles and
  memories, routines, the encrypted credential vault, the sign-in providers'
  `accounts` tokens sealed with `LAF_TOKEN_ENCRYPTION_KEY` (since 2026-09-13;
  dumps taken before that carry them in the clear — measured 2026-09-10, audit
  A5 §5), and better-auth's `sessions.token`, which is still **in plaintext**.
  A dump is a credential file and is handled as one: `umask 077` on disk, a write-only door to the
  bucket, thirty days and gone.
- **Not in it — the Bot's browser profiles** (`agent-profiles`, one Chromium
  directory per Bot; 67MB for three Bots on the development machine). This is
  where a Bot's logins live — 스마트스토어, 홈택스, the bank — as cookies, not
  rows, and no SQL reaches them. They are left out **on purpose**: the dump is
  not encrypted at rest, so a tar of the profiles beside it would put the
  session cookies of a business's bank in a bucket for thirty days, which is a
  worse exposure than the login it would save; and a Chromium profile copied
  while the browser runs is a set of half-written SQLite files. Encrypting the
  backups is a fleet decision (`laf-control`, where the script lives) and has
  not been taken. **So a restore onto a new VM means every site is signed in
  again, by hand, once per Bot.** On the same VM (the rollback case above) the
  profiles are untouched and the logins survive — only the rows move back in
  time. Either way `scripts/restore.sh --replace` marks every row of
  `laf_site_connections` as needing a login, because a restored row saying
  "connected" is a claim about a cookie the restore did not carry, and a
  routine runs on that claim and comes back empty in the morning; the first
  visit that finds the login still there clears the mark.
- **Never in it — `.env`.** `KEY_ENCRYPTION_KEY` is what opens the credential
  vault the dump carries, and `LAF_TOKEN_ENCRYPTION_KEY` what opens the provider
  tokens sign-in left in `accounts` (sealed since 2026-09-13; a dump used to
  carry them in the clear); a backup holding either key beside the dump is those
  secrets in plaintext. The keys are the operator's to keep (the fleet holds each
  deployment's `.env`), and a dump restored onto a VM with different keys reads
  every credential and token as unreadable bytes — that is the design, not a
  fault. Neither `upgrade.sh` nor
  `restore.sh` reads `.env` for anything but the channel name, and
  `tests/upgrade-script.test.ts` compares its bytes before and after.
- **Not in it — `caddy-data`** (certificates). A new VM asks Let's Encrypt
  again; five of those in a week is a rate limit measured in days, which is
  why the volume exists, and why it is not worth a backup.

**Ubuntu Minimal ships no cron daemon** — `apt-get install -y cron` first, or
the schedule silently never fires. Learned the measured way: the entry sat for
two days doing nothing until the fleet monitor read the backup age, because
running the script by hand had proven the script, not the schedule.

### Restoring, and the monthly drill

```bash
scripts/restore.sh latest              # newest dump in /var/backups/laf → openbot_restore, then the table
scripts/restore.sh latest --replace    # …and only then: stop the API, swap the names, start, /health
```

The bare form — `zcat dump | docker compose exec -T postgres psql -U openbot openbot` —
restores **into** the live database: every row since the dump is gone the moment
it finishes, and a dump that turns out to be the wrong day's, or empty, or from
before a migration, is discovered afterwards, on top of the data it replaced.
`scripts/restore.sh` restores into a database of its own (`openbot_restore`,
`RESTORE_DB` renames it), prints every table's row count on both sides, and
stops:

```
   table                                                live   restored
   drizzle.__drizzle_migrations                           36         36  =
   public.audit_events                                  1204       1180  DIFF (-24)
   public.users                                            3          3  =
   …
   33 tables · 31 equal · 2 differ · restore took 3s
```

A day's difference on `audit_events`, `laf_thread_messages` and the run tables
is what yesterday's dump looks like; a difference on `users`, `agents` or
`credentials` is a question to answer before going further. The live database
is read for its counts and never written without `--replace`. Re-running is
safe: a target that already holds a restore is refused until `--fresh` says to
drop it, and `--replace` keeps the previous live database under a dated name
(`openbot_before_restore_<stamp>`) rather than dropping it — drop that by hand
once the restored deployment has been used. `--replace` runs the migration
container before the API, the same path an upgrade takes, so an older dump is
brought forward to the current schema. `--dry-run` prints the plan and opens
no connection at all.

**Drill monthly, on a dump from the day before.** The point of a drill is not
that the script works — `tests/restore-script.test.ts` proves that on every
gate — but that *this deployment's* dumps restore, in a known number of
seconds, to the row counts it has. Once a month, on the VM:

1. `scripts/restore.sh latest` — read the table. Every table present on both
   sides, the slow-moving ones equal, the fast-moving ones a day behind.
2. Open the app against the restored copy if the month's change touched the
   schema: `DATABASE_URL=…/openbot_restore` on a second API process, or simply
   trust the counts when it did not.
3. `docker compose exec -T postgres psql -U openbot -d postgres -c 'drop database openbot_restore'`.
4. Write down the date, the table count and the seconds where the fleet keeps
   its log. A restore that took 3s last month and 40s this month is a
   database that grew, and that is worth knowing before the day it matters.

A dump that only exists in the bucket cannot be listed from the VM — it holds
a **write-only** door. The fleet tool does the whole trip from the operator's
machine: `laf restore <name> [--from YYYY-MM-DD] [--dry-run]` reads the bucket
with the operator's credentials, mints a one-object, one-hour read door, has
the VM download its own dump straight from the bucket (the bytes never pass
through the operator's machine), and runs this script without `--replace`
(laf-control README §3.9). `--dry-run` there is the monthly drill: it reads
the bucket, checks the VM, and prints the command. By hand instead:
`OFFSITE_BUCKET=laf-backup-<name> scripts/restore.sh latest` on the operator's
machine (the `oci` CLI; `OFFSITE_REGION` if the bucket is not in the config's
default region), or `oci os object get`, then `scp` to the VM and the file
form above.

First drill, 2026-09-06, against the development database: a 607KB dump,
33 tables, 33 equal, restore 1s (4.6s wall including the two count queries);
a second run without `--fresh` refused as designed; the swap was rehearsed
against a throwaway live name (`LIVE_DB=openbot_drill … --replace --yes`,
1.8s), never `openbot`.

The same dump also goes off the machine, when — and only when —
`/etc/laf-backup-remote` exists: a root-only file holding a **write-only**
upload URL for that deployment's own object-storage bucket, which the control
plane mints and installs. Absent, the script keeps its local copies and says
nothing, so one script serves a fresh VM and a fully wired one. An upload that
fails logs and does not fail the run: the local dump already succeeded, and the
alarm for a broken upload is the fleet monitor reading the bucket, not the
script grading itself. A VM without that file is back to the old limit — the
dumps survive a bad migration or a fat-fingered delete, not the machine.

**백업은 사람이 떠난 뒤에도 그 사람을 갖고 있다.** `POST /api/me/delete`는
데이터베이스와 봇의 브라우저 프로필을 지우지만, 어제 만든 덤프는 지우지 못한다 —
덤프는 그 시점의 전체 사본이고 이 저장소의 코드가 닿지 않는 곳(VM의 `/var/backups/laf`와
객체 스토리지 버킷)에 있다. 그래서 **보존 기간은 30일이다**(결정: `redesign-2026-09.md`
§7-7). 로컬은 `laf-backup-db`가 최신 14벌만 남기므로 2주 안에 사라지고, **원격 버킷은
수명주기 규칙이 30일 뒤 지운다** — 객체도, 덮어쓰기가 묻은 이전 버전도. 규칙은 함대 도구가
버킷을 만들 때 건다(laf-control `core/offsite.ts`의 표 하나가 두 클라우드의 본문이 된다).
규칙이 정말 걸려 있는지는 **API에서 읽어서** 본다 — 오프사이트 잡의 "수명주기 규칙 확인"
단계와 `laf offsite lifecycle <name>`이 그 일이고, 이 저장소가 무엇을 썼다고 기억하는지는
증거가 아니다(첫 실물 버킷은 손으로 30일이 걸려 있는 동안 코드는 90일을 쓰고 있었다,
2026-09-06 실측). 계정 삭제 요청을 받았고 그 사람이 30일을 기다릴 수 없다면, 그때는 해당
시점 이후의 덤프를 손으로 지우는 것 말고 방법이 없다 — 덤프는 한 사람만 골라낼 수 있는
형식이 아니다. 사람에게 설명해야 하는 내용은 `docs/laf/data-lifecycle.md`에 그 사람의 말로
적혀 있다.

## The shell

The installed app is a separate release and needs one thing this repository
cannot carry: a signing key.

Done 2026-08-25: the pair whose pubkey sits in `tauri.conf.json` (key id
`3E9A4235FEC7D535`) was generated fresh — the previous pubkey's private half
was unrecoverable from the retired prime shell — and its private half and
password are this repository's `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secrets. The owner holds the key
file outside any repository; losing it means a new pair, a new pubkey commit,
and every installed app reinstalling by hand, because an installed app refuses
a manifest signed by anything but the key its config names.

To rotate again:

```bash
bunx tauri signer generate -w <somewhere-private>/laf-agent.key
```

then replace the secrets and the `pubkey` in `tauri.conf.json` in the same
change — a release signed by a key the config does not name builds and
publishes fine and is then rejected by every installed app.

### An advisory the shell's lockfile carries, and Tauri's pin holds

**GHSA-wrw7-89jp-8q8g** (RUSTSEC-2024-0429, medium): unsound `Iterator` and
`DoubleEndedIterator` impls on `glib::VariantStrIter`, in `glib` 0.15 up to
0.20. `desktop/src-tauri/Cargo.lock` holds `glib` 0.18.5. Dependabot alert #1
opened on 2026-09-10, and the security update it runs for it fails every time
(2026-09-10 and 2026-09-13): `security_update_not_possible`, latest resolvable
0.18.5, lowest fixed 0.20.0.

Nothing here asks for glib. Tauri 2.11.5 builds its Linux webview on the GTK 3
bindings — `tauri-runtime-wry` 2.11.4 → `wry` 0.55.1 and `tao` 0.35.3 →
`webkit2gtk` =2.0.2 and `gtk` ^0.18 → `glib` ^0.18 — and none of that chain has
a release on a later glib: `webkit2gtk` 2.0.2 is its newest, and the newest
`wry` (0.57.0) and `tao` (0.37.0) still require `gtk` ^0.18 (crates.io,
2026-09-14). So neither a bump of glib nor a bump of Tauri resolves it today.

It is not in anything that ships. The chain is compiled for Linux and the BSDs
only, and the shell ships for macOS and Windows (`release.yml`):

```bash
cd desktop/src-tauri
cargo tree -i glib@0.18.5 --target aarch64-apple-darwin --locked   # nothing to print
cargo tree -i glib@0.18.5 --target x86_64-pc-windows-msvc --locked # nothing to print
cargo tree -i glib@0.18.5 --target x86_64-unknown-linux-gnu --locked # glib v0.18.5
```

`.github/dependabot.yml` ignores `glib` 0.19 and later, so Dependabot stops
proposing the jump that cannot resolve and would still propose a fix released
on 0.18. That does not close the alert: while it is open, Dependabot keeps
running the security update and ends it as `all_versions_ignored`. Dismissing
the alert ("vulnerable code is not actually used") is the owner's decision on
GitHub. Revisit both — and take the ignore out — in the change that ships the
shell for Linux or moves Tauri off `gtk` 0.18.

## 비공개 저장소의 CI 비용

2026-09-10에 이 저장소는 비공개가 됐다. 조직은 GitHub **Free** 플랜이고, 비공개
저장소의 Actions는 한 달 **2,000분**까지만 포함된다 — 공개 저장소일 때는 표준
러너가 무제한 무료였다. GitHub 문서는 지금 OS별 배수 대신 SKU별 분당 단가로
적는다: Linux x64 `$0.006`, Linux arm64 `$0.005`, Windows `$0.010`, macOS
`$0.062`. 예전 배수(Windows ×2, macOS ×10)와 같은 비율이라 아래 가중치는 그
배수로 센다.

공개 상태이던 9월 1–10일 실측(`openbot` 저장소, 청구 API 기준):

| SKU | 분 | 가중치 | 가중 분 |
| --- | ---: | ---: | ---: |
| Actions Linux | 627 | ×1 | 627 |
| Actions Linux ARM | 107 | ×1 | 107 |
| Actions Windows | 111 | ×2 | 222 |
| Actions macOS 3-core | 83 | ×10 | 830 |
| 합계 | 928 | | **1,786** |

열흘에 1,786분 — 그대로 두면 열하루 만에 한 달치를 다 쓴다. 어디서 나왔는지는
실행 단위로 세면 보인다(작업마다 분 단위 올림, GitHub이 청구하는 방식 그대로):

- `ci.yml`: `main` 푸시 77회 × 4분 = 308분. 그중 62회는 문서만 바뀐 푸시였고,
  나머지 15회는 `images.yml`이 같은 커밋에 같은 `checks.yml`을 한 번 더 돌렸다.
- `images.yml`: 22회(`main` 15, 태그 7) × (Linux 13분 + arm64 5분).
- `release.yml`: 8회(`main` 1, 태그 7) × (macOS 10–13분 ×10 + Windows 13–16분
  ×2) ≈ 회당 130–160 가중 분. **태그 하나가 한 달치의 7%다.**
- `smoke.yml` 매일 1분(모델 키가 없어 여정을 건너뜀 — 키를 넣으면 회당 15분쯤),
  `security_zizmor.yml` 회당 1분.

2026-09-10부터 각 워크플로가 도는 조건:

| 워크플로 | 도는 때 | 안 도는 때 |
| --- | --- | --- |
| `ci.yml` | PR, `laf/**` 푸시 | `main`과 태그(`images.yml`이 같은 `checks.yml`을 돌린다), 문서만 바뀐 푸시 |
| `images.yml` | `v*` 태그, `main` 푸시, 수동 | 문서만 바뀐 푸시 — `docs/**`, 루트 `*.md`, `**/README.md`. `app/src/**/*.md`는 이미지에 들어가므로 돈다 |
| `release.yml` | `v*` 태그, `desktop/**`나 `release.yml`이 바뀐 `main` 푸시, 수동. PR은 `shell` 테스트만 | 그 밖의 `main` 푸시 전부 |
| `smoke.yml` | 매일 02:40 UTC, 수동 | — |
| `security_zizmor.yml` | `.github/**` 변경, 매주 월요일 | — |
| `upgrade-e2e.yml` | 매주 월요일 03:10 UTC, 수동 | 푸시와 태그 전부 — 태그에 걸지 않은 이유는 위 "Rehearsed, not remembered" |

`ci.yml`·`images.yml`·`release.yml`은 ref별 `concurrency` 그룹이라 한 브랜치에
푸시가 몰리면 가장 최근 것만 끝까지 돈다. 태그는 취소하지 않는다.

같은 속도로 한 달을 가정한 추정 — 코드 푸시 45회, 문서 푸시 186회, 태그 3회, 셸
변경 2회: Linux+arm64 ≈ 45×18 + 3×18 + 40 ≈ 900분, macOS·Windows ≈ 5회 × 140 ≈
700 가중 분, 합계 **≈ 1,600–1,700 가중 분/월**. 9월 첫 열흘처럼 태그를 일곱 개
찍으면 넘친다 — 태그가 가장 비싼 행위이고, 리허설은 `:edge`로 한다.

`upgrade-e2e.yml`(2026-09-14 추가)은 arm64 러너 한 대에서 회당 약 8분(6–10분)으로
추정한다. 로컬 실측으로 이미지가 이미 있을 때 처음부터 끝까지 63–97초였고, 러너는
여기에 두 이미지 묶음을 처음부터 받는 시간이 더해진다 — `:stable`의 서버 이미지만
1.92GB이고 로컬에서 그 한 장을 받는 데 92초가 걸렸다. 러너에서는 아직 재지 않았다.
주 1회면 월 35분 안팎으로, 위 합계를 거의 움직이지 않는다.

arm64 러너는 그대로 둔다. GitHub 러너 문서는 `ubuntu-24.04-arm`을 비공개
저장소용 표준 러너로도 적고(2 vCPU/8GB, 공개용은 4/16), 그 러너들이 포함 분을
쓰고 넘으면 분당 단가로 청구된다고 쓴다 — Linux arm64 `$0.005`는 x64보다 싸다.
고객 VM이 Ampere A1이라 arm64 이미지는 선택이 아니고, QEMU 대체는 측정한 적이
없다.

- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/billing/reference/actions-runner-pricing

이번 달 사용량은 한 줄로 읽는다(조직 오너 권한):

```bash
gh api "/orgs/LAF-labs/settings/billing/usage?year=2026&month=9"
```

항목마다 `sku`(`Actions Linux`, `Actions Linux ARM`, `Actions Windows`,
`Actions macOS 3-core`), `quantity`(분), `repositoryName`이 온다. 조직 설정의
예산 알림을 켜 두면 포함 분의 90%와 100%에서 메일이 온다.
