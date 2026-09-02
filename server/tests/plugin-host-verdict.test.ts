import { beforeEach, describe, expect, test } from "bun:test";
import { checkNavigationTarget } from "../src/computer/target";
import {
  forgetResolvedHosts,
  type HostResolver,
  isPrivateAddress,
  resolvedHostVerdict,
} from "../src/net/host-verdict";
import {
  customUrlRefusal,
  resolvedCustomUrlRefusal,
} from "../src/plugins/catalogue";

/**
 * One verdict about where this deployment may send a request, asked by both callers.
 *
 * There used to be two. A Bot's browser checked IPv4 ranges and knew nothing about `.internal`
 * names; "add an MCP server" checked a deny-list of names and resolved nothing at all — so a public
 * hostname whose A record said `10.0.0.5` walked straight through it, and whoever controls a DNS
 * zone controls that completely. Both are now the same ranges and the same names, and the add path
 * also asks where the name actually points.
 *
 * NOTHING HERE TOUCHES A REAL RESOLVER. Every resolving test injects one: a suite that depended on
 * somebody else's DNS would be a suite that fails on an aeroplane and passes in review.
 */

beforeEach(() => {
  // The resolution cache is a module-level convenience for a form being retried. Between tests it is
  // just one test's answer leaking into the next.
  forgetResolvedHosts();
});

const answering =
  (answers: Record<string, string[]>): HostResolver =>
  async (hostname) => {
    const found = answers[hostname];
    if (!found) throw new Error(`no such host: ${hostname}`);
    return found;
  };

