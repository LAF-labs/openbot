# Deploying

One VM, one person, one `docker compose up`. This is what that takes and, more
usefully, what goes wrong at each step. `docs/laf/deployment-model.md` is why
the shape is a single VM; this is how to stand one up.

## What the compose file adds

Two services that did not exist before, because until now nothing served the
app to anybody:

- **`web`** — the only service with published ports. Terminates TLS, serves the
  built app out of the image, and proxies `/api/*` to the API. Its certificates
  live in the `caddy-data` volume.
- **`server`** — the API. Deliberately unpublished. The only route in is the
  proxy, so a deployment opens 80 and 443 and nothing else.

`server` sets `NODE_ENV=production`, which arms two refusals that are otherwise
only warnings: the public example encryption key, and `OPENBOT_DEV_NO_AUTH`.
A development `.env` copied onto a VM fails loudly instead of quietly serving
the internet as one signed-in administrator.

## One value names the deployment

```
PUBLIC_ORIGIN=https://sajuhook.com
```

It does three jobs: Caddy takes a certificate for it, the API issues cookies
for it, and the installed shell is built pointing at it. The scheme is part of
it — to a browser `https://host` and `host` are different origins, and a
mismatch reads as a session that never sticks rather than as a configuration
error.

The shell's copy of it is **two more values**, in `desktop/src-tauri`:

1. `tauri.conf.json` → `app.windows[0].url`
2. `capabilities/default.json` → `remote.urls`

Change the first without the second and the window loads, the app works, and
notifications and the badge silently stop. The bridge feature-detects, so there
is no error anywhere — just an app that quietly stopped being an app.

## Before compose can work

None of this is in the repository, and all of it has to be true at once.

**1. DNS.** An `A` record for the name pointing at the VM's public IP. Caddy
cannot get a certificate for an IP address — Let's Encrypt does not issue them
— so the name has to exist before the first start, not after.

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
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | see below |
| `INITIAL_ADMIN_EMAILS` | who is an administrator on first sign-in |

Remove `OPENBOT_DEV_NO_AUTH` while you are in there. It is refused in
production, so leaving it in is a failed start rather than a security hole, but
a failed start at 2am is still a bad trade for a line nobody needed.

**Google is the only way in.** There is no email-and-password path, so a
deployment without OAuth configured is one nobody can sign into — including
you. Register the client in Google Cloud Console with the redirect URI:

```
https://sajuhook.com/api/auth/callback/google
```

Then:

```bash
docker compose build
docker compose up -d
```

Building on a 2-OCPU ARM instance takes a while, and the app build is the
memory-hungry part. Oracle's images ship without swap; if `docker compose
build` dies without a message, that is what happened.

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

## The shell

The installed app is a separate release and needs one thing this repository
cannot carry: a signing key.

The pubkey in `tauri.conf.json` came from the retired `LAF-labs/prime` shell
and its private half no longer exists — it lived only as an Actions secret
there, and a GitHub secret cannot be read back out by anyone, its owner
included. So the first release generates a fresh pair:

```bash
bunx tauri signer generate -w ~/.tauri/laf-agent.key
```

The private half goes into this repository's secrets as
`TAURI_SIGNING_PRIVATE_KEY` (and its password as
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), entered by a person. The public half
replaces the `pubkey` in `tauri.conf.json`, committed in the same change — a
release signed by a key the config does not name builds and publishes fine and
is then rejected by every installed app.

Doing this now costs nothing: nothing signed by the old key was ever published,
so no installed app is holding it.
