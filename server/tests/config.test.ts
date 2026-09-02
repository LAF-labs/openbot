import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

/**
 * The whole minimum contract, and nothing that used to be part of it.
 *
 * Four `INTELLIGENCE_*` variables were once in here on the grounds that they were part of that
 * minimum — a partial set refused to boot, so leaving them out made most of this file describe a
 * deployment that was not allowed to exist. They were never part of any deployment's minimum: the
 * hosted runtime they selected was never stood up, threads have always lived in this deployment's
 * own Postgres, and the branch behind them is deleted.
 */
const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
};

describe("deployment configuration", () => {
  test("resolves the addresses a deployment cannot start without", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.managedAgentAgUiUrl).toEqual(
      new URL("http://localhost:4200/ag-ui"),
    );
    expect(config.tenantPackageDirectory).toBe("../tenant/laf");
  });

  test("allows deployment without an authentication provider", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
    });

    expect(config.auth).toBeUndefined();
  });

  /*
   * A variable that no longer decides anything must not be able to decide something again by
   * accident. The four below were read by `runtimeCapabilities`, which refused to boot on a partial
   * set and selected a hosted runtime on a complete one; both are gone, and a `.env` left over from
   * a deployment that had them set has to start rather than fail on a mode that does not exist.
   */
  test("ignores the Intelligence variables a stale .env may still carry", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INTELLIGENCE_API_URL: "http://localhost:7100",
        INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
        INTELLIGENCE_API_KEY: "tenant-api-key",
        COPILOTKIT_LICENSE_TOKEN: "license-token",
      }),
    ).not.toThrow();
    // And a partial set, which used to be the refusal.
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INTELLIGENCE_API_URL: "http://localhost:7100",
      }),
    ).not.toThrow();
  });

  test("rejects incomplete OAuth client configuration", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "",
      }),
    ).toThrow(
      "GOOGLE_OAUTH configuration requires both client ID and client secret",
    );
  });

  test("refuses to start when MANAGED_AGENT_AG_UI_URL is missing", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(() => loadConfig(environment)).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("refuses a non-HTTP MANAGED_AGENT_AG_UI_URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MANAGED_AGENT_AG_UI_URL: "ftp://localhost:4200/ag-ui",
      }),
    ).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("requires a base64-encoded 32-byte key-encryption key", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        KEY_ENCRYPTION_KEY: "local-development-key",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  test("enables Google authentication when its complete deployment contract is present", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
      BETTER_AUTH_URL: "http://localhost:3001",
      INITIAL_ADMIN_EMAILS: "admin@laf.test, owner@laf.test",
    });

    expect(config.auth).toEqual({
      baseUrl: "http://localhost:3001",
      secret: "a-long-enough-local-development-auth-secret",
      providers: {
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        },
      },
      trustedOrigins: ["http://localhost:3000"],
      initialAdminEmails: ["admin@laf.test", "owner@laf.test"],
      // Unset stays open: the lock arms only when a deployment sets SIGN_IN_ALLOWED_EMAILS.
      allowedEmails: [],
    });
  });

  test("rejects incomplete Google authentication deployment settings", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
        BETTER_AUTH_SECRET: "",
        BETTER_AUTH_URL: "http://localhost:3001",
      }),
    ).toThrow("Authentication requires BETTER_AUTH_SECRET");
  });

  test("enables Kakao and Naver beside Google when their contracts are present", () => {
    const config = loadConfig({
      ...baseEnvironment,
      KAKAO_OAUTH_CLIENT_ID: "kakao-client-id",
      KAKAO_OAUTH_CLIENT_SECRET: "kakao-client-secret",
      NAVER_OAUTH_CLIENT_ID: "naver-client-id",
      NAVER_OAUTH_CLIENT_SECRET: "naver-client-secret",
    });

    expect(Object.keys(config.auth?.providers ?? {}).sort()).toEqual([
      "google",
      "kakao",
      "naver",
    ]);
  });

  /*
   * AUTH_PROVIDERS is the declaration two other things are keyed off — the compose gate and the
   * compiled sign-in buttons — so it must agree with the credentials, in both directions, or the
   * surface and the API drift apart.
   */
  test("refuses a declaration that names a provider with no credentials", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, AUTH_PROVIDERS: "google,kakao" }),
    ).toThrow(
      "AUTH_PROVIDERS names 'kakao' but KAKAO_OAUTH_CLIENT_ID is not set",
    );
  });

  test("refuses credentials the declaration does not name", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        AUTH_PROVIDERS: "google",
        NAVER_OAUTH_CLIENT_ID: "naver-client-id",
        NAVER_OAUTH_CLIENT_SECRET: "naver-client-secret",
      }),
    ).toThrow(
      "NAVER_OAUTH_CLIENT_ID is set but AUTH_PROVIDERS does not name 'naver'",
    );
  });

  test("refuses a provider name it does not know", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, AUTH_PROVIDERS: "google,facebook" }),
    ).toThrow("AUTH_PROVIDERS names 'facebook'");
  });

  test("a declaration matching the credentials is accepted", () => {
    const config = loadConfig({ ...baseEnvironment, AUTH_PROVIDERS: "google" });
    expect(Object.keys(config.auth?.providers ?? {})).toEqual(["google"]);
  });

  test("refuses auth settings with no provider at all", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: baseEnvironment.DATABASE_URL,
        KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
        MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
        BETTER_AUTH_SECRET: baseEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow("Authentication requires at least one OAuth client");
  });

  // A turn that is ended is a turn somebody loses, so an unset variable leaves every stream alone
  // rather than acquiring a timeout the deployment never asked for. `.env.example` ships a value.
  test("leaves the stall watchdog off when nothing is configured", () => {
    expect(loadConfig(baseEnvironment).agentStallTimeoutMs).toBe(0);
  });

  test("takes a timeout in milliseconds, and zero as switching it off", () => {
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "120000" })
        .agentStallTimeoutMs,
    ).toBe(120_000);
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "0" })
        .agentStallTimeoutMs,
    ).toBe(0);
  });

  // Refused rather than defaulted, for the same reason a malformed policy is: an operator who meant
  // to write a boundary and mistyped it would otherwise get a deployment enforcing something else.
  test.each(["two minutes", "-1", "1.5", ""])(
    "refuses to start on AGENT_STALL_TIMEOUT_MS=%p",
    (value) => {
      const attempt = () =>
        loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: value });
      if (value === "") {
        // An empty value is an absent one, which is the off case rather than a malformed one.
        expect(attempt().agentStallTimeoutMs).toBe(0);
        return;
      }
      expect(attempt).toThrow("AGENT_STALL_TIMEOUT_MS");
    },
  );

  test("takes a widened repetition window, and leaves it absent when nobody set one", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
        COMPUTER_REPEAT_WINDOW_MS: "600000",
      }).computer?.repeatWindowMs,
    ).toBe(600_000);

    expect(
      loadConfig({
        ...baseEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
      }).computer?.repeatWindowMs,
    ).toBeUndefined();
  });

  // Refused rather than quietly defaulted, like a malformed policy. An operator who typed `3m` would
  // otherwise get a deployment running the built-in window, and the only evidence would be a rule
  // about repetition that never fires, which reads exactly like a Bot behaving itself.
  test.each(["3m", "0", "-1", "180000.5"])(
    "refuses to start on a repetition window of %p",
    (value) => {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          AGENT_COMPUTER_URL: "http://localhost:4100",
          COMPUTER_REPEAT_WINDOW_MS: value,
        }),
      ).toThrow("COMPUTER_REPEAT_WINDOW_MS");
    },
  );
});