describe("the ranges, shared by both callers", () => {
  test.each([
    ["10.0.0.5", "RFC1918 10/8"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local, and the metadata endpoint"],
    ["172.16.4.4", "RFC1918 172.16/12"],
    ["172.31.255.255", "the top of 172.16/12"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["::1", "IPv6 loopback"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456::1", "IPv6 unique local, the half everybody actually uses"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:10.0.0.5", "an IPv4 private address wearing an IPv6 hat"],
    [
      "::ffff:a00:5",
      "the same address in hextets, which is the spelling that hides",
    ],
  ])("%s is private (%s)", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  // Either side of the private ranges. Wrong in the safe direction blocks real websites; wrong in
  // the unsafe direction exposes the network.
  test.each([
    ["8.8.8.8", "an ordinary public address"],
    ["172.15.0.1", "just below 172.16/12"],
    ["172.32.0.1", "just above 172.16/12"],
    ["2606:4700::1111", "an ordinary public IPv6 address"],
    ["::ffff:8.8.8.8", "a public IPv4 address wearing an IPv6 hat"],
  ])("%s is not private (%s)", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("where the name actually points", () => {
  test("a public name that resolves inside the network is refused", async () => {
    const verdict = await resolvedHostVerdict("mcp.example.com", {
      resolve: answering({ "mcp.example.com": ["10.0.0.5"] }),
    });

    expect(verdict).toEqual({
      allowed: false,
      fact: "laf:host_resolves_privately",
    });
  });

  test("one private answer among several is enough to refuse", async () => {
    // A name with two A records, one of them useful cover. Checking only the first would be a check
    // whoever writes the zone file decides the outcome of.
    const verdict = await resolvedHostVerdict("mcp.example.com", {
      resolve: answering({
        "mcp.example.com": ["93.184.216.34", "192.168.1.10"],
      }),
    });

    expect(verdict.allowed).toBe(false);
  });

  test("an AAAA record inside the network is refused too", async () => {
    const verdict = await resolvedHostVerdict("mcp.example.com", {
      resolve: answering({ "mcp.example.com": ["fd00::5"] }),
    });

    expect(verdict.allowed).toBe(false);
  });

  test("a name that resolves to the metadata endpoint is named as that", async () => {
    const verdict = await resolvedHostVerdict("mcp.example.com", {
      resolve: answering({ "mcp.example.com": ["169.254.169.254"] }),
    });

    // 169.254.169.254 is inside the link-local range as well, so the ranges answer first. Either
    // fact is a refusal; what matters is that the most specific one is reachable at all.
    expect(verdict.allowed).toBe(false);
  });

  test("an ordinary public answer is allowed", async () => {
    const verdict = await resolvedHostVerdict("mcp.example.com", {
      resolve: answering({ "mcp.example.com": ["93.184.216.34"] }),
    });

    expect(verdict).toEqual({ allowed: true });
  });

  /**
   * A name nothing can resolve is refused, not allowed.
   *
   * Failing open here would mean a resolver being slow, or a zone being briefly broken, is all it
   * takes to skip the check entirely — and the deployment would have had nothing to send a request
   * to either way, so there is nothing lost by saying so.
   */
  test("a name that will not resolve is refused rather than waved through", async () => {
    const verdict = await resolvedHostVerdict("nowhere.example.com", {
      resolve: answering({}),
    });

    expect(verdict).toEqual({ allowed: false, fact: "laf:host_unresolvable" });
  });

  test("an answer with no addresses in it is the same refusal", async () => {
    const verdict = await resolvedHostVerdict("empty.example.com", {
      resolve: async () => [],
    });

    expect(verdict).toEqual({ allowed: false, fact: "laf:host_unresolvable" });
  });

  test("the answer is remembered briefly, so a retried form is not a second lookup", async () => {
    let asked = 0;
    const resolve: HostResolver = async () => {
      asked += 1;
      return ["93.184.216.34"];
    };

    await resolvedHostVerdict("cached.example.com", { resolve });
    await resolvedHostVerdict("cached.example.com", { resolve });
    expect(asked).toBe(1);

    forgetResolvedHosts();
    await resolvedHostVerdict("cached.example.com", { resolve });
    expect(asked).toBe(2);
  });
});

describe("adding a custom server asks both halves", () => {
  test("the static rules still refuse everything they used to, without resolving", async () => {
    let asked = 0;
    const resolve: HostResolver = async () => {
      asked += 1;
      return ["93.184.216.34"];
    };

    for (const url of [
      "http://mcp.example.com/mcp",
      "https://127.0.0.1/mcp",
      "https://vault.internal/mcp",
      "https://metadata.goog./x",
    ]) {
      expect(await resolvedCustomUrlRefusal(url, { resolve })).not.toBeNull();
    }
    // Not one of them reached a resolver: a URL that is refused on sight has no business causing a
    // lookup of whatever somebody typed.
    expect(asked).toBe(0);
  });

  test("a name the static rules like is still refused for where it points", async () => {
    const url = "https://mcp.example.com/mcp";
    // On sight, this is an ordinary vendor address, and that is exactly the hole.
    expect(customUrlRefusal(url)).toBeNull();

    const refusal = await resolvedCustomUrlRefusal(url, {
      resolve: answering({ "mcp.example.com": ["10.0.0.5"] }),
    });
    expect(refusal).toContain("inside this network");
  });

  test("and allowed when it points at an ordinary public address", async () => {
    expect(
      await resolvedCustomUrlRefusal("https://mcp.example.com/mcp", {
        resolve: answering({ "mcp.example.com": ["93.184.216.34"] }),
      }),
    ).toBeNull();
  });
});

/**
 * What sharing the module changed for the Bot's browser, said out loud.
 *
 * The opt-in, the ranges and every sentence are untouched. What moved is that the two callers now
 * normalise the same way and know about the same address families, which closes three gaps where
 * "add an MCP server" refused an address and browsing to the identical address did not.
 */
describe("what the browser now refuses that it did not", () => {
  test("the root-anchored spelling of the metadata endpoint", () => {
    const verdict = checkNavigationTarget("http://metadata.google.internal./");

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain(
      "cloud credentials",
    );
  });

  test("a name under .localhost, which is reserved for this machine", () => {
    expect(checkNavigationTarget("http://admin.localhost/").allowed).toBe(
      false,
    );
    // And the opt-in still reaches it, because that is what a laptop deployment is for.
    expect(
      checkNavigationTarget("http://admin.localhost/", {
        allowPrivateHosts: true,
      }).allowed,
    ).toBe(true);
  });

  test("an IPv6 address inside this network", () => {
    expect(checkNavigationTarget("http://[fd00::5]/").allowed).toBe(false);
    expect(checkNavigationTarget("http://[fe80::1]/").allowed).toBe(false);
    // A public IPv6 address is still an ordinary website.
    expect(checkNavigationTarget("http://[2606:4700::1111]/").allowed).toBe(
      true,
    );
  });
});
