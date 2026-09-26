import { describe, expect, test } from "bun:test";
import { BOT_NAME_WORDS, nextBotName } from "../src/lib/agents/bot-names";
import { ko } from "../src/lib/i18n-ko";

/**
 * The name a new Bot is given before anybody decides one, read through `t(word)` — a variable call,
 * which `i18n-coverage.test.ts` cannot see. `bot-names.ts` said this file walked the table; it did
 * not exist, so a word added without Korean would have named somebody's Bot "Lantern" in a Korean
 * product with nothing failing anywhere.
 */
describe("the names a new Bot can be given", () => {
  test("every word has Korean", () => {
    const missing = BOT_NAME_WORDS.filter((word) => !ko[word]?.trim());
    expect(missing).toEqual([]);
  });

  test("no two words are the same name in Korean", () => {
    const names = BOT_NAME_WORDS.map((word) => ko[word]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a name already on the roster is not handed out again while another is free", () => {
    const [first, ...rest] = BOT_NAME_WORDS;
    expect(nextBotName(rest, () => 0)).toBe(first as string);
  });
});
