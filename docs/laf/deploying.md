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

Three bounds are in the file because a VM is finite and the failure mode of
each is the whole deployment stopping, not one service misbehaving:

- **Logs.** Every service logs through `json-file` capped at 10MB × 5. Docker's
  default is unbounded, and a full disk stops Postgres.
- **The browser.** `agent-computer` gets `mem_limit: 3g` and `shm_size: 1g`.
  Chromium is the one process here that can eat the machine; past the limit the
  kernel kills the browser, which restarts, instead of killing whatever the OOM
  killer would otherwise pick on a 6GB box — which is Postgres.
- **`web`** has a healthcheck at last, against Caddy's own admin API on the
  container's loopback. The front door is the one service whose death is the
  product's death, and it had nothing.

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
one build for the whole fleet rather than a binary per deployment.

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

The four deployment images are published to GHCR by
`.github/workflows/images.yml` — on every `v*` tag (`:vX.Y.Z` + `:stable`),
and on manual dispatch (`:edge`, optionally promoting `:stable`). The compose
file names them with one channel switch:

```
IMAGE_TAG=stable   # released (default) · vX.Y.Z = pinned · edge = the last manual dispatch
```

`:edge` is **not** "main". Nothing publishes on a push to `main`: `:edge` moves
only when somebody runs Images by hand, so an `:edge` deployment is sitting on
whichever commit was dispatched last, which may be weeks old.

**Nothing is published until the checks pass.** Every build in `images.yml`
waits on `.github/workflows/checks.yml` — format, lint, types, the test floor
and the app build — run against the tag being published. It is the same file CI
runs on pull requests and branch pushes, called twice rather than copied, so
there is one definition of the gate. Before it existed, a `v*` tag moved
`:stable` in parallel with a CI run it did not wait for and that tags did not
even start: measured on v0.3.2, untested code reached the fleet's default
channel two minutes after the tag was pushed.

So a deployment — human or the external provisioner — never compiles:

```bash
docker compose pull
docker compose up -d
```

and an upgrade is the same two commands after the channel moves. Building
locally still works (`docker compose build` produces the same names), which is
what development does; the point is that a customer's one small OCPU never
spends twenty minutes on vite.

This is also the contract the external control plane (separate repository)
holds with this one: clone, write `.env` (the required values are all in
`.env.example`), `pull`, `up`, wait for healthy. Nothing else here is load-
bearing for unattended provisioning.

Recommended VM for one person: **1 OCPU / 6GB + a 4GB swapfile** (measured:
the whole stack idles at 1.1GB; Chromium spikes are what the swap absorbs).
The swapfile is the deployment's to create — cloud-init or by hand:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Standing it up

```bash
git clone https://github.com/LAF-labs/openbot.git && cd openbot
cp .env.example .env
```

Then edit `.env` by hand. The values that have no usable default:

| | |
|---|---|
| `PUBLIC_ORIGIN` | the deployed address, with scheme |
| `KEY_ENCRYPTION_KEY` | `openssl rand -base64 32` — the example value is public and refused here |
| `COMPUTER_TOKEN` | any high-entropy string; the Bot's browser refuses to start without one |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`, at least 32 characters |
| `AUTH_PROVIDERS` | which sign-ins this deployment offers, comma separated: `google`, `kakao`, `naver`, `laf` — see below |
| the credentials naming them | `<PROVIDER>_OAUTH_CLIENT_ID` / `_SECRET` per direct provider, or `LAF_OIDC_ISSUER` + `LAF_OIDC_CLIENT_ID` for the broker |
| `INITIAL_ADMIN_EMAILS` | who is an administrator on first sign-in |
| `SIGN_IN_ALLOWED_EMAILS` | who may sign in at all. Unset means anyone the provider authenticates gets an account here, which on a one-person VM is the wrong default |
| `BOT_MODEL` | shipped set in `.env.example` and it must stay set: `agent-bot` refuses to start without it rather than answering on a model nobody chose. The fallback for the API server's own half is `tenant/laf/model.yaml`, and it is the only one in the repository |

`OPENAI_API_KEY` and `OPENAI_BASE_URL` go with it — the deployed default is
served through OpenRouter, so the key is that account's and the base URL is
theirs.

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
healthy; if it is restarting, its logs name the missing setting directly,
because `config.ts` refuses by name rather than crashing on an undefined.

`server` healthy now means something. `/health` used to return the constant
`{"status":"ok"}` — it said that with the database refusing connections and with
`agent-bot` gone, so the container read healthy while the product was dead. It
now probes the database, `agent-bot` and the Bot's computer, answers 503 when
any of them is down, and names which:

```bash
docker compose exec -T server bun -e "const r = await fetch('http://localhost:3001/health'); console.log(r.status, await r.text())"
# 200 {"status":"ok","checks":{"database":"ok","agentBot":"ok","computer":"ok"}}
```

Asked from inside the container because `server` is unpublished — there is no
port on the host to curl. The answer is cached for a few seconds, so polling it
costs nothing.

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

**Ubuntu Minimal ships no cron daemon** — `apt-get install -y cron` first, or
the schedule silently never fires. Learned the measured way: the entry sat for
two days doing nothing until the fleet monitor read the backup age, because
running the script by hand had proven the script, not the schedule.
Restore is the reverse:

```bash
zcat /var/backups/laf/laf-<stamp>.sql.gz |   docker compose exec -T postgres psql -U openbot openbot
```

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
객체 스토리지 버킷)에 있다. 그래서 **보존 기간은 30일이고, 실제 파기는 이 백업 스크립트가
한다**(결정: `redesign-2026-09.md` §7-7). `laf-backup-db`는 지금 최신 14벌만 남기므로 로컬
사본은 이미 2주 안에 사라지지만, **원격 버킷에는 만료 규칙이 없다** — 버킷에
30일 수명주기 정책을 걸거나, 업로드 뒤 30일이 지난 객체를 지우는 한 줄을 스크립트에
넣어야 한다. 그 전까지 "계정을 지웠다"는 문장은 데이터베이스에 대해서만 참이다. 계정
삭제 요청을 받았고 그 사람이 30일을 기다릴 수 없다면, 그때는 해당 시점 이후의 덤프를 손으로
지우는 것 말고 방법이 없다 — 덤프는 한 사람만 골라낼 수 있는 형식이 아니다. 사람에게
설명해야 하는 내용은 `docs/laf/data-lifecycle.md`에 그 사람의 말로 적혀 있다.

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
