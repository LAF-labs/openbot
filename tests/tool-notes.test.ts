import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  noteTexts,
  TOOL_RESULT_KO,
  toolResultText,
} from "../shared/prompt/tool-results.ko";

/**
 * The facts the Bot's browser sends, and the Korean they turn into.
 *
 * `agent-computer` is a separate deployable that knows no locale, so it ships `{code, message}` and
 * nothing else — the same decision `laf:human_has_control` records. That only works while every code
 * it can emit has words on this side; a code with no entry reaches a model as the literal string
 * `laf:dialog`, which it has never seen and cannot act on. This walks the container's source and
 * says so.
 */

const root = join(import.meta.dir, "..");

/** Every `laf:` code the computer can put in front of a model, read out of its own source. */
function codesEmittedByTheComputer(): string[] {
  const directory = join(root, "agent-computer/src");
  const found = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(join(directory, name), "utf8");
    for (const match of source.matchAll(/"(laf:[a-z_]+)"/g)) {
      found.add(match[1] as string);
    }
  }
  return [...found].sort();
}

describe("the codes the computer ships", () => {
  test("every one of them has Korean here", () => {
    const missing = codesEmittedByTheComputer().filter(
      (code) => !TOOL_RESULT_KO[code],
    );
    expect(missing).toEqual([]);
  });

  test("the ones this wave added are among them", () => {
    // Named rather than counted: a regex that stopped matching would otherwise make this test pass
    // by finding nothing at all.
    const codes = codesEmittedByTheComputer();
    expect(codes).toContain("laf:dialog");
    expect(codes).toContain("laf:downloaded");
    expect(codes).toContain("laf:bot_header_missing");
    expect(codes).toContain("laf:secret_request_lost");
    expect(codes).toContain("laf:stale_refs");
  });

  /**
   * The English paragraphs are gone from the container.
   *
   * Two of them lived in `index.ts` and were addressed to a model: "That list of elements is out of
   * date…" and "Nothing on this page has the ref…". Both are `laf:stale_refs` now.
   */
  test("the browser no longer writes sentences for a model to read", () => {
    const source = readFileSync(
      join(root, "agent-computer/src/index.ts"),
      "utf8",
    );
    expect(source).not.toContain("Take a new snapshot and use the refs");
    expect(source).not.toContain("That list of elements is out of date");
  });
});

describe("putting a fact into words", () => {
  test("a dialog carries the page's own message with it", () => {
    const said = noteTexts([
      { code: "laf:dialog", kind: "alert", message: "로그인이 필요합니다" },
    ]);
    expect(said?.[0]).toContain(toolResultText("laf:dialog"));
    // The message is the whole point: without it the Bot knows a box appeared and not what it said.
    expect(said?.[0]).toContain("로그인이 필요합니다");
  });

  test("a download carries where it landed", () => {
    const said = noteTexts([
      { code: "laf:downloaded", path: "downloads/정산내역.csv", bytes: 42 },
    ]);
    expect(said?.[0]).toContain("downloads/정산내역.csv");
  });

  test("a code with nothing to add is just its sentence", () => {
    expect(noteTexts([{ code: "laf:secret_request_lost" }])).toEqual([
      toolResultText("laf:secret_request_lost"),
    ]);
  });

  test("nothing to say is undefined rather than an empty list", () => {
    expect(noteTexts(undefined)).toBe(undefined);
    expect(noteTexts([])).toBe(undefined);
    expect(noteTexts("not a list")).toBe(undefined);
  });

  test("something that is not a fact is dropped rather than passed on", () => {
    expect(noteTexts([{ message: "no code here" }, null, 7])).toBe(undefined);
  });
});
