# Configuration

LAF Agent is configured with environment variables and a tenant package. The API server validates both at startup.

## Environment setup

```sh
cp .env.example .env
```

Fill the required values, then run:

```sh
bash scripts/start.sh
```

Every variable below is one the code actually reads, and the table says where. A name that appears
in `.env.example` but in no table here is read by nothing.

## Required API server variables

The server refuses to start without these three (`server/src/config.ts`).

| Variable                      | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string.                                                                         |
| `KEY_ENCRYPTION_KEY`          | Base64-encoded 32-byte key for encrypted stored credentials. Generate with `openssl rand -base64 32`. |
| `MANAGED_AGENT_AG_UI_URL`     | Default AG-UI endpoint for coworkers created in the product. Must be HTTP(S).                         |

Threads and memory live in this deployment's own PostgreSQL and there is no other option. Four
`INTELLIGENCE_*` variables once selected a hosted runtime instead; no deployment ever set them and
they are gone.

## General API server variables

| Variable                        | Default                | Meaning                                                                                                                              |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                          | `3001`                 | API server port.                                                                                                                     |
| `NODE_ENV`                      | unset                  | `production` turns three local-only conveniences into startup refusals: the example encryption key, `LAF_DEV_NO_AUTH`, and its legacy spelling. |
| `TENANT_PACKAGE_DIR`            | `../tenant/laf`        | Tenant package directory, resolved from `server/`.                                                                                   |
| `OPENAI_API_KEY`                | unset                  | Model key, when no stored credential answers for the package's `credential_secret_ref`. Resolved per call, so revoking one takes effect on the next action rather than the next restart. |
| `OPENAI_BASE_URL`               | `https://api.openai.com/v1` | OpenAI-compatible endpoint the key is spent against. Moves the whole deployment. See below.                                      |
| `AGENT_STALL_TIMEOUT_MS`        | `0` (watchdog off)     | How long a Bot's stream may say nothing before the deployment ends the turn. Refuses to start on anything that is not a whole number ≥ 0. |
| `BOT_SEATS_PER_ACCOUNT`         | `5`                    | Bots one person may have. Enforced where a Bot is created, so a sixth fails to exist rather than existing with no computer to reach.  |
| `LAF_NOTIFY_WEBHOOK_URL`        | unset                  | Where "a Bot is blocked on you" is delivered. Unset, it is a log line.                                                                |
| `PUBLIC_ORIGIN`                 | unset                  | The address this deployment answers as, scheme included. Caddy's certificate and the API's cookie origin come from it, and it is what the fleet identifies this customer by. Required once `LAF_FLEET_WEBHOOK_URL` is set. |
| `LAF_FLEET_WEBHOOK_URL`         | unset                  | Where a sign-up and a withdrawal reach the fleet tool, which creates and destroys the machine. Unset is silent, and the server says so once at boot: a withdrawal then completes here and the VM outlives the person who left it. |
| `LAF_FLEET_WEBHOOK_SECRET`      | unset                  | Signs the exact body bytes: `x-laf-signature: sha256=<hex HMAC-SHA256>`. **Required once the URL is set** — the server refuses to start otherwise, because the endpoint on the other end destroys machines. |
| `CAFE24_CLIENT_ID`, `CAFE24_CLIENT_SECRET` | unset       | The fleet's own Cafe24 OAuth application, the same on every VM. Both or neither: a client with no secret fails at the token exchange, which is after somebody has consented. Unset, Cafe24 does not appear on the 연결 screen at all. |
| `LAF_OAUTH_RELAY_URL`           | unset                  | The fleet's OAuth relay. Vendors are told `<this>/<provider>`, and the relay hands the browser back to `https://<slug>/api/plugins/oauth/callback` — the one address a fleet-wide client can have registered, since no vendor accepts a wildcard. https, except on `localhost`. Unset, every vendor is told this deployment's own callback. |
| `LAF_PRODUCT_DOMAIN`            | the relay's parent domain | The domain every customer is a name under. The slug is `PUBLIC_ORIGIN`'s label beneath it, and an origin that is not one name under it **refuses to start** — the consent would otherwise die at the relay, after the person had already said yes. |
| `COPILOTKIT_TELEMETRY_DISABLED` | `true`                 | Set by the server on itself before the runtime loads. Set it to something else deliberately if you want the runtime's telemetry.      |

