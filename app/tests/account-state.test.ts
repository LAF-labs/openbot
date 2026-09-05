import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A CONVERSATION BELONGS TO THE ACCOUNT, NOT TO THE MACHINE IT WAS OPENED ON.
 *
 * `bot-thread.ts` kept the per-Bot chat thread in `localStorage`, so the installed app and a
 * browser signed into the same account held two different conversations with one Bot: the roster
 * said the Bot had spoken, opening it showed an empty transcript, and nothing on screen explained
 * why. That module is gone — the thread a chat runs in comes from the channel the server minted
 * (`intelligence_channel_mappings`, keyed on the person and the channel), so every device that can
 * see the roster sees the same conversation.
 *
 * This is the guard that keeps it that way, because the failure is invisible from one machine:
 * everything works, and works separately. Two things are allowed to be per-device, on purpose —
 * which language this browser renders in and whether it is dark — and both reload the page rather
 * than syncing, so neither can drift into being state a Bot's work depends on.
 */

const SOURCE = join(import.meta.dir, "../src");

/** Where a per-device answer is the right answer. Adding to this list is a decision, not a fix. */
const DEVICE_SCOPED = [
  "components/theme-provider.tsx",
  "lib/i18n.ts",
  /*
   * Which Bot's browser the 사이트 section starts on.
   *
   * A DECISION, and the argument is that it decides nothing. It is where a picker's cursor sits
   * when the screen opens; the picker is on screen saying which Bot it landed on, and every
   * connected row names the Bot whose browser actually holds that session — read from the server,
   * not from here. So the worst this can be wrong about is one dropdown, in front of somebody who
   * is looking at it, and the alternative is re-picking the same Bot every single visit.
   */
  "components/connections/site-rows.tsx",
];

/**
 * A comment is not a call.
 *
 * `/admin/playground` has to explain why a component that reaches for browser storage dies in the
 * preview — the sandbox has no same-origin access, so reading the property throws rather than
 * returning null — and naming the two APIs in that explanation made this test report the file as
 * one that stores per-device state. It stores nothing. The rule then punishes exactly the person
 * documenting the trap, which is the same argument `design-tokens.test.ts` makes for the same
 * treatment; both strip comments before they count anything.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("state that belongs to the account", () => {
  test("only the theme and the language are kept per device", () => {
    const storing = sourceFiles(SOURCE)
      .filter((path) =>
        /\b(?:local|session)Storage\b/.test(
          withoutComments(readFileSync(path, "utf8")),
        ),
      )
      .map((path) => path.replace(`${SOURCE}/`, ""))
      .sort();

    expect(storing).toEqual([...DEVICE_SCOPED].sort());
  });

  test("nothing mints a conversation of its own any more", () => {
    // The chat is handed `channel.threadId`. A component minting one would be a conversation the
    // server has no row for, reachable from exactly one browser and from nothing else.
    const minting = sourceFiles(SOURCE)
      .filter((path) =>
        readFileSync(path, "utf8").includes("/api/threads/mint"),
      )
      .map((path) => path.replace(`${SOURCE}/`, ""));

    expect(minting).toEqual([]);
  });
});
