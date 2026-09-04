import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  CATALOGUE,
  authEndpointsFor,
  catalogueEntry,
} from "../src/plugins/catalogue";
import {
  isCustomerSlug,
  relayRedirectUriFor,
  relayStateFor,
  sealedPartOf,
} from "../src/plugins/oauth";
import {
  connectableCatalogue,
  entryIsConnectable,
  lookupOver,
  NO_SHARED_CLIENTS,
  sharedClientsFrom,
} from "../src/plugins/shared-clients";
import { testEnvironment } from "./support/environment";

/**
 * The fleet's OAuth relay, as three decisions taken before anybody presses anything.
 *
 * WHY A RELAY IS THE SUBJECT OF A TEST FILE AT ALL. Google and Cafe24 compare `redirect_uri` for
 * exact equality against a value registered once, and the fleet is `*.agent.laf-co.com` — a set with
 * no fixed members. Every mistake this file guards against therefore shows up in the SAME place: at
 * the vendor, after the person has already said yes, with nothing left to tell them. A slug derived
 * from the wrong half of a hostname, a state the callback cannot open, an entry offered on a
 * deployment holding no application behind it — none of those are visible from the surface, and all
 * of them look to the person like their own account being at fault.
 *
 * No database and no network: what is under test here is arithmetic on strings and one refusal at
 * boot. The flow itself is in `plugin-relay-connect.test.ts`.
 */

const RELAY = "https://auth.agent.laf-co.com/oauth/relay";

/** The environment a real fleet member boots with, minus whatever a test wants to remove. */
const fleetEnvironment = (overrides: Record<string, string | undefined> = {}) =>
  testEnvironment({
    PUBLIC_ORIGIN: "https://sunny.agent.laf-co.com",
    LAF_OAUTH_RELAY_URL: RELAY,
    ...overrides,
  });

/* ── the state a relay can read one label out of ─────────────────────────────────────────────── */

describe("the state a relayed consent travels on", () => {
  test("the customer's name goes in front, separated by the one character neither half can hold", () => {
    // A sealed state is base64url and a slug is a DNS label: neither can contain a dot, so the
    // split at the first one is unambiguous rather than merely conventional.
    expect(relayStateFor("sunny", "AbC-123_xyz")).toBe("sunny.AbC-123_xyz");
  });

  test("the sealed half comes back whether or not a relay left its label on", () => {
    expect(sealedPartOf("sunny.AbC-123_xyz")).toBe("AbC-123_xyz");
    // A relay that strips the slug and one that forwards the state verbatim are both working
    // relays. Only what this deployment can unseal decides anything either way.
    expect(sealedPartOf("AbC-123_xyz")).toBe("AbC-123_xyz");
  });

  test("only the FIRST dot separates, so a sealed half is never truncated", () => {
    expect(sealedPartOf("sunny.a.b.c")).toBe("a.b.c");
  });

  test("a state that is nothing but a label yields an empty seal rather than the label", () => {
    // Which the callback then fails to open. Returning "sunny" would hand `redeemConnectState`
    // something that looks like a state.
    expect(sealedPartOf("sunny.")).toBe("");
  });

  test("one segment per shared application, not per catalogue entry", () => {
    // Five Google connectors consent under one Google application, which has one registered
    // redirect URI between them. A per-entry address would be five registrations for one client.
    expect(relayRedirectUriFor(RELAY, "google")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/google",
    );
    // A trailing slash on the configured value must not become a double one: a vendor compares
    // this string character for character.
    expect(relayRedirectUriFor(`${RELAY}/`, "cafe24")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/cafe24",
    );
  });
});

describe("what may stand in front of a state", () => {
  test("a DNS label is a slug", () => {
    expect(isCustomerSlug("sunny")).toBe(true);
    expect(isCustomerSlug("sunny-mart-2")).toBe(true);
    expect(isCustomerSlug("a")).toBe(true);
  });

  test("anything carrying the separator, or the shape of a deeper host, is not", () => {
    // A slug with a dot would name a host the fleet's allow-list does not hold, AND it would move
    // where the state splits — the two failures reinforce each other.
    expect(isCustomerSlug("sunny.agent")).toBe(false);
    expect(isCustomerSlug("")).toBe(false);
    expect(isCustomerSlug("-sunny")).toBe(false);
    expect(isCustomerSlug("sunny-")).toBe(false);
    expect(isCustomerSlug("Sunny")).toBe(false);
    expect(isCustomerSlug("sunny_mart")).toBe(false);
  });
});

