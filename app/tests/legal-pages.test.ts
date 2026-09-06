import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import { router } from "../src/router";

/**
 * The legal surface: two documents anybody can read, and the sentence that points at them on the
 * screen where agreeing happens.
 *
 * Three things here are invisible from a green gate. A route that landed under `_authed` would
 * typecheck, render, and be unreadable by the one person who most needs to read it — somebody
 * deciding whether to sign in. A document that lost its draft banner would still render. And the
 * consent sentence could move to the second screen, after the first button, and nothing would
 * notice that the agreement had been put behind a press.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

describe("the two documents", () => {
  test.each(["/legal/terms", "/legal/privacy"] as const)(
    "%s is a route outside the sign-in gate",
    (path) => {
      const route = router.routesByPath[path];
      expect(route?.fullPath).toBe(path);
      // The id is the route's place in the tree; `_authed` in it would mean a session is required.
      expect(route?.id).not.toContain("_authed");
    },
  );

  test.each(["/terms", "/privacy"] as const)(
    "%s is the short address, and it is a route too",
    (path) => {
      // Typed and printed; the page itself lives under /legal beside its sibling.
      expect(router.routesByPath[path]?.fullPath).toBe(path);
    },
  );

  test.each(["terms.md", "privacy.md"])(
    "%s is Korean, carries its version, and is marked a draft in the file but not on the page",
    (file) => {
      const text = read(`legal/${file}`);
      // Hangul, not English, in the body: the text is content and there is no dictionary for it.
      expect(text).toMatch(/[가-힣]/);
      /*
       * The draft marker is for whoever replaces the file, not for the person reading the page:
       * an HTML comment, which markdown does not render. It has to be at the head, so the first
       * thing anybody opening the file sees is that counsel has not read it yet.
       */
      const comment = text.indexOf("-->");
      expect(text.startsWith("<!--")).toBe(true);
      expect(text.slice(0, comment)).toContain(
        "법률 자문 전 초안 — 자문 후 이 파일만 교체",
      );
      expect(text.slice(comment)).not.toContain("법률 자문 전 초안");
      // The version is on the page, under the title: it is the thing being agreed to.
      expect(text.slice(comment)).toMatch(/^# .+\n\n버전 \d{4}-\d{2}-\d{2}$/m);
    },
  );

  test("both documents say how to reach a person", () => {
    for (const file of ["terms.md", "privacy.md"]) {
      expect(read(`legal/${file}`)).toContain("didrbs1214@gmail.com");
    }
  });

  test("the pages render the file rather than a copy of it", () => {
    // `?raw` and not a template literal in JSX: the text lives in one file, which is the file the
    // banner says to replace.
    expect(read("routes/legal/terms.tsx")).toContain(
      'from "@/legal/terms.md?raw"',
    );
    expect(read("routes/legal/privacy.tsx")).toContain(
      'from "@/legal/privacy.md?raw"',
    );
    expect(read("components/legal/legal-page.tsx")).toContain("<Streamdown");
  });
});

describe("where the documents are linked from", () => {
  test("the footer links both, and the sign-in screen and Settings draw it", () => {
    const links = read("components/legal/legal-links.tsx");
    expect(links).toContain('to="/legal/terms"');
    expect(links).toContain('to="/legal/privacy"');
    expect(read("routes/sign.tsx")).toContain("<LegalLinks");
    expect(read("routes/_authed/settings/index.tsx")).toContain("<LegalLinks");
  });

  test("the consent sentence is on the FIRST welcome screen, with both links", () => {
    const welcome = read("routes/_authed/welcome.tsx");
    const hello = welcome.indexOf('step === "hello" ? (');
    const create = welcome.indexOf(") : (", hello);
    expect(hello).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(hello);
    const firstScreen = welcome.slice(hello, create);
    expect(firstScreen).toContain("<ConsentLine");

    const line = read("components/legal/consent-line.tsx");
    expect(line).toContain('to="/legal/terms"');
    expect(line).toContain('to="/legal/privacy"');
  });

  test("다음 on the first screen is what records the agreement", () => {
    // The sentence says continuing means agreeing; the button that continues has to be the one
    // that writes the stamp, or the stamp records an act the sentence never named.
    const welcome = read("routes/_authed/welcome.tsx");
    expect(welcome).toContain("agreeToLegal(queryClient)");
    expect(read("lib/auth/consent.ts")).toContain('"/api/me/consent"');
  });

  test("a changed text sends everybody back through the door", () => {
    const gate = read("routes/_authed.tsx");
    expect(gate).toContain("user.consentRequired");
    expect(gate).toContain('to: "/consent"');
    const screen = router.routesByPath["/consent"];
    expect(screen?.id).toContain("_authed");
    expect(read("routes/_authed/consent.tsx")).toContain("<ConsentLine");
  });

  test("the sentence keeps its two placeholders in Korean", () => {
    // The line is split on the placeholders after translation, so a Korean entry that dropped
    // one would drop a link — and the josa is on the placeholder, so it has to be 과.
    const korean =
      ko["By continuing you agree to the {terms} and the {privacy}."];
    expect(korean).toContain("{terms}과");
    expect(korean).toContain("{privacy}에");
  });
});
