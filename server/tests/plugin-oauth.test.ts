import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { seal } from "../src/auth/signed-value";
import type { CatalogueAuth } from "../src/plugins/catalogue";
import { McpServerError } from "../src/plugins/mcp";
import {
  authorizationUrlFor,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  registerDynamicClient,
  sealConnectState,
} from "../src/plugins/oauth";
import {
  exchangeRefreshTokenOverHttp,
  INVALID_CLIENT,
  TokenRefusedError,
} from "../src/plugins/store";

/**
 * The half of the connect flow that leaves this deployment and comes back.
 *
 * Everything here exists because the browser is in the middle of it. An authorization code arrives on
 * a URL somebody else's server sent the person to, so nothing on that request can be believed on its
 * own: not who is connecting, not which server they meant, and not that they ever asked. The sealed
 * state is what carries those facts across, and the PKCE verifier is what proves the code being
 * redeemed belongs to the request that started it.
 *
 * So most of this file is about refusal. A state that was tampered with, replayed after expiry or
 * minted for another purpose has to come back as nothing, because the alternative is attaching
 * somebody else's Notion account to this person's row.
 *
 * The vendor half runs against a REAL server on this machine rather than a patched `globalThis.fetch`.
 * Two reasons, and the second is the one that made it worth the socket: a patched global is process
 * state in a suite where another file already leaks a `mock.module` across files, and — the property
 * being asserted in three tests here — "the redirect was not followed" is only observable if
 * following one would actually reach somewhere. A stub that returns a 302 cannot show that.
 */

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** A second one, so "sealed by somebody else" is a different key rather than a different value. */
const OTHER_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

/** Fixed, so the expiry assertions are about the TTL rather than about how long the suite took. */
const NOW = 1_770_000_000_000;

/** The label `oauth.ts` seals under. Written out, because a test that imported it could not catch it. */
const CONNECT_LABEL = "mcp-oauth-connect";

const REDIRECT_URI = "https://laf.example/api/plugins/oauth/callback";

/* ── a vendor that actually answers ──────────────────────────────────────────────────────────── */

/** Every request the fake vendor received, in order, with its raw body. */
const asked: { path: string; body: string }[] = [];

/** What it answers next. Set by each test; loud rather than silent when a test forgets. */
let answer: (request: { path: string; body: string }) => Response = () =>
  new Response("no answer configured for this request", { status: 500 });

const vendor = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    // Read once: a request body is a stream, and a second read would come back empty.
    const received = { path: url.pathname, body: await request.text() };
    asked.push(received);
    return answer(received);
  },
});

/** Where the fake vendor ended up. Port 0 means the OS picked it, so nothing collides in CI. */
const origin = `http://127.0.0.1:${vendor.port}`;
const TOKEN_URL = `${origin}/token`;
const REGISTRATION_URL = `${origin}/register`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

/** The form the last request carried, which is where every "what did we send" assertion looks. */
const lastForm = () => new URLSearchParams(asked.at(-1)?.body ?? "");

beforeEach(() => {
  asked.length = 0;
  answer = () =>
    new Response("no answer configured for this request", { status: 500 });
});

afterAll(() => {
  vendor.stop(true);
});

/* ── the sealed state ────────────────────────────────────────────────────────────────────────── */