describe("the broker provider (laf)", () => {
  const withoutDirect = { ...baseEnvironment } as Record<string, string>;
  delete withoutDirect.GOOGLE_OAUTH_CLIENT_ID;
  delete withoutDirect.GOOGLE_OAUTH_CLIENT_SECRET;

  test("issuer and client id travel together or not at all", () => {
    expect(() =>
      loadConfig({
        ...withoutDirect,
        LAF_OIDC_ISSUER: "https://auth.agent.test",
      }),
    ).toThrow("both LAF_OIDC_ISSUER and LAF_OIDC_CLIENT_ID");
  });

  test("declaring laf without the pair is refused by name", () => {
    expect(() =>
      loadConfig({ ...withoutDirect, AUTH_PROVIDERS: "laf" }),
    ).toThrow("LAF_OIDC_ISSUER and LAF_OIDC_CLIENT_ID are not set");
  });

  test("the pair without the declaration is refused, like every provider", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        AUTH_PROVIDERS: "google",
        LAF_OIDC_ISSUER: "https://auth.agent.test",
        LAF_OIDC_CLIENT_ID: "shop1.agent.test",
      }),
    ).toThrow("does not name 'laf'");
  });

  test("declared and configured, the broker stands alone — no secret anywhere", () => {
    const config = loadConfig({
      ...withoutDirect,
      AUTH_PROVIDERS: "laf",
      // A trailing slash would double up in the discovery URL; it is trimmed.
      LAF_OIDC_ISSUER: "https://auth.agent.test/",
      LAF_OIDC_CLIENT_ID: "shop1.agent.test",
    });
    expect(config.auth?.lafOidc).toEqual({
      issuer: "https://auth.agent.test",
      clientId: "shop1.agent.test",
    });
    expect(config.auth?.providers).toEqual({});
  });
});
