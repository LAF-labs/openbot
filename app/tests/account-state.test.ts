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
  /*
   * That this TAB already started the sign-in `/sign?via=` named (`viaToStart`, 2026-09-15).
   *
   * A DECISION, and the argument is that it is not a person's state at all: it is the loop guard on
   * a press the screen makes by itself, and it has to outlive exactly one thing — a refused start
   * coming back to the same screen — which is what `sessionStorage` lasts. Another tab, another
   * device or the next launch starting once more is the promise ("once per tab", self-serve contract
   * §4.6), not drift, and nothing a Bot does reads it.
   */
  "routes/sign.tsx",
  /*
   * That this viewer dismissed the 80% line above the composer today (`lib/usage/today.ts`).
   *
   * A DECISION, and the argument is that it decides nothing but whether one reminder is drawn a
   * second time. The count itself is the server's, the same on every device; what a device keeps
   * is only "I have seen this today" — a person reading the line on the desktop app and again on
   * their phone is told twice, which is the harmless direction. A Bot's work never reads it.
   */
  "lib/usage/today.ts",
  /*
   * How wide the Bot's screen pane is on THIS screen, and whether it is folded away
   * (`lib/computer/screen-panel.ts`).
   *
   * A DECISION, and the argument is that the answer is about the window rather than about the
   * person. 440px is a choice on a 27-inch monitor and covers a phone entirely, so a preference
   * synced across devices would arrive on the small one as the wrong answer — and the module
   * already refuses to honour a width the window cannot take, which is the same reasoning one step
   * further on. Nothing a Bot does reads it, the pane draws at its old default when the value
   * cannot be read, and the worst it can be wrong about is how much room a picture has in front of
   * somebody who is looking at it and can press the other button.
   */
  "lib/computer/screen-panel.ts",
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