describe("the state that travels through the vendor", () => {
  test("carries who, which server and the verifier, and reads back exactly", async () => {
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
      NOW,
    );

    expect(await readConnectState(sealed, KEY, NOW)).toEqual({
      userId: "user-1",
      serverId: "notion",
      verifier: "v-1",
      // Absent on the way in and definite on the way out: a flow that named no screen reads back as
      // the one every flow used to end on, rather than as undefined for a caller to guess about.
      returnTo: "settings",
    });
  });

  test("the screen to return to survives the round trip", async () => {
    const sealed = await sealConnectState(
      {
        userId: "user-1",
        serverId: "notion",
        verifier: "v-1",
        returnTo: "admin",
      },
      KEY,
      NOW,
    );

    expect((await readConnectState(sealed, KEY, NOW))?.returnTo).toBe("admin");
  });

  /*
   * THE OPEN REDIRECT THIS CANNOT BECOME. A destination carried through an OAuth flow is the classic
   * shape of one: the callback arrives with a fresh consent behind it, so anything it is willing to
   * redirect to is somewhere an attacker can send a person from a link that looked legitimate.
   *
   * The defence is that the field cannot express another origin at all — only "admin" is recognised,
   * and everything else becomes the default. Asserted through states this deployment actually sealed,
   * because a state it will open at all is exactly what an attacker does not have; the point is that
   * the narrowing holds even for somebody who somehow had one.
   */
  test("a destination naming anywhere else reads back as the default", async () => {
    for (const hostile of [
      "https://evil.test",
      "//evil.test",
      "/admin/plugins/../../evil",
      "ADMIN",
      "admin ",
      "settings",
    ]) {
      const sealed = await sealConnectState(
        {
          userId: "user-1",
          serverId: "notion",
          verifier: "v-1",
          returnTo: hostile as "admin",
        },
        KEY,
        NOW,
      );
      expect((await readConnectState(sealed, KEY, NOW))?.returnTo).toBe(
        "settings",
      );
    }
  });

  test("is refused once a character of it changes", async () => {
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
      NOW,
    );

    /*
     * Every character of a sealed state is envelope, nonce or ciphertext, so one flipped character
     * anywhere is the realistic tamper: somebody trying to have the callback attach their account to
     * another person's row. AES-GCM authenticates as well as encrypts, so an altered state fails to
     * open rather than opening as something else — there is no separate signature doing this.
     */
    for (const at of [0, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;
      expect(await readConnectState(tampered, KEY, NOW)).toBeNull();
    }
  });

  test("is refused when it was sealed with a different key", async () => {
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      OTHER_KEY,
      NOW,
    );

    expect(await readConnectState(sealed, KEY, NOW)).toBeNull();
  });

  test("expires, so a consent screen left in a tab cannot be redeemed tomorrow", async () => {
    // The expiry rides INSIDE the sealed value, where nobody can move it — but it still has to be
    // checked on the way out, which is the half that encrypting does not do for you.
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
      NOW,
    );

    expect(await readConnectState(sealed, KEY, NOW + 60_000)).not.toBeNull();
    // Ten minutes is the TTL, so the boundary itself is refused rather than allowed.
    expect(await readConnectState(sealed, KEY, NOW + 10 * 60_000)).toBeNull();
    expect(await readConnectState(sealed, KEY, NOW + 60 * 60_000)).toBeNull();
  });

  test("cannot be some other sealed value of this deployment's wearing a different hat", async () => {
    /*
     * Sealed under its own label, and the label DERIVES the key — so a value this deployment sealed
     * for another purpose is not merely rejected here, it cannot be opened here at all. Without that,
     * everything the deployment ever hands out under this key would be a candidate state.
     */
    const elsewhere = await seal(
      JSON.stringify({
        userId: "user-1",
        serverId: "notion",
        verifier: "v-1",
        exp: NOW + 60_000,
      }),
      KEY,
      "agent-callback",
    );

    expect(await readConnectState(elsewhere, KEY, NOW)).toBeNull();
  });

  test("is refused when it is not a state at all", async () => {
    for (const nonsense of ["", "nonsense", "a.b", "....", "%%%"]) {
      expect(await readConnectState(nonsense, KEY, NOW)).toBeNull();
    }
    // A real envelope, sealed with the right key under the right label, carrying no JSON at all.
    expect(
      await readConnectState(
        await seal("not json", KEY, CONNECT_LABEL),
        KEY,
        NOW,
      ),
    ).toBeNull();
  });

  /**
   * A state this deployment really sealed, missing one of the four things a callback needs.
   *
   * Reachable rather than theoretical: this is the shape an older build's state has after a field is
   * added, and it is what a partially-written state looks like. Each field is checked on its own, so
   * a validator that stopped at the first one would fail here rather than accept three of four.
   */
  test("is refused when a field it must carry is missing or empty", async () => {
    const complete = {
      userId: "user-1",
      serverId: "notion",
      verifier: "v-1",
      exp: NOW + 60_000,
    };

    for (const missing of ["userId", "serverId", "verifier", "exp"] as const) {
      const partial = { ...complete };
      delete partial[missing];
      expect(
        await readConnectState(
          await seal(JSON.stringify(partial), KEY, CONNECT_LABEL),
          KEY,
          NOW,
        ),
      ).toBeNull();
    }

    // Empty is the same as absent. An empty user id would otherwise be a state naming nobody, and
    // "nobody" is the one actor id that must never match a connection row.
    for (const blank of ["userId", "serverId", "verifier"] as const) {
      expect(
        await readConnectState(
          await seal(
            JSON.stringify({ ...complete, [blank]: "" }),
            KEY,
            CONNECT_LABEL,
          ),
          KEY,
          NOW,
        ),
      ).toBeNull();
    }

    // Nothing at all, which is the same answer as a field at a time.
    expect(
      await readConnectState(await seal("{}", KEY, CONNECT_LABEL), KEY, NOW),
    ).toBeNull();
  });

  /**
   * THE PROPERTY THIS FORMAT EXISTS FOR: the state says nothing to anybody without the key.
   *
   * The state and the authorization code travel on the SAME callback URL, and a dynamically
   * registered client is public — PKCE is the only thing binding that code to this deployment. So
   * every reader of that URL, and there are several nobody chose (a CDN log, a proxy log, browser
   * history, the vendor's own logs), would otherwise hold everything needed to redeem the code.
   *
   * Asserted by decoding rather than by eye, because the failure being guarded against is a value
   * that LOOKS opaque and is not.
   */
  test("does not carry the PKCE verifier where a reader without the key can find it", async () => {
    const verifier = createVerifier();
    const state = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier },
      KEY,
      NOW,
    );

    expect(state).not.toContain(verifier);
    // Opaque as far as a URL is concerned too: one token, nothing in it to escape.
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    for (const segment of state.split(".")) {
      for (const encoding of ["base64url", "base64", "hex"] as const) {
        expect(Buffer.from(segment, encoding).toString("utf8")).not.toContain(
          verifier,
        );
      }
    }
  });

  test("still fits in a query parameter", async () => {
    // Sealing costs size, and the state has to survive a round trip through somebody else's URL
    // handling. A real-shaped one — a UUID for the person, a live verifier — is well inside it.
    const state = await sealConnectState(
      {
        userId: randomUUID(),
        serverId: "google-drive",
        verifier: createVerifier(),
      },
      KEY,
      NOW,
    );

    expect(state.length).toBeLessThan(1_024);
  });
});