`BOT_MODEL` is read by `agent-bot`, not by the API server — see [Bot endpoint](#bot-endpoint) below.
`REVIEW_MODEL` and `BOT_MODEL_EFFORT` are read by nothing directly: they are substituted into the
tenant package's `model.yaml`, and the section on that file says how.

## OpenAI-compatible endpoints

`OPENAI_BASE_URL` decides where an OpenAI-shaped request is answered. Unset, that is OpenAI. Set, it is any endpoint speaking the same API: a gateway in front of several providers, a proxy, or a model on hardware you control.

It moves the whole deployment rather than one Bot. The API server reads it for package built-in agents, and `agent-bot` reads it for the client it constructs, so one line moves the built-in agents and the Bots together and a deployment cannot end up with half of itself pointed somewhere else.

Model names travel verbatim, so use whatever the endpoint publishes. An endpoint that namespaces its catalogue wants both halves of the name, in `BOT_MODEL` and in the tenant package's `default_model` alike.

A gateway that fronts several providers behind one key is addressed the usual way:

```sh
OPENAI_BASE_URL=https://gateway.internal/v1
OPENAI_API_KEY=...
BOT_MODEL=openai/gpt-4o
```

and in the tenant package, where the name is namespaced the same way:

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: openai/gpt-4o
```

Most gateways publish a model list, which is the way to check a name before configuring it.

One thing is worth knowing before pointing a deployment at any gateway: not every catalogue entry
accepts tools, and a Bot without tool calling cannot drive its computer. The model list says which
do.

## Authentication

Three providers can be configured directly, plus the fleet's own broker. Everything here is read in
`server/src/config.ts` and `server/src/auth/`.

| Variable                                                | Meaning                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PROVIDERS`                                        | Comma-separated declaration: `google`, `kakao`, `naver`, `laf`. The server publishes it on `GET /api/auth/providers` and the sign-in screen draws its buttons from that answer; the list compiled into the web image is only the fallback for a server that cannot answer. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`  | Google OAuth client. Both or neither. **Also the application every Google 연결 consents under** (Drive, Sheets, Gmail, Calendar, Business Profile): one client, one console, with the sign-in callback and the relay's connector callback both registered on it. |
| `KAKAO_OAUTH_CLIENT_ID`, `KAKAO_OAUTH_CLIENT_SECRET`    | Kakao OAuth client. Both or neither.                                                                                       |
| `NAVER_OAUTH_CLIENT_ID`, `NAVER_OAUTH_CLIENT_SECRET`    | Naver OAuth client. Both or neither.                                                                                       |
| `LAF_OIDC_ISSUER`                                       | The fleet broker's origin, for `AUTH_PROVIDERS=laf`. Must be an HTTP(S) URL; a trailing slash is stripped.                  |
| `LAF_OIDC_CLIENT_ID`                                    | This deployment's public broker client (its own fqdn). No secret exists — PKCE is the proof. Travels with the issuer or not at all. |
| `BETTER_AUTH_SECRET`                                    | At least 32 characters. Required once any provider is configured.                                                          |
| `BETTER_AUTH_URL`                                       | Public API server base URL. Required once any provider is configured.                                                      |
| `TRUSTED_ORIGINS`                                       | Comma-separated app origins accepted by the API. Defaults to `http://localhost:3000`, which is **not** where `start.sh` serves the app. |
| `INITIAL_ADMIN_EMAILS`                                  | Comma-separated. An address here becomes an administrator the first time it signs in; everybody else becomes a user.        |
| `SIGN_IN_ALLOWED_EMAILS`                                | Comma-separated, and the actual door. Unset means open: anybody the provider authenticates gets an account. Admin emails are admitted on top, so listing staff cannot lock the owner out. |
| `LAF_DEV_NO_AUTH`                                       | Local-only fixed administrator when `true`. See below.                                                                     |
| `OPENBOT_DEV_NO_AUTH`                                   | The pre-rename spelling. It no longer enables anything, but with `NODE_ENV=production` it still refuses to start — a stale `.env` that meant "no auth" must fail loudly rather than fall through to an authentication state nobody chose. |

**The declaration decides what the API registers.** `AUTH_PROVIDERS` naming a provider with no
credentials stops the server — it would draw a button that posts into an error. The other direction
is no longer a refusal: a pair the declaration does not name is simply not offered as a sign-in, so
the API cannot accept one the surface never shows. That is because `GOOGLE_OAUTH_*` has a second
job — it is also the fleet's connector application, the one every 구글 연결 consents under — and a
VM signing people in through the broker (`AUTH_PROVIDERS=laf`) carries the pair with no Google
button. Refusing that combination made the two features mutually exclusive. With `AUTH_PROVIDERS`
unset entirely, every configured pair is offered, which is what a laptop wants. Each provider's
redirect URI is the origin plus `/api/auth/callback/<provider>`.

`LAF_DEV_NO_AUTH=true` admits every request as one fixed administrator, `dev@laf.local`, so the
product runs with no OAuth credentials and no consent screen. It is for a laptop. Two independent
locks keep it there: it does nothing unless it is set, and with `NODE_ENV=production` the server
**refuses to start** rather than ignoring the flag — a deployment that believes it has
authentication when it does not is the worst of the three states. `.env.example` ships it on, so a
fresh clone runs without sign-in; a deployment removes it (`server/src/auth/dev-actor.ts`).

## Computer

What the API server reads about the computer:

| Variable                             | Default            | Meaning                                                                                                          |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AGENT_COMPUTER_URL`                 | unset              | The account's computer. Absent, the computer routes are **not mounted** — a capability that is not configured should be missing, not broken. |
| `COMPUTER_TOKEN`                     | unset              | Secret every computer request must present. Without it every call to a computer is refused, which is the intended failure. |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | `false`            | Lets a Bot reach services on this machine, when `true`. Cloud metadata addresses are refused under every configuration. |
| `AGENT_COMPUTER_POLICY`              | built-in default   | JSON action policy: `{"mode":"enforce","deny":[...],"ask":[...],"allow":[...]}`. Malformed JSON or the wrong shape **stops startup** rather than falling back — an operator who mistyped a rule would otherwise get a deployment that silently permits what they had just tried to forbid. |
| `COMPUTER_REPEAT_WINDOW_MS`          | `180000` (3 min)   | How long two identical calls count as the same repetition. Refuses to start on anything that is not a positive whole number. Widen it on a slow or heavily queued provider, where genuine retries arrive minutes apart and a rule about repetition never fires at all. |

What `agent-computer` reads of its own (`agent-computer/src/`):

| Variable                 | Default       | Meaning                                                                                                    |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `COMPUTER_TOKEN`         | —             | Required. It **refuses to start without it**, and compose does not supply one on its own.                  |
| `PORT`                   | `4100`        | Listening port.                                                                                            |
| `NAVIGATION_TIMEOUT_MS`  | `30000`       | How long a page load may take.                                                                             |
| `ACTION_TIMEOUT_MS`      | `10000`       | How long one click, type or read may take.                                                                 |
| `WORKSPACE_DIR`          | `/workspace`  | The Bots' shared folder of files.                                                                          |
| `PROFILES_DIR`           | `/profiles`   | Where each Bot's Chromium profile lives.                                                                   |
| `COMPUTER_BOT_ID`        | `shared`      | The profile used when a request carries no `x-openbot-bot-id` header. There is always a fallback, so a caller that omits the header is silently on the wrong Bot rather than on none. |
| `EGRESS_PROXY_DEFAULT`   | unset         | Proxy for every Bot without one of its own.                                                                |
| `EGRESS_PROXY_<BOT_ID>`  | unset         | One Bot's proxy. The Bot id is uppercased with non-alphanumerics turned into `_`, so `sales-bot` reads `EGRESS_PROXY_SALES_BOT`. |

Proxy credentials may appear in proxy URLs, but the computer strips them before reporting proxy status.

## Bot endpoint

`agent-bot` is the AG-UI endpoint every Bot a person creates runs on. It reads four variables
(`agent-bot/src/index.ts`):

| Variable          | Default                       | Meaning                                                                     |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `PORT`            | `4200`                        | Listening port. It reads the shared `../.env`, where `PORT` is the API server's, so start it by hand with the override — see [development](development.md). |
| `BOT_MODEL`       | `gpt-5.5`                     | The model, sent verbatim, because an endpoint names its own catalogue.       |
| `OPENAI_BASE_URL` | OpenAI                        | The endpoint that answers. Same value as the API server's, deliberately.     |
| `OPENAI_API_KEY`  | unset                         | The key spent against it.                                                    |

## Ports

| Service           | Default port               | Setting           |
| ----------------- | -------------------------- | ----------------- |
| `app`             | 3010                       | `APP_PORT`        |
| `server`          | 3001                       | `SERVER_PORT`     |
| `agent-computer`  | 4100                       | `COMPUTER_PORT`   |
| `agent-bot`       | 4200                       | `BOT_PORT`        |
| PostgreSQL        | 5432                       | `POSTGRES_PORT`   |

Set these in `.env` or in the environment. `docker-compose.yml` publishes on them and
`scripts/start.sh` reads the same names to decide where to look, so one setting moves a service and
everything that talks to it. The three compose publishes — Postgres, `agent-computer`, `agent-bot`
— bind `127.0.0.1`, so the port reaches the host and not the network; only `web` (80 and 443) is
published to every interface. The addresses built from them are separate settings, so a moved service
also needs its URL changed: `DATABASE_URL`, `AGENT_COMPUTER_URL` and `MANAGED_AGENT_AG_UI_URL`.

`POSTGRES_MAX_CONNECTIONS` sets PostgreSQL's connection limit, and defaults to its own default of
100. A deployment runs one API server process and never approaches it. It is raised only to run
more than one test suite at once against the same server; see [development](development.md).

To run two deployments on one Docker host, give the second one its own `COMPOSE_PROJECT_NAME`.
Container and volume names are global to a host, and the project name is what keeps each
deployment's containers and volumes its own.

Both deployments then mint thread ids under the same name — the tenant package's id — so the six
leading bytes of a thread id no longer tell one from the other. Nothing in the product reads that
today; it matters if you ever have to work out which deployment a loose thread id belongs to. Give
the second one its own tenant package with a different `tenant.id` if you need them separable.

## Tenant package

The tenant package contains two required YAML files:

```text
tenant/laf/
├── brand.yaml
└── model.yaml
```

It once had three more. `agents.yaml` and `channels.yaml` declared Bots and rooms the deployment
shipped ready-made; the product decided a Bot starts with nothing set and belongs to the person who
made it, both lists went empty, and the loop that read them has been deleted. `knowledge.yaml`
declared connector sources for a plane that never had an adapter behind it.

### `brand.yaml`

```yaml
tenant:
  id: openbot
  product_name: LAF Agent
```

Optional theme:

```yaml
skin:
  stylesheet: theme.css
```

Theme CSS may define only `:root` and `.dark` blocks, approved theme variables, and no `@import` or `url()`.

Any `${NAME}` in a package file is replaced with that environment variable, so one package works
against a local stack, a staging one and production. `${NAME:-fallback}` uses the fallback when the
name is unset or empty, which is how the example package points at the Bot in the box without
requiring any configuration. A name with neither a value nor a fallback stops the server with a
message saying which file wanted it, rather than leaving a Bot pointed at an address nobody meant.

### `model.yaml`

The shipped package is written entirely in substitutions, which is where three environment variables
that the server never reads by name actually land:

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: ${BOT_MODEL:-gpt-4.1}
  supports_effort: ${BOT_MODEL_EFFORT:-true}
  review_model: ${REVIEW_MODEL:-}
```

`provider` must be `openai`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

| Field / variable                    | Default   | What it decides                                                                                                     |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `default_model` / `BOT_MODEL`       | `gpt-4.1` | The model the deployment serves. Note `agent-bot`'s own default differs (`gpt-5.5`); set `BOT_MODEL` and both follow it. |
| `supports_effort` / `BOT_MODEL_EFFORT` | `true` | Whether this model reasons, and therefore takes an effort setting. **An assertion, not a description** — the provider otherwise guesses from the model's name, and a model served under a name only we choose can never be recognised by a heuristic. Set it `false` on a model that does not reason: nothing is sent, and the control disappears from the Bot's profile rather than sitting there doing nothing. |
| `review_model` / `REVIEW_MODEL`     | the same model | Which model judges a Bot owner's "do not ask me about" instruction. Point it at something small and fast: that judgement runs in front of an action, and on the flagship model a yes/no took ten to thirty seconds — longer than a person often takes to press the button themselves. |

Both variables reach the substitution and not the server, so a deployment that sets them in the
shell but does not pass them into the `server` service in `docker-compose.yml` runs on the defaults
forever, with no error to say so.

Swapping the model is a ritual rather than a debate: `bun run eval:model` drives the real
`agent-bot` stack against a candidate and gives a verdict. See [laf/eval-pack.md](laf/eval-pack.md).

## Change workflow

1. Edit the relevant `.env` value or tenant YAML file.
2. Keep credential values out of YAML.
3. Restart the API server; invalid configuration stops startup.
4. Run the gate ([development](development.md)):

   ```sh
   bun run typecheck
   bunx biome lint .
   bun run format:check
   DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
   ```
