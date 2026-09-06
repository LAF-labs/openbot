import {
  CATALOGUE,
  type CatalogueEntry,
  type DeploymentKeyFamily,
  type SharedClientFamily,
} from "./catalogue";

/**
 * The OAuth applications LAF registered once, for the whole fleet, read from this deployment's
 * environment.
 *
 * WHY FROM THE ENVIRONMENT AND NOT FROM THE VAULT. Every other credential in this product belongs
 * to somebody: a person's refresh token, an administrator's pasted client. These belong to the
 * PLATFORM. A shop owner does not have a Google Cloud project and will never make one, so the only
 * arrangement in which "구글 계정으로 연결" is one button is the one where the application is ours,
 * the same on every VM, and the person supplies nothing but their consent.
 *
 * The pair is all-or-nothing per vendor, like every other half-configured thing in this codebase: a
 * client id without a secret is a connector that fails at the token exchange, which is after the
 * person has already said yes at the vendor.
 */

/** What a caller gets back: the deployment's identity at one vendor, or nothing. */
export type SharedOAuthClient = { clientId: string; clientSecret: string };

/**
 * How a caller asks. A function rather than a record so the store and the routes take a seam a test
 * can drive, instead of reading `process.env` from four places at four different moments.
 */
export type SharedClientLookup = (
  family: SharedClientFamily,
) => SharedOAuthClient | null;

/**
 * The two environment names per vendor.
 *
 * Google's pair is the one a deployment may already have set, because it is also the sign-in
 * application (`AUTH_PROVIDERS=google`). That is deliberate and it is what "one Google client for
 * all" means: one application in one console, with the fleet's sign-in callback and the relay's
 * connector callback both registered on it.
 */
export const SHARED_CLIENT_ENV: Readonly<
  Record<SharedClientFamily, { id: string; secret: string }>
> = Object.freeze({
  google: {
    id: "GOOGLE_OAUTH_CLIENT_ID",
    secret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  cafe24: { id: "CAFE24_CLIENT_ID", secret: "CAFE24_CLIENT_SECRET" },
});

type Environment = Record<string, string | undefined>;

/**
 * Every shared client this environment carries.
 *
 * A pair with one half set is refused rather than half-used: the failure it produces otherwise
 * arrives at the token exchange, which is after somebody has consented at the vendor and can no
 * longer be told anything useful.
 */
export function sharedClientsFrom(
  environment: Environment,
): Partial<Record<SharedClientFamily, SharedOAuthClient>> {
  const found: Partial<Record<SharedClientFamily, SharedOAuthClient>> = {};
  for (const [family, names] of Object.entries(SHARED_CLIENT_ENV) as [
    SharedClientFamily,
    { id: string; secret: string },
  ][]) {
    const clientId = environment[names.id]?.trim();
    const clientSecret = environment[names.secret]?.trim();
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error(
        `${names.id} and ${names.secret} must be set together: a client with no secret cannot complete a token exchange, and the failure lands after somebody has already consented`,
      );
    }
    if (clientId && clientSecret) found[family] = { clientId, clientSecret };
  }
  return found;
}

/** A lookup over a resolved set. The one shape everything downstream takes. */
export function lookupOver(
  clients: Partial<Record<SharedClientFamily, SharedOAuthClient>>,
): SharedClientLookup {
  return (family) => clients[family] ?? null;
}

/** Nothing configured. The default everywhere a lookup is optional, and what tests inherit. */
export const NO_SHARED_CLIENTS: SharedClientLookup = () => null;

/**
 * Can this deployment actually complete a consent for this entry?
 *
 * `true` for the two older shapes — a vendor that registers clients itself, and one an
 * administrator pastes a client in for — because both of those can be completed from inside the
 * product. For a shared-client entry it is whether the fleet configured that vendor at all.
 *
 * This is what keeps a card that cannot connect off the screen. A control that saves and does
 * nothing is worse than no control, and a 연결 button in front of a vendor with no application
 * behind it is exactly that: it opens a consent screen that ends in `invalid_client`, which reads
 * to the person as their own account being at fault.
 */
