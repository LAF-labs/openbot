import { describe, expect, test } from "bun:test";
import { addressKeyOf, ownAddressesFrom } from "../../shared/net/own-addresses";
import {
  checkNavigationTarget,
  OWN_ADDRESS_REFUSED,
  resolvedNavigationTarget,
} from "../src/computer/target";

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

  /*
   * THE AUDITOR'S TEN, as one table (audit A3, 2026-09-10).
   *
   * Every row is a verdict on the address a browser is about to request — which, since the computer
   * judges every hop (agent-computer/src/navigation-guard.ts), is every address a navigation
   * reaches and not only the one a Bot named. That is how the redirect row belongs here: its start
   * is allowed, exactly as measured ("ALLOW https://httpbin.org/redirect-to?url=http://127.0.0.1…"),
   * and its hop is refused. That the hop is stopped before it is sent is proven where a redirect is
   * actually followed: `agent-computer/tests/browser-boundaries.test.ts` against a real Chromium, and
   * a Docker network measured 2026-09-13. The last three are the legitimate places in the list, and
   * pin that the floor is not a wall.
   */
  const REDIRECTOR =
    "https://httpbin.org/redirect-to?url=http://127.0.0.1:4100/health";
  test.each([
    ["localhost", "http://localhost:4100/health", false],
    [
      "the metadata endpoint",
      "http://169.254.169.254/latest/meta-data/",
      false,
    ],
    ["an IPv6 loopback literal", "http://[::1]:4100/health", false],
    ["an IPv6 private literal", "http://[fd00::1]/", false],
    ["an IPv4-mapped IPv6 literal", "http://[::ffff:127.0.0.1]/", false],
    ["an allowed public redirector, where it starts", REDIRECTOR, true],
    [
      "that redirector's hop",
      new URL(REDIRECTOR).searchParams.get("url") ?? "",
      false,
    ],
    ["a file: URL", "file:///etc/passwd", false],
    ["a data: URL", "data:text/html,<script>alert(1)</script>", false],
    ["an internal Docker name", "http://agent-computer:4100/computers", false],
    ["another internal Docker name", "http://postgres:5432/", false],
    ["a bank host", "https://obank.kbstar.com/quics?page=C025255", true],
    ["a link shortener", "https://bit.ly/3xYzAbC", true],
    ["a Korean IDN", "https://한국은행.한국/", true],
  ] as const)("%s: %s → allowed=%p", (_what, url, allowed) => {
    expect(checkNavigationTarget(url).allowed).toBe(allowed);
  });
});

/*
 * THE BOT'S BROWSER NEVER OPENS THE APP IT IS ANSWERED IN (`shared/net/own-addresses.ts`).
 *
 * A person presses 허용 on a Bot's question in the app, and signs in to the app with the accounts
 * the Bot's browser holds logins for. Until 2026-10-03 nothing refused the app's own address: the
 * floor knew the deployment's network and not the deployment's name.
 */