/* ── PKCE ────────────────────────────────────────────────────────────────────────────────────── */

describe("PKCE", () => {
  test("a verifier is long enough and made of unreserved characters", () => {
    const verifier = createVerifier();
    // RFC 7636 §4.1 puts the floor at 43 characters and the alphabet at unreserved characters only.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("two verifiers are not the same", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  /**
   * The RFC's own worked example, rather than a round trip against ourselves.
   *
   * `challengeFor` is one of the few things here whose correctness is decided by somebody else: the
   * vendor computes the same function over the verifier we later present, and a mismatch is refused
   * at redemption with an error that names nothing useful. A test that hashed with this file's own
   * arithmetic would agree with any consistent mistake — base64 instead of base64url, say, which is
   * exactly the mistake that survives every self-consistent test and fails at Notion.
   *
   * RFC 7636 Appendix B.
   */
  test("a challenge is the S256 of the verifier, as the RFC's own vector computes it", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("a challenge is never the verifier itself", () => {
    // `plain` would make the challenge worthless: anybody who intercepted the authorization request
    // would already hold the value needed to redeem the code.
    const verifier = createVerifier();
    expect(challengeFor(verifier)).not.toBe(verifier);
    expect(challengeFor(verifier)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

/* ── the consent URL ─────────────────────────────────────────────────────────────────────────── */

describe("the address the person is sent to", () => {
  /*
   * Literal fixtures rather than the live catalogue entries. What is under test is what
   * `authorizationUrlFor` does with an entry, and a test reading the catalogue would change meaning
   * every time a vendor's entry is edited — including in the direction of agreeing with a mistake.
   * `plugin-catalogue.test.ts` is where the entries themselves are pinned.
   */
  const scoped: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
    kind: "user-oauth",
    authorizationUrl: "https://accounts.vendor.example/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.vendor.example/token",
    revokeUrl: "https://oauth2.vendor.example/revoke",
    scopes: ["https://vendor.example/auth/drive.readonly", "openid"],
    authorizationParams: { access_type: "offline", prompt: "consent" },
  };

  const unscoped: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
    kind: "user-oauth",
    authorizationUrl: "https://mcp.vendor.example/authorize",
    tokenUrl: "https://mcp.vendor.example/token",
    revokeUrl: "https://mcp.vendor.example/token",
    scopes: [],
  };

  const urlFor = (auth: Extract<CatalogueAuth, { kind: "user-oauth" }>) =>
    new URL(
      authorizationUrlFor({
        auth,
        clientId: "client-id",
        redirectUri: REDIRECT_URI,
        state: "sealed-state",
        codeChallenge: "the-challenge",
      }),
    );

  test("is the vendor's own, from the entry", () => {
    const url = urlFor(scoped);
    expect(`${url.origin}${url.pathname}`).toBe(scoped.authorizationUrl);
  });

  test("carries the six keys that make this flow provable", () => {
    const url = urlFor(scoped);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("sealed-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    // Never `plain`, which would make the challenge worth nothing at all.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("asks for the entry's scopes, space separated, and no others", () => {
    expect(urlFor(scoped).searchParams.get("scope")).toBe(
      "https://vendor.example/auth/drive.readonly openid",
    );
  });

  test("a vendor with no scopes sends no scope key, rather than an empty one", () => {
    // Notion's shape: access is per page, chosen on the consent screen, so there are no scope
    // strings to send. `scope=` is not "no scope" — it is a malformed request to some vendors, and
    // the key has to be entirely absent.
    expect(urlFor(unscoped).searchParams.has("scope")).toBe(false);
  });

  test("a vendor's own parameters are applied, and only that vendor's", () => {
    const url = urlFor(scoped);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // The unscoped entry asked for neither, so neither is sent. A parameter this function added for
    // everybody is a parameter an unrelated vendor never asked for and may refuse the request over.
    const bare = urlFor(unscoped);
    expect(bare.searchParams.has("access_type")).toBe(false);
    expect(bare.searchParams.has("prompt")).toBe(false);
  });

  /*
   * DEFENCE IN DEPTH, NOT REACHABILITY TODAY. The catalogue is frozen, reviewed code, so nothing in
   * it can set these now — but `authorizationParams` is applied LAST, after the six keys that carry
   * this flow's own security. An entry naming one of them would quietly win, and an entry setting
   * `code_challenge_method: "plain"` would defeat PKCE with nothing anywhere to catch it. Throwing at
   * URL-build time turns that into a failure at first connect instead of a silent downgrade.
   */
  test("an entry that names one of the flow's own keys throws rather than winning", () => {
    for (const reserved of [
      "client_id",
      "redirect_uri",
      "response_type",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      expect(() =>
        urlFor({ ...unscoped, authorizationParams: { [reserved]: "hostile" } }),
      ).toThrow(new RegExp(reserved));
    }
  });

  test("an entry's harmless extra parameter still passes through", () => {
    const url = urlFor({
      ...unscoped,
      authorizationParams: { audience: "https://vendor.example/api" },
    });
    expect(url.searchParams.get("audience")).toBe("https://vendor.example/api");
  });
});

/* ── the two addresses on our side ───────────────────────────────────────────────────────────── */

describe("the address the vendor sends them back to", () => {
  test("is one path, built from the deployment's own public URL", () => {
    expect(redirectUriFor("https://laf.example")).toBe(
      "https://laf.example/api/plugins/oauth/callback",
    );
  });

  test("does not double a slash when the public URL has trailing ones", () => {
    // A redirect URI has to match what was registered with the vendor character for character, so a
    // stray slash is not cosmetic: it fails at the vendor, with a message that does not name us.
    expect(redirectUriFor("https://laf.example/")).toBe(
      "https://laf.example/api/plugins/oauth/callback",
    );
    expect(redirectUriFor("https://laf.example///")).toBe(
      "https://laf.example/api/plugins/oauth/callback",
    );
  });
});

describe("where the callback puts somebody afterwards", () => {
  const APP = "http://localhost:3010";

  /*
   * The bug this exists to prevent, found by running the thing rather than by reading it.
   *
   * The app and the API are two processes on two ports locally. The callback lands on the API, so a
   * relative redirect resolved against the API's origin and ended on a 404 — after the consent had
   * succeeded and the grant was already stored. Nothing about that looks like a failure of the
   * connect flow, which is why it needs a test and not a comment.
   */
  test("success returns to the connected-accounts list, on the app's origin", () => {
    expect(connectedAccountsUrlFor(APP, { serverId: "notion" })).toBe(
      `${APP}/settings/connected-accounts?connected=notion`,
    );
  });

  test("failure lands on the same list, saying so", () => {
    // One outcome for every failure. Telling a forged state apart from an expired one only tells
    // somebody probing this endpoint how far they got.
    expect(connectedAccountsUrlFor(APP, { failed: true })).toBe(
      `${APP}/settings/connected-accounts?connected=failed`,
    );
  });

  test("a connect started on the Plugins page returns to the Plugins page", () => {
    // The round trip this removes: an administrator who connected from the connector's own screen
    // used to be put down on their personal settings page, mid-task, elsewhere in the app.
    expect(connectedAccountsUrlFor(APP, { serverId: "notion" }, "admin")).toBe(
      `${APP}/admin/plugins?connected=notion`,
    );
  });

  test("a failure goes to the list even when it began on the Plugins page", () => {
    /*
     * A failed state has no server id to name, and the settings list is the one screen that always
     * draws the notice. This fork has no per-server page on either side, so both destinations are
     * lists and the outcome is named in the query rather than in the path.
     */
    expect(connectedAccountsUrlFor(APP, { failed: true }, "admin")).toBe(
      `${APP}/settings/connected-accounts?connected=failed`,
    );
  });

  test("still points somewhere when no app URL is configured", () => {
    // Relative is wrong on a split-port deployment and right on a single-origin one, which is the
    // only case where `appUrl` is absent and the deployment still works.
    expect(connectedAccountsUrlFor(undefined, { serverId: "notion" })).toBe(
      "/settings/connected-accounts?connected=notion",
    );
    expect(connectedAccountsUrlFor(undefined, { failed: true })).toBe(
      "/settings/connected-accounts?connected=failed",
    );
  });

  test("a trailing slash on the app URL does not double", () => {
    expect(connectedAccountsUrlFor(`${APP}/`, { serverId: "notion" })).toBe(
      `${APP}/settings/connected-accounts?connected=notion`,
    );
  });

  test("a server id is escaped rather than trusted into a URL", () => {
    // It comes off a sealed state, so it is ours — but it lands in a URL, and a value that reaches
    // one unescaped is one `&` away from meaning something else to the page reading it.
    expect(
      connectedAccountsUrlFor(APP, { serverId: "../../admin&connected=ok" }),
    ).toBe(
      `${APP}/settings/connected-accounts?connected=..%2F..%2Fadmin%26connected%3Dok`,
    );
    expect(
      connectedAccountsUrlFor(APP, { serverId: "../../admin" }, "admin"),
    ).toBe(`${APP}/admin/plugins?connected=..%2F..%2Fadmin`);
  });
});

/* ── registering this deployment as a client ─────────────────────────────────────────────────── */

describe("registering this deployment as an OAuth client", () => {
  test("registers a public client under this fork's own name", async () => {
    answer = () => json({ client_id: "dyn-123" }, 201);

    const client = await registerDynamicClient({
      registrationUrl: REGISTRATION_URL,
      redirectUri: REDIRECT_URI,
    });

    expect(client).toEqual({ clientId: "dyn-123", clientSecret: "" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe("/register");
    expect(JSON.parse(asked[0]?.body ?? "null")).toEqual({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: its proof is PKCE, and there is no secret for anybody to leak.
      token_endpoint_auth_method: "none",
      // The fork's name, not upstream's. It is what a person sees on the consent screen.
      client_name: "LAF Agent",
    });
  });

  test("a vendor that issues a secret anyway has it kept", async () => {
    answer = () => json({ client_id: "dyn-123", client_secret: "s-1" }, 201);

    expect(
      await registerDynamicClient({
        registrationUrl: REGISTRATION_URL,
        redirectUri: REDIRECT_URI,
      }),
    ).toEqual({ clientId: "dyn-123", clientSecret: "s-1" });
  });

  test("a refused registration reads back as null rather than throwing", async () => {
    answer = () => json({ error: "invalid_redirect_uri" }, 400);

    expect(
      await registerDynamicClient({
        registrationUrl: REGISTRATION_URL,
        redirectUri: REDIRECT_URI,
      }),
    ).toBeNull();
  });

  test("a 200 carrying no client id is a refusal", async () => {
    answer = () => json({ client_secret: "s-1" });

    expect(
      await registerDynamicClient({
        registrationUrl: REGISTRATION_URL,
        redirectUri: REDIRECT_URI,
      }),
    ).toBeNull();
  });

  /**
   * A 200 carrying something that is not JSON.
   *
   * A CDN interstitial, a captive portal, a load balancer's maintenance page: all of them answer 200
   * with HTML, and this function's contract is that a vendor which will not register us reads back as
   * null. An unguarded `response.json()` breaks that contract in the worst available way — a
   * SyntaxError escaping the request as a 500, with the parser's message quoting the vendor's body
   * into whatever logs it.
   */
  test("a 200 that is not JSON is a refusal, not a thrown parse error", async () => {
    answer = () => html("<html>Attention Required!</html>");

    expect(
      await registerDynamicClient({
        registrationUrl: REGISTRATION_URL,
        redirectUri: REDIRECT_URI,
      }),
    ).toBeNull();
  });

  /**
   * A redirect is a refusal, and is never followed.
   *
   * The registration endpoint is pinned in the catalogue, so a 302 is somebody else deciding where
   * this deployment introduces itself. Followed, it would register us at whatever address the answer
   * named and believe the client id that came back.
   *
   * Asserted by counting what the vendor was ASKED, which is what a real server can show and a stub
   * cannot: had the redirect been followed, `/elsewhere` would appear in the log.
   */
  test("a redirect is not followed, and reads back as a refusal", async () => {
    answer = () =>
      new Response(null, {
        status: 302,
        headers: { location: `${origin}/elsewhere` },
      });

    expect(
      await registerDynamicClient({
        registrationUrl: REGISTRATION_URL,
        redirectUri: REDIRECT_URI,
      }),
    ).toBeNull();
    expect(asked.map((request) => request.path)).toEqual(["/register"]);
  });
});

/* ── redeeming the authorization code ────────────────────────────────────────────────────────── */

describe("redeeming an authorization code", () => {
  const redeem = (clientSecret = "") =>
    redeemAuthorizationCode({
      tokenUrl: TOKEN_URL,
      clientId: "client-id",
      clientSecret,
      code: "code-1",
      redirectUri: REDIRECT_URI,
      verifier: "verifier-1",
    });

  test("presents the code, the client, the redirect URI and the verifier", async () => {
    answer = () => json({ refresh_token: "rt-1", scope: "read write" });

    expect(await redeem()).toEqual({
      refreshToken: "rt-1",
      scope: "read write",
    });
    const form = lastForm();
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("client_id")).toBe("client-id");
    // The redirect URI is presented again at redemption, and a vendor checks it matches. It is why
    // the value comes from configuration rather than from the incoming request.
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    // The verifier, which is what proves this code belongs to the request that started the flow.
    expect(form.get("code_verifier")).toBe("verifier-1");
  });

  test("a public client sends no client_secret field at all", async () => {
    answer = () => json({ refresh_token: "rt-1" });

    await redeem("");
    // Not "sends an empty one": some vendors refuse an unexpected empty field outright, and a
    // dynamically registered client has no secret to send in the first place.
    expect(lastForm().has("client_secret")).toBe(false);
  });

  test("a confidential client still sends it", async () => {
    answer = () => json({ refresh_token: "rt-1" });

    await redeem("secret-1");
    expect(lastForm().get("client_secret")).toBe("secret-1");
  });

  /**
   * No refresh token is a failure, not a partial success.
   *
   * It is what a vendor returns when it believes this person already consented. Storing the access
   * token instead would produce a connection that works for an hour and then cannot be renewed —
   * the worst of the three outcomes, because it looks like success.
   */
  test("a 200 with an access token but no refresh token is a refusal", async () => {
    answer = () => json({ access_token: "at-1", expires_in: 3600 });

    expect(await redeem()).toBeNull();
  });

  test("a 200 with an empty refresh token is the same refusal", async () => {
    answer = () => json({ refresh_token: "" });

    expect(await redeem()).toBeNull();
  });

  test("a 200 that is not JSON is a refusal, not a thrown parse error", async () => {
    // The person has consented by the time this runs, so the failure lands on the callback: it must
    // redirect them back with a notice, not crash out of a handler as a 500.
    answer = () => html("<html>checking your browser</html>");

    expect(await redeem()).toBeNull();
  });

  test("a refusal from the token endpoint is a refusal here", async () => {
    answer = () => json({ error: "invalid_grant" }, 400);

    expect(await redeem()).toBeNull();
  });

  /**
   * A redirect from the TOKEN endpoint is the most expensive one to follow.
   *
   * This request carries the authorization code and, for a confidential client, the client secret.
   * Following a 302 hands both to whatever address the answer named. `redirect: "manual"` leaves the
   * 3xx as the response, which is not `ok`, so it falls into the refusal.
   */
  test("a redirect is not followed, and reads back as a refusal", async () => {
    answer = () =>
      new Response(null, {
        status: 302,
        headers: { location: `${origin}/elsewhere` },
      });

    expect(await redeem("secret-1")).toBeNull();
    expect(asked.map((request) => request.path)).toEqual(["/token"]);
  });

  /**
   * The scope is capped where it is read.
   *
   * It is a short string in the protocol and vendor-controlled in fact, and everything downstream
   * shows it to somebody: the connected-accounts page, the `mcp.account_connected` payload, the
   * `scope` column. None of those is a promise about length.
   */
  test("a vendor's scope is capped rather than stored whole", async () => {
    answer = () => json({ refresh_token: "rt-1", scope: "s".repeat(2_000) });

    expect((await redeem())?.scope.length).toBe(512);
  });

  test("a scope that is not a string reads as none rather than as itself", async () => {
    answer = () => json({ refresh_token: "rt-1", scope: { read: true } });

    expect((await redeem())?.scope).toBe("");
  });
});

/* ── spending the refresh token ──────────────────────────────────────────────────────────────── */

describe("trading a refresh token for an access token", () => {
  const exchange = (clientSecret: string, refreshToken = "rt-1") =>
    exchangeRefreshTokenOverHttp({
      tokenUrl: TOKEN_URL,
      client: { clientId: "client-id", clientSecret },
      refreshToken,
    });

  test("presents the grant and the client, and returns what the vendor minted", async () => {
    answer = () =>
      json({ access_token: "at-1", expires_in: 3599, refresh_token: "rt-2" });

    expect(await exchange("")).toEqual({
      accessToken: "at-1",
      expiresInSeconds: 3599,
      // A rotating vendor kills the token it was shown, so the new one is the only one that works.
      refreshToken: "rt-2",
    });
    const form = lastForm();
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBe("client-id");
  });

  test("a public client sends no client_secret field at all", async () => {
    answer = () => json({ access_token: "at-1" });

    await exchange("");
    expect(lastForm().has("client_secret")).toBe(false);
  });

  test("a confidential client still sends it", async () => {
    answer = () => json({ access_token: "at-1" });

    await exchange("secret-1");
    expect(lastForm().get("client_secret")).toBe("secret-1");
  });

  test("a vendor that does not rotate reports no new refresh token", async () => {
    // Reading an absent or empty field as a rotation would repoint a working connection at nothing.
    answer = () => json({ access_token: "at-1", refresh_token: "" });

    expect((await exchange("")).refreshToken).toBeUndefined();
  });

  /**
   * `invalid_client` survives as a FIELD, not as prose.
   *
   * It is the one refusal code the store acts on rather than reports: a client this deployment issued
   * to itself, it can issue again. The recovery used to read a substring of the sentence, which meant
   * rewording — translating it, dropping the parenthesis — would have turned self-registration off
   * with every test still green.
   */
  test("a refusal naming the client carries the code the recovery reads", async () => {
    answer = () => json({ error: "invalid_client" }, 401);

    const refusal = (await exchange("").catch(
      (error: unknown) => error,
    )) as TokenRefusedError;
    expect(refusal).toBeInstanceOf(TokenRefusedError);
    expect(refusal.code).toBe(INVALID_CLIENT);
    // The status is in the sentence, because that is the one fact worth showing whoever operates
    // this deployment; the vendor's own body is not, because it is written for a developer console.
    expect(refusal.message).toContain("401");
  });

  test("another refusal carries its own code and is not the client one", async () => {
    answer = () => json({ error: "invalid_grant" }, 400);

    const refusal = (await exchange("").catch(
      (error: unknown) => error,
    )) as TokenRefusedError;
    expect(refusal.code).toBe("invalid_grant");
    expect(refusal.code).not.toBe(INVALID_CLIENT);
  });

  /**
   * A token endpoint that is refusing may be refusing with an HTML error page.
   *
   * A parse failure here would replace the vendor's status — the one fact we do have — with a syntax
   * error thrown from inside the refusal path. The code is simply unknown, which is a null rather
   * than a crash, and the refusal still reports the status.
   */
  test("a refusal that is not JSON is still a refusal, with no code", async () => {
    answer = () => html("<html>503 Service Unavailable</html>", 503);

    const refusal = (await exchange("").catch(
      (error: unknown) => error,
    )) as TokenRefusedError;
    expect(refusal).toBeInstanceOf(TokenRefusedError);
    expect(refusal).not.toBeInstanceOf(SyntaxError);
    expect(refusal.code).toBeNull();
    expect(refusal.message).toContain("503");
  });

  test("a refusal code is capped rather than quoted whole", async () => {
    // It reaches `lastError` on the admin page, an audit payload and the person who asked. Nothing
    // on those paths is a promise about length.
    answer = () => json({ error: "e".repeat(500) }, 400);

    const refusal = (await exchange("").catch(
      (error: unknown) => error,
    )) as TokenRefusedError;
    expect(refusal.code?.length).toBe(64);
  });

  /**
   * A 200 is not a promise of JSON, and this is the branch where that mattered most.
   *
   * `callTool` records a failure with the thrower's message, and a parser's message quotes the body
   * it choked on. So an unguarded parse would put a vendor's HTML into an audit payload and in front
   * of the person who asked, as a crash rather than as the refusal every other unusable reply gives.
   */
  test("a 200 that is not JSON is the ordinary refusal, not a SyntaxError", async () => {
    answer = () => html("<html>checking your browser</html>");

    const thrown = (await exchange("").catch(
      (error: unknown) => error,
    )) as Error;
    expect(thrown).toBeInstanceOf(McpServerError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect(thrown.message).toBe(
      "The vendor answered this renewal with something other than a token.",
    );
  });

  test("a 200 with no access token in it is refused rather than returned empty", async () => {
    answer = () => json({ expires_in: 3600 });

    const thrown = (await exchange("").catch(
      (error: unknown) => error,
    )) as Error;
    expect(thrown).toBeInstanceOf(McpServerError);
    expect(thrown.message).toBe(
      "The vendor renewed this access with no token.",
    );
  });
});
