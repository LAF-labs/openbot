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

## Required API server variables

| Variable                      | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string.                                                                         |
| `KEY_ENCRYPTION_KEY`          | Base64-encoded 32-byte key for encrypted stored credentials. Generate with `openssl rand -base64 32`. |
| `MANAGED_AGENT_AG_UI_URL`     | Default AG-UI endpoint for coworkers created in the product. Must be HTTP(S).                         |

Threads and memory live in this deployment's own PostgreSQL and there is no other option. Four
`INTELLIGENCE_*` variables once selected a hosted runtime instead; no deployment ever set them and
they are gone.

## General variables

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port.                                                    |
| `NODE_ENV`           | unset                              | `production` enables startup refusals for local-only settings.      |
| `TENANT_PACKAGE_DIR` | `../tenant/laf`                    | Tenant package directory, resolved from `server/`.                  |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and `agent-bot`.              |
| `OPENAI_BASE_URL`    | unset                              | OpenAI-compatible endpoint that key is spent against. See below.    |
| `BOT_MODEL`          | provider default from Bot code/env | Model used by `agent-bot`.                                          |

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

Two things are worth knowing before pointing a deployment at any gateway. Not every catalogue entry accepts tools, and a Bot without tool calling cannot drive its computer; the model list says which do. And `BOT_RESPONSES_API=true` needs an endpoint that implements the Responses API, not only chat completions.

## Authentication

| Variable                     | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `LAF_OIDC_ISSUER`            | The fleet broker's origin, for `AUTH_PROVIDERS=laf`. Travels with the client id or not at all. |
| `LAF_OIDC_CLIENT_ID`         | This deployment's public broker client (its own fqdn). No secret exists — PKCE is the proof. |
| `LAF_DEV_NO_AUTH`        | Local-only fixed administrator when set to `true`. Refused with `NODE_ENV=production`. |
| `GOOGLE_OAUTH_CLIENT_ID`     | Google OAuth client id.                                                                |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret.                                                            |
| `BETTER_AUTH_SECRET`         | At least 32 characters. Required with Google OAuth.                                    |
| `BETTER_AUTH_URL`            | Public API server base URL. Required with Google OAuth.                                |
| `TRUSTED_ORIGINS`            | Comma-separated app origins accepted by the API.                                       |
| `INITIAL_ADMIN_EMAILS`       | Comma-separated users seeded as administrators.                                        |

Google OAuth client id and secret must be configured together. If Google OAuth is configured, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are also required.

## Computer

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL`                 | The account's computer. If absent, computer routes are not mounted.                       |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.     |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. Cloud metadata addresses are still refused. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"ask":[...],"allow":[...]}`.          |

`agent-computer` also reads:

- `ACTION_TIMEOUT_MS`
- `NAVIGATION_TIMEOUT_MS`
- `WORKSPACE_DIR`
- `PROFILES_DIR`
- `COMPUTER_BOT_ID`
- `EGRESS_PROXY_DEFAULT`
- `EGRESS_PROXY_<BOT_ID>`

Proxy credentials may appear in proxy URLs, but the computer strips them before reporting proxy status.

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

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: gpt-4.1
```

`provider` must be `openai`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

## Change workflow

1. Edit the relevant `.env` value or tenant YAML file.
2. Keep credential values out of YAML.
3. Restart the API server; invalid configuration stops startup.
4. Run:

   ```sh
   bun run format:check
   bun run lint
   bun run typecheck
   bun run test
   ```