/* ── what a deployment reads out of its own environment ──────────────────────────────────────── */

describe("the relay a deployment boots with", () => {
  test("the slug is the label PUBLIC_ORIGIN has under the relay's parent domain", () => {
    const { connectors } = loadConfig(fleetEnvironment());
    expect(connectors.relay).toEqual({
      url: RELAY,
      slug: "sunny",
      productDomain: "agent.laf-co.com",
    });
  });

  test("a trailing slash is dropped, because the provider segment is appended to it", () => {
    const { connectors } = loadConfig(
      fleetEnvironment({ LAF_OAUTH_RELAY_URL: `${RELAY}/` }),
    );
    expect(connectors.relay?.url).toBe(RELAY);
  });

  test("no relay configured is a deployment that answers vendors itself", () => {
    const { connectors } = loadConfig(
      fleetEnvironment({ LAF_OAUTH_RELAY_URL: undefined }),
    );
    expect(connectors.relay).toBeUndefined();
    // The shared clients are still read: a laptop with a Google client registered against its own
    // callback is a working development deployment, and the relay is not what makes it one.
    expect(connectors.clients.google).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
  });

  test("an origin outside the product domain refuses to start rather than consenting into nowhere", () => {
    // The consent would die at the relay — AFTER the person said yes at the vendor, which is the
    // worst moment for a deployment to discover it was misconfigured.
    expect(() =>
      loadConfig(
        fleetEnvironment({ PUBLIC_ORIGIN: "https://sunny.example.com" }),
      ),
    ).toThrow(/not one name under agent\.laf-co\.com/);
  });

  test("an origin naming a deeper host under the domain is refused too", () => {
    expect(() =>
      loadConfig(
        fleetEnvironment({ PUBLIC_ORIGIN: "https://a.b.agent.laf-co.com" }),
      ),
    ).toThrow(/not one name under/);
  });

  test("a relay with no origin to hand the browser back to refuses", () => {
    expect(() =>
      loadConfig(fleetEnvironment({ PUBLIC_ORIGIN: undefined })),
    ).toThrow(/PUBLIC_ORIGIN must be too/);
  });

  test("a plaintext relay is refused: it is the address a vendor is told to send a code to", () => {
    expect(() =>
      loadConfig(
        fleetEnvironment({
          LAF_OAUTH_RELAY_URL: "http://auth.agent.laf-co.com/oauth/relay",
        }),
      ),
    ).toThrow(/must be https/);
  });

  test("localhost is the exception, so a development relay can be stood up on this machine", () => {
    const { connectors } = loadConfig(
      fleetEnvironment({
        LAF_OAUTH_RELAY_URL: "http://localhost:9099/oauth/relay",
        LAF_PRODUCT_DOMAIN: "localhost.test",
        PUBLIC_ORIGIN: "https://sunny.localhost.test",
      }),
    );
    expect(connectors.relay?.slug).toBe("sunny");
  });

  test("LAF_PRODUCT_DOMAIN overrides the domain derived from the relay's own address", () => {
    // The derived answer here would be `agent.laf-co.com` and the origin would be refused under it.
    // The override is for the day the relay stops living at `auth.<product domain>`, and this is
    // the case that proves it decides rather than merely agreeing.
    const { connectors } = loadConfig(
      fleetEnvironment({
        LAF_PRODUCT_DOMAIN: "laf-co.com",
        PUBLIC_ORIGIN: "https://sunny.laf-co.com",
      }),
    );
    expect(connectors.relay?.productDomain).toBe("laf-co.com");
    expect(connectors.relay?.slug).toBe("sunny");
  });
});

/* ── the applications the fleet registered, and what they make visible ───────────────────────── */

