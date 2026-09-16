import { describe, expect, test } from "bun:test";
import {
  deploymentEgress,
  deploymentEgressLabel,
  ignoredEgressVariables,
} from "../src/egress";

/**
 * The deployment's egress, tested on the paths an operator will actually take.
 *
 * The case that matters most is the last one: a proxy URL usually carries a password, and the label is
 * rendered on an admin page and returned by an API. A test that only checked the happy parse would
 * have been perfectly green while publishing credentials.
 *
 * And the one above it is the 2026-09-16 change. `EGRESS_PROXY_<BOT>` used to give a Bot its own
 * upstream; one shared browser profile means one Chromium means one proxy, so it cannot any more. A
 * deployment that still sets one must be TOLD — browsing somebody's bank from an address their
 * security team did not choose, silently, is the failure that variable existed to prevent.
 */

describe("resolving the deployment's proxy", () => {
  test("no configuration means direct, not a broken proxy", () => {
    expect(deploymentEgress({})).toBeNull();
    expect(deploymentEgressLabel({})).toBeNull();
  });

  test("blank configuration is treated as absent", () => {
    // An operator who sets the variable and leaves it empty means "no proxy". Passing "" to Playwright
    // as a server would fail every request instead.
    expect(deploymentEgress({ EGRESS_PROXY_DEFAULT: "   " })).toBeNull();
  });

  test("credentials in the URL are split out, as Playwright wants them", () => {
    const proxy = deploymentEgress({
      EGRESS_PROXY_DEFAULT: "http://bot:s3cret@proxy.internal:8080",
    });
    expect(proxy).toEqual({
      server: "http://proxy.internal:8080",
      username: "bot",
      password: "s3cret",
    });
  });

  test("percent-encoded credentials are decoded", () => {
    // A password with an @ or a colon in it has to be encoded to fit in a URL, and handing Playwright
    // the still-encoded form authenticates with the wrong password and looks like a proxy fault.
    const proxy = deploymentEgress({
      EGRESS_PROXY_DEFAULT: "http://bot:p%40ss%3Aword@proxy.internal:8080",
    });
    expect(proxy?.password).toBe("p@ss:word");
  });

  test("a bare host:port is accepted rather than rejected", () => {
    // What an operator writes when they are not thinking about URLs. Playwright accepts it too.
    expect(
      deploymentEgress({ EGRESS_PROXY_DEFAULT: "proxy.internal:8080" }),
    ).toEqual({
      server: "proxy.internal:8080",
    });
  });
});

describe("a per-Bot proxy the shared browser cannot honour", () => {
  test("is never quietly used as the deployment's", () => {
    // The whole hazard: a Bot's own variable reaching the browser would give every OTHER Bot that
    // Bot's address, which is worse than not having it.
    expect(
      deploymentEgress({ EGRESS_PROXY_SALES: "http://sales.proxy:8080" }),
    ).toBeNull();
  });

  test("is named at boot, by name and never by value", () => {
    const named = ignoredEgressVariables({
      EGRESS_PROXY_DEFAULT: "http://shared.proxy:8080",
      EGRESS_PROXY_SALES: "http://bot:s3cret@sales.proxy:8080",
      EGRESS_PROXY_RESEARCH: "http://research.proxy:8080",
      // Set and empty is the operator saying "none", and there is nothing to warn about.
      EGRESS_PROXY_BLANK: "   ",
      DATABASE_URL: "postgres://x",
    });
    expect(named).toEqual(["EGRESS_PROXY_RESEARCH", "EGRESS_PROXY_SALES"]);
    // A boot line carrying the value would publish the proxy password into the log.
    expect(JSON.stringify(named)).not.toContain("s3cret");
  });

  test("a deployment with only the default has nothing to be told", () => {
    expect(
      ignoredEgressVariables({ EGRESS_PROXY_DEFAULT: "http://p:8080" }),
    ).toEqual([]);
  });
});

describe("what gets shown to people", () => {
  test("the label is the host only, never the credentials", () => {
    // The label goes into an admin page and an API response. Returning the
    // server string verbatim would publish the password to anyone who can read either.
    const label = deploymentEgressLabel({
      EGRESS_PROXY_DEFAULT: "http://bot:s3cret@proxy.internal:8080",
    });
    expect(label).toBe("proxy.internal:8080");
    expect(label).not.toContain("s3cret");
    expect(label).not.toContain("bot:");
  });

  test("a bare host:port labels as itself", () => {
    expect(
      deploymentEgressLabel({ EGRESS_PROXY_DEFAULT: "proxy.internal:8080" }),
    ).toBe("proxy.internal:8080");
  });
});
