/**
 * HOW A VALUE THAT MUST NOT BE SHOWN IS LOOKED FOR IN TEXT, AND WHAT STANDS WHERE IT WAS.
 *
 * One rule, read by two: the Bot's computer, which takes a value it put into a page out of every
 * answer for the rest of that run (`agent-computer/src/filled-values.ts`), and the server, which
 * takes a person's saved passwords out of what a model is handed in any run
 * (`server/src/logins/shown.ts`). Two rules would be two answers to "was that hidden?" for the same
 * text — and a mark the model has been told the meaning of in one place and not the other.
 *
 * Nothing here knows where a value came from, and nothing here keeps one.
 */

/**
 * What stands where a value was. Not empty: "비밀번호: 입니다" reads as a page that said nothing, and
 * the Bot would report it so. Not a word either — a word is something a model types back.
 */
export const HIDDEN = "[•••]";

/**
 * How long a value has to be before it is looked for inside text.
 *
 * CHOSEN BY WHAT IT COSTS, which `agent-computer/tests/filled-values.test.ts` writes down. A value is found
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
  const words = value
    .replace(/[\u200b\u00ad]/g, "")
    .split(/\s+/)
    .filter(Boolean);
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
 * A string that is one web address, in four parts: the scheme, a name and password written before
 * the host, the host with its port, and everything after.
 */
const WHOLE_ADDRESS = /^(https?:\/\/)([^/?#\s]*@)?([^/?#\s@]*)(\S*)$/i;

/**
 * Text with every one of these values taken out of it, or null when none of them can be looked
 * for — too short, each of them, to hunt through a sentence.
 *
 * The longest first: of `hunter2` and `hunter2!!`, the shorter would leave the other's tail.
 *
 * NOT THE SITE OF AN ADDRESS. A blog whose address begins with its owner's sign-in name
 * (`gibeom.tistory.com`) would be answered as `https://[•••].tistory.com/…`, which is no address:
 * the server judges every act by the host it is on (`server/src/computer/gateway/addresses.ts`),
 * and a host it cannot read is a site no rule allows — the Bot shut out of the very site it was
 * just signed in to. A site's name is public in a way a password never is, and no page puts a
 * password there. What comes after it is looked in — the path, the query, the fragment — and so is
 * a name and password written before the host. Only a string that is the address and nothing
 * else: an address in a sentence is the page's words.
 */
export function blankerOf(
  values: readonly string[],
): ((text: string) => string) | null {
  const patterns = [...new Set(values)]
    .sort((one, other) => other.length - one.length)
    .flatMap((value) => {
      const pattern = patternOf(value);
      return pattern ? [pattern] : [];
    });
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
 * base64 is found there by chance, and the picture it was found in no longer decodes. One list,
 * for the same reason the rule is one: whoever walks an answer skips the same fields.
 */
export const BYTES_AS_TEXT: ReadonlySet<string> = new Set(["base64"]);