describe("the deployment's own addresses", () => {
  /** A deployment of the fleet, as its `.env` and compose file name it. */
  const fleet = ownAddressesFrom({
    BETTER_AUTH_URL: "https://shop.agent.example.com",
    PUBLIC_ORIGIN: "https://shop.agent.example.com",
    TRUSTED_ORIGINS: "https://shop.agent.example.com",
    LAF_OIDC_ISSUER: "https://auth.agent.example.com",
  });
  const asked = (url: string, ownAddresses = fleet) =>
    checkNavigationTarget(url, { ownAddresses });

  test("are read from the variables the server already names them with, once each", () => {
    expect(fleet).toEqual([
      "shop.agent.example.com:",
      "auth.agent.example.com:",
    ]);
    // A list, a path, a trailing slash, a port: what is kept is the host and the port said.
    expect(
      ownAddressesFrom({
        TRUSTED_ORIGINS:
          " https://a.example.com/ , http://localhost:3010,https://a.example.com/app ",
        PUBLIC_ORIGIN: "https://A.example.com.",
      }),
    ).toEqual(["a.example.com:", "localhost:3010"]);
  });

  test("a value that names no web address names nothing, and stops nothing from starting", () => {
    expect(ownAddressesFrom({})).toEqual([]);
    expect(
      ownAddressesFrom({
        BETTER_AUTH_URL: "",
        PUBLIC_ORIGIN: "shop.example.com",
        TRUSTED_ORIGINS: ",, ,",
        LAF_OIDC_ISSUER: "ftp://auth.example.com",
      }),
    ).toEqual([]);
  });

  test("the app is refused however its address is written, under a code of its own", () => {
    for (const url of [
      "https://shop.agent.example.com",
      "https://shop.agent.example.com/channel/channel_1",
      "https://shop.agent.example.com/api/auth/callback/naver?code=abc",
      "https://shop.agent.example.com:443/",
      // The other scheme is one redirect from the same app.
      "http://shop.agent.example.com/",
      "https://SHOP.agent.example.com/",
      "https://shop.agent.example.com./",
      "https://somebody@shop.agent.example.com/",
    ]) {
      const verdict = asked(url);
      expect([url, verdict.allowed]).toEqual([url, false]);
      expect([url, !verdict.allowed && verdict.fact]).toEqual([
        url,
        OWN_ADDRESS_REFUSED,
      ]);
    }
  });

  test("and so is where people sign in to it", () => {
    const verdict = asked(
      "https://auth.agent.example.com/authorize?client_id=shop&redirect_uri=https%3A%2F%2Fshop.agent.example.com%2Fapi%2Fauth%2Foauth2%2Fcallback%2Flaf",
    );
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.fact).toBe(OWN_ADDRESS_REFUSED);
  });

  test("nothing is matched by its ending, its beginning or what it carries: other people's sites stay open", () => {
    for (const url of [
      // A neighbour on the fleet, and the fleet's own page: not this deployment's to refuse.
      "https://other.agent.example.com/",
      "https://agent.example.com/",
      "https://example.com/",
      "https://shop.agent.example.com.evil.test/",
      "https://evilshop.agent.example.com/",
      "https://shop.agent.example.com@evil.test/",
      "https://evil.test/?next=https://shop.agent.example.com/",
      // Another port of the name is not the app, which is said without one.
      "https://shop.agent.example.com:8443/",
    ]) {
      expect([url, asked(url).allowed]).toEqual([url, true]);
    }
  });

  test("an ordinary refusal carries no such code, and a list that names nothing changes nothing", () => {
    const inside = asked("http://10.0.0.5/");
    expect(inside.allowed).toBe(false);
    expect(!inside.allowed && inside.fact).toBeUndefined();
    expect(asked("https://shop.agent.example.com/", []).allowed).toBe(true);
    expect(
      checkNavigationTarget("https://shop.agent.example.com/").allowed,
    ).toBe(true);
  });

  /*
   * A laptop opted in to browse its own services is not opted in to answer its own questions. The
   * app there is one port of `localhost`, and every other local page stays open — the fixtures a
   * development browser is pointed at among them.
   */
  test("on a laptop the opt-in does not reach the app, and reaches everything else it did", () => {
    const laptop = ownAddressesFrom({
      BETTER_AUTH_URL: "http://localhost:3010",
      TRUSTED_ORIGINS: "http://localhost:3010",
    });
    const opted = (url: string) =>
      checkNavigationTarget(url, {
        allowPrivateHosts: true,
        ownAddresses: laptop,
      });
    for (const url of [
      "http://localhost:3010/",
      "http://localhost:3010/settings/boundaries",
      "https://localhost:3010/",
      "http://LOCALHOST.:3010/",
    ]) {
      const verdict = opted(url);
      expect([url, verdict.allowed]).toEqual([url, false]);
      expect(!verdict.allowed && verdict.fact).toBe(OWN_ADDRESS_REFUSED);
    }
    for (const url of [
      "http://localhost:4000/",
      "http://localhost/",
      "http://127.0.0.1:4100/health",
      "http://agent-computer:4100/",
    ]) {
      expect([url, opted(url).allowed]).toEqual([url, true]);
    }
    // The metadata address is refused before either, and stays the floor's own refusal.
    const metadata = opted("http://169.254.169.254/");
    expect(metadata.allowed).toBe(false);
    expect(!metadata.allowed && metadata.fact).toBeUndefined();
  });

  test("the check that resolves a name refuses the app before it resolves anything", async () => {
    const resolved: string[] = [];
    const verdict = await resolvedNavigationTarget(
      "https://shop.agent.example.com/",
      {
        ownAddresses: fleet,
        resolve: async (name) => {
          resolved.push(name);
          return ["93.184.216.34"];
        },
      },
    );
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.fact).toBe(OWN_ADDRESS_REFUSED);
    expect(resolved).toEqual([]);
  });

  test("a key is the host and the port that was said", () => {
    expect(addressKeyOf(new URL("https://Shop.Example.com./x"))).toBe(
      "shop.example.com:",
    );
    expect(addressKeyOf(new URL("http://shop.example.com:80/"))).toBe(
      "shop.example.com:",
    );
    expect(addressKeyOf(new URL("http://localhost:3010/"))).toBe(
      "localhost:3010",
    );
  });
});