export function entryIsConnectable(
  entry: CatalogueEntry,
  sharedClient: SharedClientLookup,
): boolean {
  if (entry.auth.kind !== "user-oauth") return false;
  const family = entry.auth.sharedClient;
  if (!family) return true;
  return sharedClient(family) !== null;
}

/** The entries a person may be offered a 연결 button for, in catalogue order. */
export function connectableCatalogue(
  sharedClient: SharedClientLookup,
): CatalogueEntry[] {
  return CATALOGUE.filter((entry) => entryIsConnectable(entry, sharedClient));
}

/* ── API keys the platform obtained once, for data that is everybody's ───────────────────────── */

/**
 * The one environment name per key.
 *
 * A key rather than a pair, so the all-or-nothing rule above has nothing to apply to. What it has
 * instead is a SPELLING rule — see {@link deploymentKeysFrom}.
 */
export const DEPLOYMENT_KEY_ENV: Readonly<Record<DeploymentKeyFamily, string>> =
  Object.freeze({ "data-go-kr": "DATA_GO_KR_SERVICE_KEY" });

/** How a caller asks for a key. The same seam shape as {@link SharedClientLookup}. */
export type DeploymentKeyLookup = (
  family: DeploymentKeyFamily,
) => string | null;

/**
 * What a query-string value may carry without being encoded: unreserved characters and the percent
 * escapes of an already-encoded one. Anything else in a key is the decoded spelling.
 */
const QUERY_SAFE = /^[A-Za-z0-9%._~-]+$/;

/**
 * Every deployment key this environment carries, refusing the spelling that cannot work.
 *
 * data.go.kr issues each key twice: "encoding" (`%2B`, `%3D`, `%2F` in it) and "decoding" (`+`,
 * `=`, `/`). Its gateway compares the RAW query string, and the adapters concatenate the key into
 * that string without encoding it — because encoding the encoded spelling turns `%2B` into `%252B`,
 * which is a key nobody registered. The decoded spelling fails the same way from the other side: a
 * `+` on a query string is a space. Either mistake produces a deployment that boots, lists the
 * tools, and answers every call with `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`, which reads to a shop
 * owner as the government being down. So the wrong spelling is refused here, at boot, by name.
 */
export function deploymentKeysFrom(
  environment: Environment,
): Partial<Record<DeploymentKeyFamily, string>> {
  const found: Partial<Record<DeploymentKeyFamily, string>> = {};
  for (const [family, name] of Object.entries(DEPLOYMENT_KEY_ENV) as [
    DeploymentKeyFamily,
    string,
  ][]) {
    const value = environment[name]?.trim();
    if (!value) continue;
    if (!QUERY_SAFE.test(value)) {
      throw new Error(
        `${name} must be the URL-encoded spelling data.go.kr issues (the one with %2B and %3D in it): it goes into the query string as-is, and the decoded spelling reads as an unregistered key at the vendor`,
      );
    }
    found[family] = value;
  }
  return found;
}

/** A lookup over a resolved set of keys. */
export function keyLookupOver(
  keys: Partial<Record<DeploymentKeyFamily, string>>,
): DeploymentKeyLookup {
  return (family) => keys[family] ?? null;
}

/** No keys. The default wherever a lookup is optional, and what tests inherit. */
export const NO_DEPLOYMENT_KEYS: DeploymentKeyLookup = () => null;

/**
 * May this entry be listed at all on this deployment?
 *
 * Only a deployment-key entry can answer no, and it does so exactly when the key is absent: the
 * partner rule again — a card, or a row on the admin's catalogue, in front of a vendor this VM
 * holds no key for is a control that can only ever refuse. Every other entry is listed as before.
 */
export function entryIsOffered(
  entry: CatalogueEntry,
  deploymentKey: DeploymentKeyLookup,
): boolean {
  if (entry.auth.kind !== "deployment-key") return true;
  return deploymentKey(entry.auth.key) !== null;
}
