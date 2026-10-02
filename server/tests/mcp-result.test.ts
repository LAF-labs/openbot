import { describe, expect, test } from "bun:test";
import {
  MAX_RESULT_CHARS,
  resultText,
  shapeResult,
  trimDetail,
  VENDOR_DETAIL_CHARS,
} from "../src/plugins/mcp";
import { TOOL_RESULT_CUT } from "../../shared/spillover";

/**
 * What a vendor's answer looks like by the time a model reads it.
 *
 * Separated from the protocol so it can be asserted without a server to talk to. The case worth
 * having tests for is the empty one: an empty string reads as "the tool had nothing to say" rather
 * than "there is nothing there", and the model fills the gap from memory. So nothing is said in
 * words — and so a vendor that DID answer must never be read as nothing.
 *
 * That second half is why this file exists (2026-10-02). `resultText` had no test of its own, and
 * three shapes of a real answer were being read as nothing or as a label: `structuredContent`, an
 * embedded resource's text, and a `resource_link`. Upstream OpenBot had met and fixed all three
 * since this fork left it (#619, #638); these are its cases, with this fork's own about the
 * credential and about a structure with nothing in it.
 */

const NOTHING = resultText([]).text;

describe("a result with nothing in it", () => {
  test("says so, rather than being an empty string", () => {
    expect(NOTHING).not.toBe("");
    expect(NOTHING.toLowerCase()).toContain("no content");
    // The clause that matters: it tells the model there is nothing here to answer from.
    expect(NOTHING.toLowerCase()).toContain("nothing");
    expect(resultText([]).truncated).toBe(false);
  });

  test("whitespace, a missing content field and a part that is not an object are the same nothing", () => {
    expect(resultText([{ type: "text", text: "   \n  " }]).text).toBe(NOTHING);
    expect(resultText(undefined).text).toBe(NOTHING);
    expect(resultText("not an array").text).toBe(NOTHING);
  });

  test("a structure with nothing in it is still nothing", () => {
    // `{}` and `[]` are a server's way of saying it found nothing; "{}" in front of a model is
    // the empty string again, with braces.
    for (const empty of [null, undefined, {}, [], "text", 0]) {
      expect(resultText([], undefined, empty).text).toBe(NOTHING);
    }
  });
});

describe("an answer cut at its length", () => {
  /*
   * Cut with `slice`, a result whose 20,000th unit was the first half of an emoji ended on that
   * half. The Bots' model answers a request holding one with a 400 and Postgres will not store it
   * (`shared/sound-text.ts`, measured 2026-10-02). Upstream OpenBot #525, where the concern was a
   * broken character; here it was the turn.
   */
  test("is cut between characters, not through an emoji", () => {
    // The emoji sits exactly where the text is cut to leave room for the note.
    const note = (total: number) =>
      `\n\n[truncated: the tool returned ${total} characters]`;
    const total = MAX_RESULT_CHARS * 2;
    const room = MAX_RESULT_CHARS - note(total).length;
    const { text, truncated } = shapeResult(
      `${"a".repeat(room - 1)}😀${"b".repeat(total - room - 1)}`,
    );
    expect(truncated).toBe(true);
    expect(text.isWellFormed()).toBe(true);
    expect(text).toBe(`${"a".repeat(room - 1)}${note(total)}`);
  });

  test("keeps an emoji that fits before the cut, and says how long the whole was", () => {
    const note = (total: number) =>
      `\n\n[truncated: the tool returned ${total} characters]`;
    const total = MAX_RESULT_CHARS * 2;
    const room = MAX_RESULT_CHARS - note(total).length;
    const whole = `${"a".repeat(room - 2)}😀${"b".repeat(total - room)}`;
    const { text } = shapeResult(whole);
    expect(text).toBe(`${"a".repeat(room - 2)}😀${note(whole.length)}`);
  });

  test("fits under the bound WITH its note, so the note is what the Bot reads", () => {
    /*
     * A result over 20,000 characters is filed on the Bot's computer and shown by its first 20,000
     * (`shared/spillover.ts`). A cut result used to be 20,000 characters and then the note, so it
     * was over: what the Bot is shown is then exactly the cut text and a line saying the whole is
     * on file, and reading on from there gets the note and nothing else. Seen 2026-10-02 while
     * porting upstream's Drive fix.
     */
    const { text } = shapeResult("가".repeat(MAX_RESULT_CHARS * 3));
    expect(text.length).toBeLessThanOrEqual(TOOL_RESULT_CUT);
    expect(text.endsWith(`characters]`)).toBe(true);
    expect(text).toContain(
      `[truncated: the tool returned ${MAX_RESULT_CHARS * 3} characters]`,
    );
  });

  test("a vendor's sentence quoted into the trail is cut the same way", () => {
    const detail = trimDetail(`${"가".repeat(VENDOR_DETAIL_CHARS - 1)}😀 뒤`);
    expect(detail).toBe(`${"가".repeat(VENDOR_DETAIL_CHARS - 1)}…`);
    expect(detail.isWellFormed()).toBe(true);
  });

  test("and a link's long name", () => {
    const { text } = resultText([
      {
        type: "resource_link",
        uri: "file:///a.md",
        name: `${"n".repeat(399)}😀 tail`,
      },
    ]);
    expect(text).toBe(`uri: file:///a.md\nname: ${"n".repeat(399)}…`);
    expect(text.isWellFormed()).toBe(true);
  });
});

