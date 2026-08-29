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

## One value names the deployment

```
PUBLIC_ORIGIN=https://sajuhook.com
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

An origin outside that wildcard — an apex of its own, the way `sajuhook.com` is
— is **two values in `desktop/src-tauri`, and they move together**:

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
IMAGE_TAG=stable   # released (default) · edge = main · vX.Y.Z = pinned
```

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

Remove `LAF_DEV_NO_AUTH` while you are in there. It is refused in
production, so leaving it in is a failed start rather than a security hole, but
a failed start at 2am is still a bad trade for a line nobody needed.

**OAuth is the only way in.** There is no email-and-password path, so a
deployment with no provider configured is one nobody can sign into — including
you. There are two shapes, and `AUTH_PROVIDERS` declares whichever is used:

**Direct apps** — `google`, `kakao`, `naver`. Register each one in its own
console with the redirect URI `{PUBLIC_ORIGIN}/api/auth/callback/<provider>`:

```
https://sajuhook.com/api/auth/callback/google
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

The other half of that agreement is **baked into the web image**, not read from
`.env`: the sign-in buttons are compiled at build time from the `AUTH_PROVIDERS`
build arg, which `images.yml` fills from the repository variable
`IMAGE_AUTH_PROVIDERS` (`google` if it is unset). A deployment whose `.env` says
`laf` while the image it pulled was built for `google` starts cleanly and shows
the wrong buttons: nothing at run time compares the baked set with the
deployment's. Changing which sign-ins the fleet offers is that variable and a
rebuild, not a per-deployment setting.

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
curl -sS -o /dev/null -w '%{http_code} %{scheme}\n' https://sajuhook.com
docker compose ps
docker compose logs web --tail=30
```

A `200 https` means DNS, both firewalls, ACME and the static build all
worked — the whole chain in one line. `docker compose ps` should show `server`
healthy; if it is restarting, its logs name the missing setting directly,
because `config.ts` refuses by name rather than crashing on an undefined.

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
