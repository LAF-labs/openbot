import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import { router } from "../src/router";

/**
 * The help page: five sections a person who does not write software can act on.
 *
 * What goes wrong with a help page is invisible from a green gate. It names a button the app
 * stopped drawing two releases ago; it grows a section into an essay nobody finishes; it lands on
 * a route nobody links. Each is checked here against the thing it can drift from — the Korean
 * dictionary, a sentence count, the route tree and the footer.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

const guide = read("help/guide.md");

/** Only exact Korean strings the app draws through `t()` count as button names. */
const drawn = new Set(Object.values(ko));

const SECTIONS = [
  "봇 만들기",
  "연결",
  "승인",
  "루틴",
  "문제가 생기면",
] as const;

function sectionsOf(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const [heading, ...body] = part.split("\n");
    found.set((heading ?? "").trim(), body.join("\n").trim());
  }
  return found;
}

describe("the guide", () => {
  test("is Korean, and has exactly the five sections in order", () => {
    expect(guide).toMatch(/[가-힣]/);
    expect([...sectionsOf(guide).keys()]).toEqual([...SECTIONS]);
  });

  test.each([...SECTIONS])("%s is three to six plain sentences", (name) => {
    const body = sectionsOf(guide).get(name as string) ?? "";
    // No lists, no tables, no headings inside: a paragraph somebody reads once.
    expect(body).not.toMatch(/^[-*|#]/m);
    const sentences = body.match(/[.?!](?=\s|$)/g) ?? [];
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(6);
  });

  test("every bold name is a string the app actually draws", () => {
    const names = [...guide.matchAll(/\*\*([^*\n]+)\*\*/g)].map(
      (match) => match[1] as string,
    );
    expect(names.length).toBeGreaterThan(20);
    const invented = names.filter((name) => !drawn.has(name));
    expect(invented).toEqual([]);
  });

  test("links both legal documents from inside the text", () => {
    expect(guide).toContain("](/legal/terms)");
    expect(guide).toContain("](/legal/privacy)");
  });

  test("tells the two failure lines apart: wait, or press again", () => {
    // The wording the transcript already uses (`turn-failure.ts`), quoted so a person can match
    // what they see to what to do.
    const trouble = sectionsOf(guide).get("문제가 생기면") ?? "";
    expect(trouble).toContain("조금 기다렸다가");
    expect(trouble).toContain("다시 물어봐 주세요");
    expect(
      ko[
        "Answers are coming faster than the model can take right now. Give it a moment and ask again."
      ],
    ).toContain("조금 기다렸다가");
    expect(ko["The Bot could not reach its model. Ask again."]).toContain(
      "다시 물어봐 주세요",
    );
  });
});

describe("where the guide lives", () => {
  test("/help is a route inside the app shell, behind the sign-in gate", () => {
    const route = router.routesByPath["/help"];
    expect(route?.fullPath).toBe("/help");
    expect(route?.id).toContain("_authed");
    expect(route?.id).toContain("_app");
  });

  test("the page renders the file rather than a copy of it, and draws the box and the links", () => {
    const page = read("components/help/help-page.tsx");
    expect(page).toContain('from "@/help/guide.md?raw"');
    expect(page).toContain("<Streamdown");
    expect(page).toContain("<FeedbackDialog");
    expect(page).toContain("<LegalLinks");
  });

  test("the roster's footer carries it", () => {
    const sidebar = read("components/app-sidebar/bot-sidebar.tsx");
    const table = sidebar.slice(
      sidebar.indexOf("const FOOTER_LINKS"),
      sidebar.indexOf("] as const"),
    );
    expect(table).toContain('to: "/help"');
    expect(ko.Help).toBeTruthy();
  });

  test("Settings draws the box and links the page", () => {
    const settings = read("routes/_authed/settings/index.tsx");
    expect(settings).toContain("<FeedbackDialog");
    expect(settings).toContain('to="/help"');
  });
});
