import {
  CATALOGUE,
  type CatalogueEntry,
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