describe("an answer that arrived as structuredContent", () => {
  test("is read when the content list was empty", () => {
    // A tool that declares an output schema may put the answer only here. An empty content list
    // was reported as nothing found, so the model filled the gap from memory while the vendor had
    // answered.
    const { text, truncated } = resultText([], undefined, {
      title: "9월 정산서",
      rows: [{ item: "수수료", amount: 12000 }],
    });
    expect(truncated).toBe(false);
    expect(JSON.parse(text)).toEqual({
      title: "9월 정산서",
      rows: [{ item: "수수료", amount: 12000 }],
    });
    expect(text.toLowerCase()).not.toContain("no content");
  });

  test("is read when the content field is missing altogether", () => {
    expect(resultText(undefined, undefined, { count: 3 }).text).toBe(
      '{"count":3}',
    );
  });

  test("does not replace a text part: that is the representation the server chose to show", () => {
    const { text } = resultText(
      [{ type: "text", text: "the prose the server chose" }],
      undefined,
      { title: "ignored" },
    );
    expect(text).toBe("the prose the server chose");
  });

  test("has the call's own credential cut out of it, like any other text", () => {
    const token = "ya29.a0-test-credential-0123456789";
    const { text } = resultText([], token, {
      echoed: `Bearer ${token}`,
      next: `https://api.example.com/items?access_token=${token}`,
    });
    expect(text).not.toContain(token);
    expect(text).toContain("api.example.com");
  });

  test("is cut where the model can see, when it is enormous", () => {
    const { text, truncated } = resultText([], undefined, {
      rows: Array.from({ length: 4_000 }, (_, index) => `row ${index}`),
    });
    expect(truncated).toBe(true);
    expect(text).toContain("[truncated: the tool returned");
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });
});

describe("an answer with a file in it", () => {
  test("an embedded resource's text is read, not named", () => {
    expect(
      resultText([
        {
          type: "resource",
          resource: {
            uri: "notion://page/q3",
            mimeType: "text/markdown",
            text: "# 3분기 예산\n승인된 수치",
          },
        },
      ]).text,
    ).toBe("# 3분기 예산\n승인된 수치");
  });

  test("an embedded resource with no text — a blob — is named, rather than dropped", () => {
    expect(
      resultText([
        { type: "resource", resource: { uri: "file:///a.png", blob: "AAAA" } },
      ]).text,
    ).toBe("[resource]");
    expect(resultText([{ type: "image", data: "AAAA" }]).text).toBe("[image]");
    expect(resultText([{}]).text).toBe("[unknown]");
  });
});

describe("an answer that points at pages", () => {
  test("a resource_link is its address first, then what it is called", () => {
    // A pointer, not the file. Named as "[resource_link]", the model was told a link arrived and
    // never shown where it went: a search that answered with pages produced no page it could open.
    expect(
      resultText([
        {
          type: "resource_link",
          uri: "notion://page/q3-budget",
          name: "Q3 budget",
          description: "The approved numbers for the quarter",
          mimeType: "text/html",
        },
      ]).text,
    ).toBe(
      "uri: notion://page/q3-budget\nname: Q3 budget\ndescription: The approved numbers for the quarter",
    );
  });

  test("the title meant for people is shown over the name meant for programs", () => {
    expect(
      resultText([
        {
          type: "resource_link",
          uri: "notion://page/q3-budget",
          name: "q3_budget",
          title: "3분기 예산",
        },
      ]).text,
    ).toBe("uri: notion://page/q3-budget\ntitle: 3분기 예산");
  });

  test("a long name cannot push the address past the cap", () => {
    // Truncation may lose what a resource was called, never where it is.
    const { text, truncated } = resultText([
      {
        type: "resource_link",
        name: "x".repeat(MAX_RESULT_CHARS),
        uri: "https://example.com/source",
      },
    ]);
    expect(text.startsWith("uri: https://example.com/source\n")).toBe(true);
    expect(truncated).toBe(false);
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
  });

  test("a long description is cut, and the cut is marked", () => {
    const { text } = resultText([
      {
        type: "resource_link",
        uri: "file:///a.md",
        description: "d".repeat(1_000),
      },
    ]);
    expect(text).toBe(`uri: file:///a.md\ndescription: ${"d".repeat(400)}…`);
  });

  test("a link that names nothing is still named, rather than dropped", () => {
    expect(resultText([{ type: "resource_link" }]).text).toBe(
      "[resource_link]",
    );
    expect(
      resultText([{ type: "resource_link", uri: "   ", name: "" }]).text,
    ).toBe("[resource_link]");
  });

  test("links sit beside the text that introduces them", () => {
    expect(
      resultText([
        { type: "text", text: "matching pages:" },
        {
          type: "resource_link",
          uri: "https://example.com/policy",
          name: "Expense policy",
        },
        { type: "resource_link", uri: "https://example.com/faq" },
      ]).text,
    ).toBe(
      "matching pages:\nuri: https://example.com/policy\nname: Expense policy\nuri: https://example.com/faq",
    );
  });
});
