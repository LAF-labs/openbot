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
        /\b(?:local|session)Storage\b/.test(readFileSync(path, "utf8")),
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
