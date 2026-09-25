import { beforeEach, describe, expect, test } from "bun:test";
import type { BrowserContext } from "playwright";
import { forgetResolvedHosts } from "../../shared/net/host-verdict";
import { judgedLabelOf, nameToMatch } from "../src/label-hold";
import {
  guardNavigations,
  hopVerdict,
  hostnameOf,
  privateServerAddressOf,
  resolvedHopVerdict,
} from "../src/navigation-guard";

/**
 * The decisions under the two browser boundaries, without a browser.
 *
 * `browser-boundaries.test.ts` drives them through Chromium; these pin the rules those runs depend on
 * and that a browser run would only show as a flaky miss: which documents the floor judges at all,
 * and which name the role engine is asked for.
 */

describe("the floor, per hop", () => {
  test("a document made inside the browser contacts nobody, and passes", () => {
    for (const url of [
      "about:blank",
      "about:srcdoc",
      "chrome-error://chromewebdata/",
      "data:text/html,<h1>x</h1>",
      "blob:https://shop.example/7c1e0f5a-5d1b-4a8e-9a53-2d4f7b3c6e01",
    ]) {
      expect([url, hopVerdict(url, false).allowed]).toEqual([url, true]);
    }
  });

  test("an address with a host is the server's floor, opt-in and all", () => {
    expect(hopVerdict("https://bit.ly/3xYz", false).allowed).toBe(true);
    expect(hopVerdict("http://127.0.0.1:4100/health", false).allowed).toBe(
      false,
    );
    expect(hopVerdict("http://127.0.0.1:4100/health", true).allowed).toBe(true);
    expect(hopVerdict("http://agent-computer:4100/", false).allowed).toBe(
      false,
    );
    // The metadata endpoint is refused whatever a deployment opted into.
    expect(hopVerdict("http://169.254.169.254/", true).allowed).toBe(false);
    expect(hopVerdict("http://metadata.google.internal./", true).allowed).toBe(
      false,
    );
  });

  test("this container's own disk is not a web address", () => {
    expect(hopVerdict("file:///profiles/other-bot/Cookies", true).allowed).toBe(
      false,
    );
  });

  test("hosts compare the way the floor normalises them", () => {
    expect(hostnameOf("https://WWW.Coupang.com./x")).toBe("www.coupang.com");
    expect(hostnameOf("not a url")).toBe("");
  });
});

describe("the name a control is held to", () => {
  test("is the judged name exactly, in the ordinary case", () => {
    expect(nameToMatch("결제하기")).toBe("결제하기");
    expect(nameToMatch('say "hi"')).toBe('say "hi"');
  });

  test("is a prefix when the server may have cut it", () => {
    const judged = `${"가".repeat(190)}(1+1)[a]?.`;
    expect(judged.length).toBe(200);
    const pattern = nameToMatch(judged);
    expect(pattern).toBeInstanceOf(RegExp);
    expect((pattern as RegExp).test(`${judged} 그리고 더 긴 이름`)).toBe(true);
    // Regex characters in a label are the label's, not the pattern's.
    expect((pattern as RegExp).test(`${"가".repeat(190)}11a.`)).toBe(false);
  });

  test("covers only the names a snapshot renders as none, when none was judged", () => {
    const pattern = nameToMatch("") as RegExp;
    expect(pattern.test("")).toBe(true);
    expect(pattern.test("/api/")).toBe(true);
    expect(pattern.test("x".repeat(901))).toBe(true);
    // An unnamed icon that grew a money word is not the control that was judged.
    expect(pattern.test("결제하기")).toBe(false);
  });

  test("is nothing at all when the caller judged nothing usable", () => {
    expect(judgedLabelOf(undefined)).toBeNull();
    expect(judgedLabelOf({ role: "", name: "저장" })).toBeNull();
    expect(judgedLabelOf({ role: "button", name: 3 })).toBeNull();
    expect(judgedLabelOf({ role: "button", name: "" })).toEqual({
      role: "button",
      name: "",
    });
  });
});

/**
 * Where a name POINTS, not how it is spelled (security review 2026-09-25 F1).
 *
 * `http://127.0.0.1.nip.io/` passed every hop: nip.io is a public name whose A record is the IP in
 * it. The resolver is injected — these never touch somebody else's DNS — and the cache is cleared
 * between cases, since it is keyed by name alone.
 */
