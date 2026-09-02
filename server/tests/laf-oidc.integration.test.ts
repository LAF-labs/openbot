import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signRS,
} from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, sessions, userRoles, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The `laf` provider, proven on the wire against a stub OpenID Provider —
 * discovery, authorize (capturing what we SENT: PKCE challenge and the
 * provider_hint the pressed button became), a signed id_token, userinfo, and
 * better-auth's own state cookies carried by hand. The stub verifies the PKCE
 * exchange instead of waving it through, so `pkce: true` is proven, not
 * configured. The allowlist is exercised both ways: the listed email becomes
 * a session, the unlisted one becomes nothing at all.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const run = randomUUID().slice(0, 8);
const ALLOWED = `sajang-${run}@laf.test`;
const UNLISTED = `stranger-${run}@laf.test`;
const CLIENT_ID = "shop1.agent.test";
const ORIGIN = "http://127.0.0.1:3999";

/** What the stub hands out per authorize call, keyed by code. */
type Issued = { challenge: string; email: string; nonce: string | null };
const issued = new Map<string, Issued>();
let emailToIssue = ALLOWED;
let lastAuthorizeUrl: URL | null = null;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
function signedIdToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "stub-key" }));
  const body = b64url(JSON.stringify(payload));
  const signature = signRS(
    "RSA-SHA256",
    Buffer.from(`${header}.${body}`),
    privateKey,
  );
  return `${header}.${body}.${b64url(signature)}`;
}

let stub: Server;
let issuer: string;

function startStub(): Promise<void> {
  stub = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          scopes_supported: ["openid", "email"],
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      const jwk = publicKey.export({ format: "jwk" }) as Record<
        string,
        unknown
      >;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "stub-key", alg: "RS256", use: "sig" }],
        }),
      );
      return;
    }
    if (url.pathname === "/authorize") {
      lastAuthorizeUrl = url;
      const code = randomUUID();
      issued.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        email: emailToIssue,
        nonce: url.searchParams.get("nonce"),
      });
      const back = new URL(url.searchParams.get("redirect_uri") as string);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const grant = issued.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const hashed = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        // The stub REFUSES a bad or missing PKCE proof — that refusal is what
        // makes the happy path below evidence rather than decoration.
        if (!grant || hashed !== grant.challenge) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: `at-${form.get("code")}`,
            token_type: "bearer",
            expires_in: 300,
            scope: "openid email",
            id_token: signedIdToken({
              iss: issuer,
              aud: CLIENT_ID,
              sub: `stub:${grant.email}`,
              email: grant.email,
              email_verified: true,
              name: "사장님",
              iat: now,
              exp: now + 300,
              ...(grant.nonce ? { nonce: grant.nonce } : {}),
            }),
          }),
        );
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const token = (request.headers.authorization ?? "").replace(
        "Bearer at-",
        "",
      );
      const grant = issued.get(token);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sub: `stub:${grant?.email ?? "unknown"}`,
          email: grant?.email,
          email_verified: true,
          name: "사장님",
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => {
      const address = stub.address();
      issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });
}

afterAll(async () => {
  stub?.close();
  const doomed = await database
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [ALLOWED, UNLISTED]));
  const ids = doomed.map((row) => row.id);
  if (ids.length > 0) {
    await database.delete(sessions).where(inArray(sessions.userId, ids));
    await database.delete(accounts).where(inArray(accounts.userId, ids));
    await database.delete(userRoles).where(inArray(userRoles.userId, ids));
    await database.delete(users).where(inArray(users.id, ids));
  }
});

/** The tiniest cookie jar again: better-auth's state rides it to the callback. */
const jar = new Map<string, string>();
function keep(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const at = (pair ?? "").indexOf("=");
    if (at > 0)
      jar.set((pair as string).slice(0, at), (pair as string).slice(at + 1));
  }
}
const cookies = () =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

async function buildAuth() {
  const environment = {
    DATABASE_URL: databaseUrl,
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: ORIGIN,
    AUTH_PROVIDERS: "laf",
    LAF_OIDC_ISSUER: issuer,
    LAF_OIDC_CLIENT_ID: CLIENT_ID,
    SIGN_IN_ALLOWED_EMAILS: ALLOWED,
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
  };
  return createAuth(loadConfig(environment), database);
}

async function signInThroughBroker(
  auth: Awaited<ReturnType<typeof buildAuth>>,
) {
  const started = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        providerId: "laf",
        callbackURL: `${ORIGIN}/`,
        additionalData: { provider: "kakao" },
      }),
    }),
  );
  keep(started);
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };

  // The stub answers the authorize hop with a code.
  const hop = await fetch(url, { redirect: "manual" });
  expect(hop.status).toBe(302);
  const back = hop.headers.get("location") as string;

  const callback = await auth.handler(
    new Request(back, { headers: { cookie: cookies() } }),
  );
  keep(callback);
  return callback;
}

describe("signing in through the fleet broker", () => {
  test("버튼의 선택이 힌트가 되고, PKCE가 증명되고, 명단의 이메일이 세션이 된다", async () => {
    await startStub();
    const auth = await buildAuth();
    emailToIssue = ALLOWED;

    const callback = await signInThroughBroker(auth);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/`);

    // What actually crossed the wire to the broker:
    expect(lastAuthorizeUrl?.searchParams.get("provider_hint")).toBe("kakao");
    expect(lastAuthorizeUrl?.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(lastAuthorizeUrl?.searchParams.get("client_id")).toBe(CLIENT_ID);

    const session = await auth.handler(
      new Request(`${ORIGIN}/api/auth/get-session`, {
        headers: { cookie: cookies() },
      }),
    );
    const body = (await session.json()) as {
      user?: { email?: string; name?: string };
    };
    expect(body.user?.email).toBe(ALLOWED);
    expect(body.user?.name).toBe("사장님");
  });

  test("명단 밖의 이메일은 계정도 세션도 되지 않는다", async () => {
    const auth = await buildAuth();
    emailToIssue = UNLISTED;
    jar.clear();

    const callback = await signInThroughBroker(auth);
    // better-auth surfaces the refusal as an error redirect, never a session.
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error");

    const [row] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, UNLISTED));
    expect(row).toBeUndefined();
  });
});
