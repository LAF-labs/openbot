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
import type { NoteCode } from "./codes";
import { rewritten } from "./respond";
import type { BotSession } from "./sessions";
import { digestOf } from "./typed-values";

/**
 * What stands where a value was. Not empty: "비밀번호: 입니다" reads as a page that said nothing, and
 * the Bot would report it so. Not a word either — a word is something a model types back.
 */
export const HIDDEN = "[•••]";

/** Said on the answer something was hidden in, so the mark is not taken for the page's own. */
const VALUE_HIDDEN: NoteCode = "laf:value_hidden";

/**
 * How long a value has to be before it is looked for inside text.
 *
 * CHOSEN BY WHAT IT COSTS, which `tests/filled-values.test.ts` writes down. A value is found
 * wherever its letters stand, so a short one takes ordinary words apart: three letters (`kim`) would
 * blank the head of `kimchi` and of every address at `kimsclub`. Four (`love`) still blanks the head
 * of `lovely` — but four is where a sign-in name starts, and a name shown back is the commonest echo
 * there is. Under four, a value is still kept out of its box and out of addresses, as it was; it is
 * only not hunted through sentences.
 */
const SHORTEST_HUNTED = 4;

/**
 * A value that is only digits is looked for as a number, not as letters — and from two digits,
 * because as a number it costs almost nothing: `1234` is hidden where a page says `PIN: 1234`, and
 * left alone inside `12,340원`, `2026-1234-5678` and `010-1234-5678`. Looked for as letters, a card's
 * two-digit password took every price on a checkout apart.
 */
const SHORTEST_NUMBER = 2;

/**
 * From this many digits a number is also looked for with its groups apart — a card number shown as
 * `1234-5678-9012-3456`, a phone number as `010 1234 5678` — and anywhere it is not part of a longer
 * run of digits. Shorter than this, a number with a gap in it is two numbers.
 */
const GROUPED_NUMBER = 8;

/** How many values a session holds. A card is six boxes; a run that fills ten cards is no run. */
const FILLED_LIMIT = 64;

type Held = {
  /** Each value as it was put in, with how it is looked for — or null for one too short to hunt. */
  values: Map<string, RegExp | null>;
  /** The tabs a value went into. Closed when the run ends. */
  tabs: Set<Page>;
};

const held = new WeakMap<BotSession, Held>();

function escaped(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * How a value is looked for in text, or null when it is too short to be.
 *
 * As a page would show it back, which is not always as it was typed: letters in either case (a
 * heading styled in capitals reads back in capitals), any run of white space where the value has
 * one, and a long number with or without its groups apart.
 */
export function patternOf(value: string): RegExp | null {
  const words = value.replace(/[​­]/g, "").split(/\s+/).filter(Boolean);
  const written = words.join(" ");
  const digits = written.replace(/[ -]/g, "");
  const isNumber =
    /^\d+$/.test(digits) &&
    (digits === written || digits.length >= GROUPED_NUMBER);
  if (isNumber) {
    if (digits.length < SHORTEST_NUMBER) return null;
    if (digits.length >= GROUPED_NUMBER) {
      return new RegExp(`(?<!\\d)${[...digits].join("[ -]?")}(?!\\d)`, "g");
    }
    // The whole of a number, never a part of one: not inside a word or a ref (`e12`), and not one
    // group of a number written in groups — a date, a price, a phone number, an order's.
    return new RegExp(
      `(?<![0-9A-Za-z])(?<!\\d[-./,:])${digits}(?![0-9A-Za-z])(?![-./,:]\\d)`,
      "g",
    );
  }
  if ([...written].length < SHORTEST_HUNTED) return null;
  return new RegExp(words.map(escaped).join("\\s+"), "giu");
}

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
  const kept = held.get(session) ?? { values: new Map(), tabs: new Set() };
  held.set(session, kept);
  kept.tabs.add(tab);
  kept.values.delete(value);
  kept.values.set(value, patternOf(value));
  // The oldest goes first. Sixty-four values in one run is ten sign-ins and their codes, and the
  // first of those codes stopped being worth anything an hour ago.
  for (const oldest of kept.values.keys()) {
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
 * A string that is one web address, in four parts: the scheme, a name and password written before
 * the host, the host with its port, and everything after.
 */
const WHOLE_ADDRESS = /^(https?:\/\/)([^/?#\s]*@)?([^/?#\s@]*)(\S*)$/i;

/**
 * Text with every held value taken out of it, or null when nothing is held that can be looked for —
 * the answer for nearly every call, and the one that costs nothing.
 *
 * NOT A VALUE THE BOT ITSELF TYPED, as with addresses (`typed-values.ts`, `ownDigests`): hiding
 * what the Bot wrote into a search box would tell it that its guess was what a person typed, on a
 * page that shows nothing back at all.
 *
 * AND NOT THE SITE OF AN ADDRESS. A blog whose address begins with its owner's sign-in name
 * (`gibeom.tistory.com`) would be answered as `https://[•••].tistory.com/…`, which is no address:
 * the server judges every act by the host it is on (`server/src/computer/gateway/addresses.ts`),
 * and a host it cannot read is a site no rule allows — the Bot shut out of the very site it was
 * just signed in to. A site's name is public in a way a password never is, and no page puts a
 * password there. What comes after it is looked in — the path, the query, the fragment — and so is
 * a name and password written before the host. Only a string that is the address and nothing
 * else: an address in a sentence is the page's words.
 */
export function filledBlanker(
  session: BotSession,
): ((text: string) => string) | null {
  const kept = held.get(session);
  if (!kept) return null;
  const own = new Set(session.ownDigests);
  const patterns = [...kept.values]
    .filter(([value]) => {
      const digest = digestOf(value);
      return !(digest && own.has(digest));
    })
    // The longest first: of `hunter2` and `hunter2!!`, the shorter would leave the other's tail.
    .sort(([one], [other]) => other.length - one.length)
    .flatMap(([, pattern]) => (pattern ? [pattern] : []));
  if (patterns.length === 0) return null;
  const blank = (text: string) =>
    patterns.reduce((left, pattern) => left.replace(pattern, HIDDEN), text);
  return (text) => {
    const address = WHOLE_ADDRESS.exec(text);
    if (!address) return blank(text);
    const [, scheme = "", before = "", site = "", after = ""] = address;
    return `${scheme}${blank(before)}${site}${blank(after)}`;
  };
}

/**
 * The fields of an answer that are bytes written as text. A value looked for in a megabyte of
 * base64 is found there by chance, and the picture it was found in no longer decodes.
 */
const BYTES_AS_TEXT = new Set(["base64"]);

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
