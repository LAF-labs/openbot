/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because the minimum is a moving target: it once acquired four mandatory
 * `INTELLIGENCE_*` variables while five test files each carried their own copy of the environment,
 * and every one of them started failing for a reason that had nothing to do with what it was
 * testing. Those four are gone again, which is the same lesson from the other side. Tests that
 * assert on configuration should keep building their environment inline; everything else spreads
 * this.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    ...overrides,
  };
}
