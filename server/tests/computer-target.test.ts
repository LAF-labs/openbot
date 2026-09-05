import { describe, expect, test } from "bun:test";
import { checkNavigationTarget } from "../src/computer/target";

describe("navigation targets", () => {
  test("allows an ordinary public address", () => {
    expect(checkNavigationTarget("https://example.com/pricing")).toEqual({
      allowed: true,
      url: "https://example.com/pricing",
    });
  });

  // Each of these is reachable from the Bot's container and not from the person's laptop, which is
  // the whole reason a browser running inside the deployment needs a floor under it.
  test.each([
    ["http://localhost:5432", "loopback by name"],
    ["http://127.0.0.1/admin", "loopback by address"],
    ["http://10.0.0.5/", "RFC1918 10/8"],
    ["http://192.168.1.1/", "RFC1918 192.168/16"],
    ["http://172.16.4.4/", "RFC1918 172.16/12"],
  ])("refuses %s (%s)", (url) => {
    const verdict = checkNavigationTarget(url);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain(
      "inside this deployment's own network",
    );
  });

  /*
   * The names, which this check had never asked about.
   *
   * `checkNavigationTarget` composed the ADDRESS predicates out of the shared module and left the
   * NAME one behind, so `http://vault.internal/` was refused when an administrator added it as an
   * MCP server and opened when a Bot browsed to it. The single-label entries are the sharper half:
   * every service on this deployment's own compose network answers to one, and the Bot's browser
   * sits on that network.
   */
  test.each([
    ["http://vault.internal/", ".internal"],
    ["http://printer.local/", ".local"],
    ["http://box.localdomain/", ".localdomain"],
    [
      "http://api.default.svc/",
      "a Kubernetes service, from inside the cluster",
    ],
    [
      "http://server:3001/",
      "this deployment's own API, by compose service name",
    ],
    ["http://postgres:5432/", "the database, likewise"],
    ["http://agent-bot:4200/", "the endpoint every Bot a person makes runs on"],
    ["http://agent-computer:4100/", "the browser talking to itself"],
    ["http://vault.internal./", "the root-anchored spelling of the same name"],
  ])("refuses %s (%s)", (url) => {
    const verdict = checkNavigationTarget(url);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain(
      "inside this deployment's own network",
    );
  });

  // Behind the same opt-in as the addresses, because a laptop deployment browsing its own compose
  // services by name is the case that opt-in exists for.
  test("an internal name is reachable when the deployment opts in", () => {
    expect(
      checkNavigationTarget("http://vault.internal/", {
        allowPrivateHosts: true,
      }).allowed,
    ).toBe(true);
  });

  /*
   * A public IPv6 literal carries no dot either, and the single-label rule would read it as a
   * service name. The address predicates are what judge literals; this is the case that says so.
   */
  test("a public IPv6 literal is not mistaken for a single-label name", () => {
    expect(checkNavigationTarget("http://[2606:4700::1111]/").allowed).toBe(
      true,
    );
    expect(checkNavigationTarget("http://[fd00::5]/").allowed).toBe(false);
  });

  // Separated from the list above because these are refused under every configuration; the second
  // argument exercises the private-host opt-in explicitly.
  test.each([
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://metadata.google.internal/", "cloud metadata by name"],
  ])("refuses %s (%s) even with private hosts allowed", (url) => {
    for (const allowPrivateHosts of [false, true]) {
      const verdict = checkNavigationTarget(url, { allowPrivateHosts });

      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toContain(
        "cloud credentials",
      );
    }
  });

  test("refuses a non-web scheme, naming it", () => {
    const verdict = checkNavigationTarget("file:///etc/passwd");

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe(
      "Only web addresses are allowed, and that one is file.",
    );
  });

  test("refuses something that is not an address at all", () => {
    expect(checkNavigationTarget("open the pricing page")).toEqual({
      allowed: false,
      reason: "That is not a web address.",
    });
  });

  // A laptop deployment browses its own services on purpose. It has to be asked for explicitly, so
  // that a production deployment cannot reach its own network by forgetting a setting.
  test("allows private hosts only when the deployment opts in", () => {
    expect(checkNavigationTarget("http://localhost:3000").allowed).toBe(false);
    expect(
      checkNavigationTarget("http://localhost:3000", {
        allowPrivateHosts: true,
      }).allowed,
    ).toBe(true);
  });

  // 172.15 and 172.32 sit either side of the private range. Getting the boundary wrong in the safe
  // direction blocks real websites; in the unsafe direction it exposes the network.
  test("gets the edges of the 172.16/12 range right", () => {
    expect(checkNavigationTarget("http://172.15.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.32.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.31.255.255/").allowed).toBe(false);
  });
});
