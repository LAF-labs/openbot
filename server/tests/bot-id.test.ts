import { describe, expect, test } from "bun:test";
import { isBotId } from "../src/computer/bot-id";

describe("isBotId", () => {
  test("the ids this deployment mints and the ones the package shipped", () => {
    for (const id of [
      "agent_69b117e0-327d-4fc9-a439-ac891e9cdb06",
      "general-assistant",
      "shared",
      "a",
    ]) {
      expect(isBotId(id)).toBe(true);
    }
  });

  test("anything a path or a header could read as structure", () => {
    // A header value with a line break folded in: a raw CR LF, built rather than typed.
    const withLineBreak = `bot${String.fromCharCode(13, 10)}x-injected: 1`;
    for (const id of [
      "../..",
      "../../etc",
      "..",
      ".",
      "agent/x",
      "agent\\x",
      "a b",
      "-leading-dash",
      "",
      "x".repeat(129),
      withLineBreak,
      "bot ",
      undefined,
      42,
    ]) {
      expect(isBotId(id)).toBe(false);
    }
  });
});
