/**
 * WHAT WAS PUT INTO A PAGE FOR A PERSON, HELD FOR AS LONG AS THE RUN THAT PUT IT THERE LASTS — so
 * that a page which writes it somewhere else does not hand it to the Bot.
 *
 * A look keeps a box's value out by asking the box (`secret-fields.ts`), and an address is blanked
 * by a digest of what was typed (`typed-values.ts`). Neither reaches a page that copies the value
 * into its own text: a confirmation screen that shows the sign-in name back, a script that writes
 * the password into the body. `computer_read` answers the body as it stands, and from there the
 * value is a tool result in a conversation's history (`docs/laf/redesign-2026-10.md` §6).
 *
 * THE VALUE ITSELF IS HELD HERE, WHICH NOTHING ELSE IN THIS PROCESS DOES. A digest answers "is this
 * whole string what was typed?" — a box's value, one `a=b` of an address — and cannot find a value
 * in the middle of a sentence. So the value is kept, in this module and not on the session, where
 * nothing that writes a session down or logs one can reach it; it is in no answer, no log line and
 * no file. What that adds is time, not reach: this process already holds the browser whose box
 * holds the value, and reads that box at every look.
 *
 * FOR THE RUN, NOT FOR THE PAGE. A sign-in leaves for the next page as it is sent, and the screen
 * that shows a value back is that next page — letting go when the page went would let go exactly
 * there. It is held across every tab until the server says the run has ended (`runEnded`), and the
 * tabs a value went into are closed then: a tab outlives a run by ten minutes (`tabs.ts`), and a
 * later run that came back to it would find the page still holding what this had stopped hiding.
 * A server that never says so leaves all of it standing — held, hidden and unpictured — which is
 * the side to be wrong on.
 *
 * No Playwright in here beyond a tab's type, so the rules can be tested without a browser.
 */
import type { Page } from "playwright";
import {
  BYTES_AS_TEXT,
  blankerOf,
  HIDDEN,
  patternOf,
} from "../../shared/hidden-values";
import type { NoteCode } from "./codes";
import { rewritten } from "./respond";
import type { BotSession } from "./sessions";
import { digestOf } from "./typed-values";

/** Said on the answer something was hidden in, so the mark is not taken for the page's own. */
const VALUE_HIDDEN: NoteCode = "laf:value_hidden";

/** How many values a session holds. A card is six boxes; a run that fills ten cards is no run. */
const FILLED_LIMIT = 64;

type Held = {
  /** Each value as it was put in, the oldest first. */
  values: Set<string>;
  /** The tabs a value went into. Closed when the run ends. */
  tabs: Set<Page>;
};

const held = new WeakMap<BotSession, Held>();

/**
 * Hold a value that is about to go into a page, and the tab it is going into.
 *
 * BEFORE IT GOES IN, by whoever puts it there: a fill that fails half-way may have landed, and a
 * value held that never arrived costs nothing.
 */
export function rememberFilled(
  session: BotSession,
  tab: Page,
  value: string,
): void {
  const kept = held.get(session) ?? { values: new Set(), tabs: new Set() };
  held.set(session, kept);
  kept.tabs.add(tab);
  kept.values.delete(value);
  kept.values.add(value);
  // The oldest goes first. Sixty-four values in one run is ten sign-ins and their codes, and the
  // first of those codes stopped being worth anything an hour ago.
  for (const oldest of kept.values) {
    if (kept.values.size <= FILLED_LIMIT) break;
    kept.values.delete(oldest);
  }
}

/** Whether a value was put into this Bot's browser in a run that has not been said to have ended. */
export function holdsFilled(session: BotSession): boolean {
  return held.has(session);
}

/** The tabs a value went into, to be closed when the run ends. */
export function filledTabs(session: BotSession): Page[] {
  return [...(held.get(session)?.tabs ?? [])];
}

/** Let go of every value and every tab: the run is over and its tabs are closed, or the browser is. */
export function forgetFilled(session: BotSession): void {
  held.delete(session);
}

/**
 * Text with every held value taken out of it, or null when nothing is held that can be looked for —
 * the answer for nearly every call, and the one that costs nothing. How a value is looked for, and
 * what of an address is left standing, is the one rule the server reads too
 * (`shared/hidden-values.ts`).
 *
 * NOT A VALUE THE BOT ITSELF TYPED, as with addresses (`typed-values.ts`, `ownDigests`): hiding
 * what the Bot wrote into a search box would tell it that its guess was what a person typed, on a
 * page that shows nothing back at all.
 */
export function filledBlanker(
  session: BotSession,
): ((text: string) => string) | null {
  const kept = held.get(session);
  if (!kept) return null;
  const own = new Set(session.ownDigests);
  return blankerOf(
    [...kept.values].filter((value) => {
      const digest = digestOf(value);
      return !(digest && own.has(digest));
    }),
  );
}

function withoutFilledIn(
  value: unknown,
  blank: (text: string) => string,
  found: { any: boolean },
): unknown {
  if (typeof value === "string") {
    const left = blank(value);
    if (left !== value) found.any = true;
    return left;
  }
  if (Array.isArray(value)) {
    return value.map((each) => withoutFilledIn(each, blank, found));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [
        key,
        BYTES_AS_TEXT.has(key) ? each : withoutFilledIn(each, blank, found),
      ]),
    );
  }
  return value;
}

/**
 * An answer, with every held value taken out of every string in it — before it leaves this process.
 *
 * AT THE DOOR, NOT AT EACH PLACE A PAGE'S WORDS LEAVE BY. They leave in a look's names and values,
 * a read's text and its frames', a tab's title, a dialog's message riding on a note, an action's
 * `url` — and in whatever is written next month. Every answer to a Bot's route passes here
 * (`routes.ts`), so this is where they are read; an answer from a session that holds nothing goes
 * out untouched and unread.
 *
 * EVERY STRING, WHICH TAKES THIS PROCESS'S OWN WORDS WITH IT WHEN A VALUE IS ONE OF THEM. A person
 * whose password is `textbox` gets a look with its roles hidden for the length of that run. That is
 * a run that goes badly and says why; a list of fields "known to be ours" is a list somebody adds a
 * page's words to one day.
 *
 * AND SAID. An answer something was hidden in carries the fact, so the mark is read as this
 * process's and not as what the page shows.
 */
export async function withoutFilledValues(
  session: BotSession,
  answer: Response,
): Promise<Response> {
  const blank = filledBlanker(session);
  if (!blank) return answer;
  return rewritten(answer, (body) => {
    const found = { any: false };
    const left = withoutFilledIn(body, blank, found);
    if (
      !found.any ||
      !left ||
      typeof left !== "object" ||
      Array.isArray(left)
    ) {
      return left;
    }
    const said = (left as { notes?: unknown }).notes;
    return {
      ...left,
      notes: [...(Array.isArray(said) ? said : []), { code: VALUE_HIDDEN }],
    };
  });
}

// The rule itself is shared with the server (`shared/hidden-values.ts`); said from here too, for
// whoever reads this module to know what the door does.
export { HIDDEN, patternOf };
