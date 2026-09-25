import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NOTEBOOK_SLOTS } from "@shared/notebook";
import { SLOT_WORDS } from "../src/components/notebook/notebook";
import { ko } from "../src/lib/i18n-ko";

/**
 * 수첩 IS THE OWNER'S PEN, and a line's source is the route it came through: `/memories` is the
 * Bot's `remember`, `/notebook` is the owner. That holds only while no tool a Bot can call reaches
 * `/notebook` — the Bot's tools run in the owner's browser with the owner's session, so the route
 * needing a session proves nothing. A Bot that could write through it could mark its own lines as
 * the owner's, and the prompt draws those under "사장님이 적었거나 확인한 것" (the same shape as
 * `server/tests/shop-boundary.test.ts`).
 */

const root = join(import.meta.dir, "../..");

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe("who writes on 수첩", () => {
  test("no tool handler a Bot can call reaches the owner's routes", () => {
    const handlers = [
      ...sources(join(root, "app/src/lib/copilot")),
      ...sources(join(root, "shared/tools")),
      ...sources(join(root, "agent-bot/src")),
      ...sources(join(root, "server/src/runner")),
      ...sources(join(root, "server/src/routines")),
      ...sources(join(root, "server/src/computer")),
    ];
    expect(handlers.length).toBeGreaterThan(40);
    const reaching = handlers
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return (
          text.includes("/notebook") ||
          text.includes("agents/notebook") ||
          /\b(writeLine|reviseLine|confirmLine)\b/.test(text)
        );
      })
      .map((path) => relative(root, path));
    expect(reaching).toEqual([]);
  });

  test("the Bot's own tool still posts to /memories, which marks its lines as the Bot's", () => {
    const tools = readFileSync(
      join(root, "app/src/lib/copilot/self-tools.tsx"),
      "utf8",
    );
    expect(tools).toContain("/memories`");
    expect(tools).not.toContain("source");
  });
});

describe("the shop lines' words", () => {
  /*
   * Read through `t()` on a variable, which `i18n-coverage.test.ts` cannot see — so walked here.
   */
  test("every slot has its words, and every word has Korean", () => {
    expect(Object.keys(SLOT_WORDS).toSorted()).toEqual(
      [...NOTEBOOK_SLOTS].toSorted(),
    );
    const missing = Object.values(SLOT_WORDS)
      .flatMap((words) => [words.name, words.example, words.write])
      .filter((sentence) => !(sentence in ko));
    expect(missing).toEqual([]);
  });
});