describe("the shared OAuth applications", () => {
  test("a pair with one half missing refuses to start", () => {
    // The failure it would otherwise produce arrives at the token exchange, which is after somebody
    // has consented at the vendor and can no longer be told anything useful.
    expect(() =>
      sharedClientsFrom({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      }),
    ).toThrow(/must be set together/);
    expect(() =>
      sharedClientsFrom({
        CAFE24_CLIENT_ID: undefined,
        CAFE24_CLIENT_SECRET: "secret",
      }),
    ).toThrow(/must be set together/);
  });

  test("a vendor the fleet never configured is simply absent", () => {
    const clients = sharedClientsFrom({
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    });
    expect(clients.google).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
    expect(clients.cafe24).toBeUndefined();
  });

  test("an entry whose family has no application behind it is not connectable", () => {
    const googleOnly = lookupOver(
      sharedClientsFrom({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      }),
    );
    expect(entryIsConnectable(catalogueEntry("gmail")!, googleOnly)).toBe(true);
    expect(entryIsConnectable(catalogueEntry("cafe24")!, googleOnly)).toBe(
      false,
    );
    // Notion registers its own client, so it never depended on the fleet's environment.
    expect(entryIsConnectable(catalogueEntry("notion")!, googleOnly)).toBe(
      true,
    );
  });

  test("a deployment holding nothing offers only the entries that need nothing", () => {
    const keys = connectableCatalogue(NO_SHARED_CLIENTS).map(
      (entry) => entry.key,
    );
    expect(keys).toContain("notion");
    expect(keys).not.toContain("gmail");
    expect(keys).not.toContain("cafe24");
    // And every entry that IS offered can actually be consented to, which is the property the
    // surface depends on: a 연결 button in front of a vendor with no application ends in
    // `invalid_client`, and reads to the person as their own account being at fault.
    for (const entry of connectableCatalogue(NO_SHARED_CLIENTS)) {
      expect(entry.auth.kind).toBe("user-oauth");
      expect(
        entry.auth.kind === "user-oauth" ? entry.auth.sharedClient : "unset",
      ).toBeUndefined();
    }
  });

  test("every entry naming a family has environment variables behind it", () => {
    // The closed union is what makes this hold, and this is the assertion that says so out loud: a
    // family added to the catalogue without a pair in `SHARED_CLIENT_ENV` would be an entry nothing
    // could ever configure.
    const everything = lookupOver(
      sharedClientsFrom({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        CAFE24_CLIENT_ID: "id",
        CAFE24_CLIENT_SECRET: "secret",
      }),
    );
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "user-oauth" || !entry.auth.sharedClient) {
        continue;
      }
      expect(everything(entry.auth.sharedClient)).not.toBeNull();
    }
  });

  test("every entry that consents under a shared application is relayed", () => {
    // The two travel together by necessity: an application shared by the fleet cannot name a
    // per-customer redirect URI, so an entry with a family and no relay would be one nobody but the
    // first deployment could ever connect.
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "user-oauth" || !entry.auth.sharedClient) {
        continue;
      }
      expect(entry.relay).toBe(true);
    }
  });
});

/* ── a vendor that gives every customer its own hostname ─────────────────────────────────────── */

describe("Cafe24's three addresses", () => {
  const cafe24 = catalogueEntry("cafe24")!;

  test("the mall's own host fills the templates", () => {
    expect(
      authEndpointsFor(cafe24, "https://sunnymart.cafe24api.com/api/v2/admin"),
    ).toEqual({
      authorizationUrl:
        "https://sunnymart.cafe24api.com/api/v2/oauth/authorize",
      tokenUrl: "https://sunnymart.cafe24api.com/api/v2/oauth/token",
      revokeUrl: "https://sunnymart.cafe24api.com/api/v2/oauth/revoke",
    });
  });

  test("a stored row naming a host this entry would not be pointed at resolves to nothing", () => {
    // Re-checked at the moment of use rather than trusted from the moment of storage: a row could
    // have been written by an older build, and these are the addresses a refresh token goes to.
    expect(authEndpointsFor(cafe24, "https://evil.example/api")).toBeNull();
    expect(
      authEndpointsFor(cafe24, "https://sunny.cafe24api.com.evil.example"),
    ).toBeNull();
    expect(authEndpointsFor(cafe24, "not a url")).toBeNull();
    expect(authEndpointsFor(cafe24, null)).toBeNull();
  });

  test("a fixed vendor needs no row at all", () => {
    expect(authEndpointsFor(catalogueEntry("gmail")!, null)).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
    });
  });
});
