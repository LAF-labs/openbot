import { describe, expect, test } from "bun:test";
import { isSavedOrigin, loginOriginOf } from "../shared/login-origin";

/**
 * WHERE A SAVED LOGIN MAY BE PUT IS AN ORIGIN, WRITTEN ONE WAY, AND HTTPS
 * (`shared/login-origin.ts`, `docs/laf/redesign-2026-10.md` §6).
 *
 * The same function reads what a person typed when they saved a login and the address of the frame
 * a Bot is about to fill, so that the two are never compared as two strings somebody wrote.
 */
describe("the origin a login is saved for", () => {
  test("is what a person types, read one way: a host, an address with a path, any case, the port its scheme implies", () => {
    for (const written of [
      "nid.naver.com",
      "  nid.naver.com  ",
      "NID.Naver.com",
      "https://nid.naver.com",
      "https://nid.naver.com/",
      "https://nid.naver.com:443/nidlogin.login?mode=form&url=https://www.naver.com#top",
    ]) {
      expect([written, loginOriginOf(written)]).toEqual([
        written,
        "https://nid.naver.com",
      ]);
    }
    // An address written as numbers is a site too — both families of them. (One word that is
    // not numbers is not: see below.)
    expect(loginOriginOf("https://[2001:db8::1]/login")).toBe(
      "https://[2001:db8::1]",
    );
    expect(loginOriginOf("[2001:db8::1]:8443")).toBe(
      "https://[2001:db8::1]:8443",
    );
    expect(loginOriginOf("https://192.0.2.10/login")).toBe(
      "https://192.0.2.10",
    );
    // A port that is not the scheme's own is part of what was saved.
    expect(loginOriginOf("shop.example:8443")).toBe(
      "https://shop.example:8443",
    );
    // A name that is not ASCII is saved as the browser will say it.
    expect(loginOriginOf("https://가게.kr/login")).toBe(
      "https://xn--o39akk.kr",
    );
  });

  test("is never plain HTTP, never an address that carries a name and password of its own, and never something that is not an address", () => {
    for (const written of [
      "http://shop.example",
      "http://shop.example:443",
      "ftp://shop.example",
      "javascript:alert(1)",
      "https://user:hunter2@shop.example",
      "https://user@shop.example",
      "",
      "   ",
      "shop example",
      "https://",
      "https://shop.example\nhttps://evil.example",
      // A slip in the scheme: one slash, a backslash, none. Given a scheme of its own each parses
      // as a host called `https` or `http` — an origin that is nobody's.
      "https:/shop.example",
      "https:\\shop.example",
      "https:shop.example",
      "http:/shop.example",
      "shop.example\\login",
      // One word is not a site's name.
      "https://intranet",
      "shop",
    ]) {
      expect([written, loginOriginOf(written)]).toEqual([written, null]);
    }
  });

  test("is no longer than an address is: a host name past 253 characters, or anything past a couple of thousand, is not read as one", () => {
    // The parser takes a host of any length; a name cannot be longer than this.
    const longest = `${"a.".repeat(124)}abcde`;
    expect(longest).toHaveLength(253);
    expect(loginOriginOf(longest)).toBe(`https://${longest}`);
    expect(loginOriginOf(`a${longest}`)).toBeNull();
    // Most of a megabyte, with a path or as a host: not parsed, not saved.
    expect(
      loginOriginOf(`https://shop.example/${"a".repeat(900_000)}`),
    ).toBeNull();
    expect(loginOriginOf(`${"a".repeat(900_000)}.example`)).toBeNull();
    // An ordinary address with an ordinary path is still its origin.
    expect(loginOriginOf(`https://shop.example/${"a".repeat(1_000)}`)).toBe(
      "https://shop.example",
    );
  });

  test("lets a developer's own machine through without a certificate only when asked by name, and nothing else with it", () => {
    const dev = { allowLoopbackHttp: true };
    expect(loginOriginOf("http://127.0.0.1:4395/card")).toBeNull();
    expect(loginOriginOf("http://127.0.0.1:4395/card", dev)).toBe(
      "http://127.0.0.1:4395",
    );
    expect(loginOriginOf("http://localhost:3010", dev)).toBe(
      "http://localhost:3010",
    );
    expect(loginOriginOf("http://app.localhost:3000", dev)).toBe(
      "http://app.localhost:3000",
    );
    // Still not any plain-HTTP site: a host that only looks local is a site like any other.
    for (const written of [
      "http://shop.example",
      "http://127.0.0.1.shop.example",
      "http://localhost.shop.example",
      "http://192.168.0.10",
    ]) {
      expect([written, loginOriginOf(written, dev)]).toEqual([written, null]);
    }
  });
});

describe("whether a frame is where a login was saved for", () => {
  const saved = ["https://nid.naver.com", "https://sell.smartstore.naver.com"];

  test("is the frame's origin being one of them, whatever page of it the frame is on", () => {
    expect(
      isSavedOrigin(saved, "https://nid.naver.com/nidlogin.login?mode=form"),
    ).toBe(true);
    expect(
      isSavedOrigin(saved, "https://SELL.smartstore.naver.com/#/home"),
    ).toBe(true);
  });

  test("is not the same host over HTTP, another port, a parent or a child of the name, or a look-alike", () => {
    for (const address of [
      // The interception the scheme is saved for.
      "http://nid.naver.com/nidlogin.login",
      "https://nid.naver.com:8443/nidlogin.login",
      "https://naver.com/",
      "https://evil.nid.naver.com/",
      "https://nid.naver.com.evil.example/",
      "https://nid-naver.com/",
      "about:blank",
      "",
    ]) {
      expect([address, isSavedOrigin(saved, address)]).toEqual([
        address,
        false,
      ]);
    }
    expect(isSavedOrigin([], "https://nid.naver.com/")).toBe(false);
  });
});