describe("the floor, resolved", () => {
  const answers =
    (table: Record<string, string[]>) =>
    async (host: string): Promise<string[]> => {
      const found = table[host];
      if (!found) throw new Error(`ENOTFOUND ${host}`);
      return found;
    };
  const resolve = answers({
    "127.0.0.1.nip.io": ["127.0.0.1"],
    "metadata.evil.example": ["169.254.169.254"],
    "mapped.evil.example": ["::ffff:127.0.0.1"],
    "mapped-hex.evil.example": ["::ffff:a9fe:a9fe"],
    "split.evil.example": ["93.184.216.34", "10.0.0.5"],
    "www.naver.com": ["223.130.200.104", "223.130.192.248"],
    "shop.example": ["93.184.216.34"],
  });

  beforeEach(() => forgetResolvedHosts());

  test("a public name whose record says 127.0.0.1 is refused", async () => {
    const verdict = await resolvedHopVerdict(
      "http://127.0.0.1.nip.io/",
      false,
      resolve,
    );
    expect(verdict.allowed).toBe(false);
  });

  test("so is one pointing at the metadata endpoint", async () => {
    const verdict = await resolvedHopVerdict(
      "http://metadata.evil.example/latest/meta-data/",
      false,
      resolve,
    );
    expect(verdict.allowed).toBe(false);
  });

  test("an IPv4-mapped IPv6 answer is asked the IPv4 question", async () => {
    for (const url of [
      "http://mapped.evil.example/",
      "http://mapped-hex.evil.example/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      const verdict = await resolvedHopVerdict(url, false, resolve);
      expect([url, verdict.allowed]).toEqual([url, false]);
    }
  });

  test("every answer counts, not the first one", async () => {
    const verdict = await resolvedHopVerdict(
      "https://split.evil.example/",
      false,
      resolve,
    );
    expect(verdict.allowed).toBe(false);
  });

  test("an ordinary site still opens, and a name that resolves nowhere does not", async () => {
    const naver = await resolvedHopVerdict(
      "https://www.naver.com/",
      false,
      resolve,
    );
    expect(naver.allowed).toBe(true);
    const nowhere = await resolvedHopVerdict(
      "https://nowhere.example/",
      false,
      resolve,
    );
    expect(nowhere.allowed).toBe(false);
  });

  test("the opt-in and documents made inside the browser are not resolved at all", async () => {
    const refuse = async (): Promise<string[]> => {
      throw new Error("asked");
    };
    const optedIn = await resolvedHopVerdict(
      "http://127.0.0.1.nip.io/",
      true,
      refuse,
    );
    expect(optedIn.allowed).toBe(true);
    const inside = await resolvedHopVerdict(
      "data:text/html,<p>x</p>",
      false,
      refuse,
    );
    expect(inside.allowed).toBe(true);
    // Refused by the string before any resolver is asked.
    const literal = await resolvedHopVerdict(
      "http://169.254.169.254/",
      false,
      refuse,
    );
    expect(literal.allowed).toBe(false);
  });

  test("the address a document was actually fetched from is judged too (rebinding)", async () => {
    const from = (ipAddress: string | null) => ({
      serverAddr: async () => (ipAddress ? { ipAddress, port: 80 } : null),
    });
    expect(await privateServerAddressOf(from("169.254.169.254"))).toBe(
      "169.254.169.254",
    );
    expect(await privateServerAddressOf(from("::ffff:10.0.0.5"))).toBe(
      "::ffff:10.0.0.5",
    );
    expect(await privateServerAddressOf(from("223.130.200.104"))).toBeNull();
    expect(await privateServerAddressOf(from(null))).toBeNull();
  });

  /**
   * The guard itself, on a stand-in for Chromium's browser session: a public hop continues, and each
   * redirect it answers with — paused again as a request of its own — is judged alone, so the hop
   * whose name resolves inside is failed before it is sent, two redirects deep.
   */
  test("a redirect to a name resolving privately is failed at that hop", async () => {
    type Paused = {
      requestId: string;
      request: {
        url: string;
        method: string;
        headers: Record<string, string>;
      };
      frameId: string;
      redirectedRequestId?: string;
    };
    let paused: ((event: Paused) => Promise<void>) | undefined;
    const sent: [string, string][] = [];
    const session = {
      on: (_event: string, handler: (event: Paused) => Promise<void>) => {
        paused = handler;
      },
      send: async (method: string, params?: { requestId?: string }) => {
        sent.push([method, params?.requestId ?? ""]);
        return {};
      },
    };
    const context = {
      browser: () => ({ newBrowserCDPSession: async () => session }),
      on: () => undefined,
    };
    const refused: [string, string | null][] = [];
    await guardNavigations(context as unknown as BrowserContext, {
      allowPrivateHosts: false,
      resolve,
      onRefused: (hop) => refused.push([hop.url, hop.redirectedFrom]),
    });
    const hop = (requestId: string, url: string, from?: string): Paused => ({
      requestId,
      request: { url, method: "GET", headers: {} },
      frameId: "tab",
      ...(from ? { redirectedRequestId: from } : {}),
    });
    await paused?.(hop("1", "https://shop.example/go"));
    await paused?.(hop("2", "https://www.naver.com/next", "1"));
    await paused?.(hop("3", "http://127.0.0.1.nip.io:5432/", "2"));
    expect(sent).toEqual([
      ["Fetch.enable", ""],
      ["Fetch.continueRequest", "1"],
      ["Fetch.continueRequest", "2"],
      ["Fetch.failRequest", "3"],
    ]);
    expect(refused).toEqual([
      ["http://127.0.0.1.nip.io:5432/", "https://www.naver.com/next"],
    ]);
  });
});
