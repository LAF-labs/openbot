import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

/**
 * An OpenID Provider small enough to read, standing in for the fleet's broker.
 *
 * The same wire `laf-oidc.integration.test.ts` proves — discovery, authorize, a signed id_token with
 * the nonce it was sent, userinfo — with one difference that the sign-in tests of the one-account
 * rule need: WHO signs in is chosen per sign-in, not per file. The test adds `stub_email` to the
 * authorize URL it was handed before following it, so two sign-ins can be started side by side and
 * finished at the same moment, each as a different person.
 *
 * The token exchange checks the PKCE proof rather than waving it through, so a sign-in that reaches a
 * session here went through better-auth's real callback.
 */
export type OidcStub = {
  issuer: string;
  close: () => void;
};

type Issued = { challenge: string; email: string; nonce: string | null };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function startOidcStub(clientId: string): Promise<OidcStub> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const issued = new Map<string, Issued>();
  let issuer = "";

  const idToken = (payload: Record<string, unknown>) => {
    const header = base64url(JSON.stringify({ alg: "RS256", kid: "stub" }));
    const body = base64url(JSON.stringify(payload));
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${body}`),
      privateKey,
    );
    return `${header}.${body}.${base64url(signature)}`;
  };

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        scopes_supported: ["openid", "email"],
      });
    }
    if (url.pathname === "/jwks") {
      const jwk = publicKey.export({ format: "jwk" }) as Record<
        string,
        unknown
      >;
      return json(response, 200, {
        keys: [{ ...jwk, kid: "stub", alg: "RS256", use: "sig" }],
      });
    }
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      issued.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        email: url.searchParams.get("stub_email") ?? "",
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
      let form = "";
      request.on("data", (chunk) => {
        form += chunk;
      });
      request.on("end", () => {
        const fields = new URLSearchParams(form);
        const code = fields.get("code") ?? "";
        const grant = issued.get(code);
        const proof = createHash("sha256")
          .update(fields.get("code_verifier") ?? "")
          .digest("base64url");
        if (!grant || proof !== grant.challenge) {
          return json(response, 401, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        return json(response, 200, {
          access_token: `at-${code}`,
          token_type: "bearer",
          expires_in: 300,
          scope: "openid email",
          id_token: idToken({
            iss: issuer,
            aud: clientId,
            sub: `stub:${grant.email}`,
            email: grant.email,
            email_verified: true,
            name: "사장님",
            iat: now,
            exp: now + 300,
            ...(grant.nonce ? { nonce: grant.nonce } : {}),
          }),
        });
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const code = (request.headers.authorization ?? "").replace(
        "Bearer at-",
        "",
      );
      const grant = issued.get(code);
      return json(response, 200, {
        sub: `stub:${grant?.email ?? "unknown"}`,
        email: grant?.email,
        email_verified: true,
        name: "사장님",
      });
    }
    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve({ issuer, close: () => server.close() });
    });
  });
}

/** One browser's cookies, which is all better-auth's state needs to ride from start to callback. */
export type CookieJar = Map<string, string>;

export function keepCookies(jar: CookieJar, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const at = (pair ?? "").indexOf("=");
    if (at > 0) {
      jar.set((pair as string).slice(0, at), (pair as string).slice(at + 1));
    }
  }
}

export const cookieHeader = (jar: CookieJar): string =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

type Handler = { handler: (request: Request) => Promise<Response> };

/** A sign-in that has been started and sent to the provider, with the callback it came back with. */
export type StartedSignIn = { jar: CookieJar; callback: string };

/**
 * Press the button and follow the provider's redirect, as `email`, stopping short of the callback —
 * so a test can hold two sign-ins at the same point and finish them together.
 */
export async function startSignIn(
  auth: Handler,
  origin: string,
  email: string,
): Promise<StartedSignIn> {
  const jar: CookieJar = new Map();
  const started = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ providerId: "laf", callbackURL: `${origin}/` }),
    }),
  );
  keepCookies(jar, started);
  if (started.status !== 200) {
    throw new Error(`the sign-in did not start: ${started.status}`);
  }
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  authorize.searchParams.set("stub_email", email);
  const hop = await fetch(authorize, { redirect: "manual" });
  const callback = hop.headers.get("location");
  if (hop.status !== 302 || !callback) {
    throw new Error(
      `the provider did not send the browser back: ${hop.status}`,
    );
  }
  return { jar, callback };
}

/** Land on the callback with that sign-in's own cookies. */
export async function finishSignIn(
  auth: Handler,
  started: StartedSignIn,
): Promise<Response> {
  const response = await auth.handler(
    new Request(started.callback, {
      headers: { cookie: cookieHeader(started.jar) },
    }),
  );
  keepCookies(started.jar, response);
  return response;
}

/** The `error` a refused callback redirected with, or null for a sign-in that went through. */
export function refusalIn(callback: Response, origin: string): string | null {
  const location = callback.headers.get("location") ?? "";
  return new URL(location, origin).searchParams.get("error");
}
