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

  test("credentials the declaration does not name are not offered as a sign-in", () => {
    /*
     * This used to refuse to start, and refusing was wrong once `GOOGLE_OAUTH_*` acquired its
     * second job as the fleet's connector application: a VM signing people in through the broker
     * carries the pair and offers no Google button, and that combination would not boot.
     *
     * The property the refusal protected is the one asserted here, and it is now enforced instead
     * of complained about: what the declaration does not name is not registered, so the API cannot
     * accept a sign-in the surface never offers.
     */
    const config = loadConfig({
      ...baseEnvironment,
      AUTH_PROVIDERS: "google",
      NAVER_OAUTH_CLIENT_ID: "naver-client-id",
      NAVER_OAUTH_CLIENT_SECRET: "naver-client-secret",
    });

    expect(Object.keys(config.auth?.providers ?? {})).toEqual(["google"]);
  });

  test("a fleet VM signs in through the broker AND carries the connector application", () => {
    // Measured: this is the combination the fleet actually deploys, and it refused to start.
    const config = loadConfig({
      ...baseEnvironment,
      AUTH_PROVIDERS: "laf",
      LAF_OIDC_ISSUER: "https://auth.agent.laf-co.com",
      LAF_OIDC_CLIENT_ID: "sunny.agent.laf-co.com",
    });

    // No Google button, because none was declared…
    expect(Object.keys(config.auth?.providers ?? {})).toEqual([]);
    expect(config.auth?.lafOidc?.clientId).toBe("sunny.agent.laf-co.com");
    // …and the same pair is still the application every 구글 연결 consents under.
    expect(config.connectors.clients.google).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
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

/**
 * The fleet webhook, which is optional as a whole and strict once it exists.
 *
 * Both refusals are about the same thing: the endpoint on the other end destroys machines. An
 * unsigned notice is one anybody who can reach it can forge, and a notice with no origin names no
 * customer — and both would look like a working feature, because the POST succeeds either way.
 */
describe("telling the fleet about a withdrawal", () => {
  const withFleet = {
    ...baseEnvironment,
    PUBLIC_ORIGIN: "https://shop1.agent.laf-co.com",
    LAF_FLEET_WEBHOOK_URL: "https://fleet.laf-co.test/hooks/deployments",
    LAF_FLEET_WEBHOOK_SECRET: "a-shared-fleet-secret",
  };

  test("is absent, and silent, when no URL is given", () => {
    expect(loadConfig(baseEnvironment).fleet).toBeUndefined();
    // The origin alone configures nothing: a deployment has always had one.
    expect(
      loadConfig({ ...baseEnvironment, PUBLIC_ORIGIN: "https://a.test" }).fleet,
    ).toBeUndefined();
  });

  test("carries the origin the fleet knows this customer by", () => {
    expect(loadConfig(withFleet).fleet).toEqual({
      webhookUrl: "https://fleet.laf-co.test/hooks/deployments",
      secret: "a-shared-fleet-secret",
      origin: "https://shop1.agent.laf-co.com",
    });
  });

  test("refuses to start with a URL and no secret", () => {
    const { LAF_FLEET_WEBHOOK_SECRET: _secret, ...unsigned } = withFleet;
    expect(() => loadConfig(unsigned)).toThrow("LAF_FLEET_WEBHOOK_SECRET");
  });

  test("refuses to start with a URL and no PUBLIC_ORIGIN", () => {
    const { PUBLIC_ORIGIN: _origin, ...anonymous } = withFleet;
    expect(() => loadConfig(anonymous)).toThrow("PUBLIC_ORIGIN");
  });

  test("refuses a URL that is not one", () => {
    expect(() =>
      loadConfig({ ...withFleet, LAF_FLEET_WEBHOOK_URL: "fleet.laf-co.test" }),
    ).toThrow("LAF_FLEET_WEBHOOK_URL must be a valid URL");
  });
});

/**
 * The partner vendor LAF holds the ACCOUNT at, and the boot-time refusal over half of it.
 *
 * The same rule the shared OAuth clients keep, for the same reason: a connector configured halfway
 * fails at the moment somebody is trying to use it, which is the worst moment to find out. Neither
 * half of the pair can be told apart from a working one by anything but a live call.
 */
describe("the partner connectors", () => {
  test("not configured is a correct deployment, not a failure", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.partners).toEqual({ alimtalk: false });
  });

  test("a 솔라피 key that is not a pair refuses to boot", () => {
    // 솔라피 issues `apiKey` and `apiSecret` together and one half signs nothing. A deployment that
    // started on this would draw the card and refuse every connect with a code reading as the
    // vendor's fault.
    expect(() =>
      loadConfig({ ...baseEnvironment, LAF_ALIMTALK_API_KEY: "just-the-key" }),
    ).toThrow("LAF_ALIMTALK_API_KEY");
    expect(
      loadConfig({
        ...baseEnvironment,
        LAF_ALIMTALK_API_KEY: "key:secret",
      }).partners.alimtalk,
    ).toBe(true);
  });

  test("an address with no key behind it refuses to boot", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAF_ALIMTALK_BASE_URL: "https://api.solapi.com",
      }),
    ).toThrow("LAF_ALIMTALK_BASE_URL");
  });
});

describe("the deployment keys", () => {
  test("not configured is a correct deployment, and no key is offered", () => {
    expect(loadConfig(baseEnvironment).connectors.keys).toEqual({});
  });

  test("the encoded spelling is carried through, as the value", () => {
    // The value and not a boolean: the one module that spends it is assembled from this object,
    // rather than reading the environment a second time.
    expect(
      loadConfig({
        ...baseEnvironment,
        DATA_GO_KR_SERVICE_KEY: "abc%2Bdef%3D%2Fghi",
      }).connectors.keys,
    ).toEqual({ "data-go-kr": "abc%2Bdef%3D%2Fghi" });
  });

  test("the decoded spelling refuses to boot, by name", () => {
    /*
     * A deployment started on this would list the tools and answer every call with the portal's
     * "unregistered key" — a working-looking feature that reads as the government being down.
     */
    for (const decoded of ["abc+def=/ghi", "abc def", "abc%2Bdef="]) {
      expect(() =>
        loadConfig({ ...baseEnvironment, DATA_GO_KR_SERVICE_KEY: decoded }),
      ).toThrow("DATA_GO_KR_SERVICE_KEY");
    }
  });
});
