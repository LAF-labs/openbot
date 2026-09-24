import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";

/**
 * WHAT THE BOT'S PROFILE, SETTINGS AND HELP STILL SAID FROM WHEN THERE WERE SEVERAL.
 *
 * The 0.5.3 audit (items 9 and 15): a question card waited on "당신", the memory card spoke of what
 * the Bot "worked out about 당신 … only you see yours", the help's routines section had you pick
 * "어느 봇이" and sent results to "그 봇과의 대화방" — and four cards on the profile printed whatever
 * an `Error` happened to carry, the browser's own English included.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

describe("the several-people words", () => {
  test("no Korean string calls the owner 당신", () => {
    const calling = Object.entries(ko).filter(([, korean]) =>
      korean.includes("당신"),
    );
    expect(calling).toEqual([]);
  });

  test("the guide has one Bot and conversations, not rooms", () => {
    const guide = read("help/guide.md");
    expect(guide).not.toContain("어느 봇이");
    expect(guide).not.toContain("대화방");
    // The approval section points at the list by the names the screen draws, not at "경계".
    expect(guide).not.toContain("**경계**");
  });
});

describe("the Bot's profile", () => {
  test("no card draws an error's own message", () => {
    const profile = read("components/agents/agent-profile.tsx");
    expect(profile).not.toMatch(/error\??\.message|caught\.message/);
    expect(profile).toContain("saveFailure(");
  });
});
