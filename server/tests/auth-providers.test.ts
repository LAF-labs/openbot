import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * `GET /api/auth/providers` — the deployment saying which sign-ins it offers, so the surface draws
 * from the deployment rather than from whatever the web image was built for. Measured on the
 * fleet before this route existed: a `google` image on a `laf` VM drew a button that posted into
 * a callback the deployment had never registered.
 */
const ask = async (environment: Record<string, string | undefined>) => {
  const response = await createApp(loadConfig(environment)).request(
    "http://laf.local/api/auth/providers",
  );
  return { status: response.status, body: await response.json() };
};

/** The fleet's environment: no direct sign-in declared, Google carried as the connector app. */
const brokerEnvironment = () =>
  testEnvironment({
    AUTH_PROVIDERS: "laf",
    LAF_OIDC_ISSUER: "https://auth.agent.test",
    LAF_OIDC_CLIENT_ID: "shop1.agent.test",
  });

describe("GET /api/auth/providers", () => {
  test("answers the declaration, without a session", async () => {
    const answer = await ask(testEnvironment({ AUTH_PROVIDERS: "google" }));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ providers: ["google"] });
  });

  test("a fleet VM answers the broker alone — the Google pair it carries is the connector app, not a button", async () => {
    const answer = await ask(brokerEnvironment());
    expect(answer.body).toEqual({ providers: ["laf"] });
  });

  test("with nothing declared, every configured pair is offered — the laptop shape", async () => {
    const answer = await ask(
      testEnvironment({
        KAKAO_OAUTH_CLIENT_ID: "kakao-client-id",
        KAKAO_OAUTH_CLIENT_SECRET: "kakao-client-secret",
      }),
    );
    expect(answer.body).toEqual({ providers: ["google", "kakao"] });
  });

  test("a deployment with no sign-in configured says so with an empty list, not an error", async () => {
    const answer = await ask({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ providers: [] });
  });

  test("publishes names only — never an issuer, a client id or a secret", async () => {
    const answer = await ask(brokerEnvironment());
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain("auth.agent.test");
    expect(text).not.toContain("shop1.agent.test");
    expect(text).not.toContain("google-client");
    expect(Object.keys(answer.body as object)).toEqual(["providers"]);
  });
});
