import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTER_CODES,
  type ComputerCode,
  isAnswerCode,
  statusOf,
} from "../src/codes";

/**
 * THE LIST IS THE WHOLE OF WHAT THIS CONTAINER CAN SAY.
 *
 * `codes.ts` is what every reader on the other side of the wire is held to — the server's client, the
 * model's words, the person's — so a code this process sends and the list does not name is a code
 * nobody is checked against, and a code the list names and nothing sends is a hole a new code of the
 * same name could slip through unexamined. `fact` only takes a listed answer, so TypeScript covers the
 * HTTP answers; the notes, the socket and a code thrown as a message are what this walk is for.
 */

const SRC = join(import.meta.dir, "../src");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every `laf:` string literal outside the list itself, with the file it is in. Comments are left out:
 * a code named in a sentence about it is not a code being sent.
 */
function sent(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sources(SRC)) {
    if (path.endsWith("/codes.ts")) continue;
    const code = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const match of code.matchAll(/"(laf:[a-z0-9_-]+)"/g)) {
      found.set(match[1] as string, path.slice(SRC.length + 1));
    }
  }
  return found;
}

describe("the container's code list", () => {
  test("names every code this process sends", () => {
    const literals = sent();
    // The walk reached the files: a green run over nothing would prove nothing.
    expect(literals.size).toBeGreaterThan(20);
    const unlisted = [...literals]
      .filter(([code]) => !Object.hasOwn(COMPUTER_CODES, code))
      .map(([code, file]) => `${file}: ${code}`);
    expect(unlisted).toEqual([]);
  });

  test("names nothing this process no longer sends", () => {
    const literals = sent();
    const unsent = Object.keys(COMPUTER_CODES).filter(
      (code) => !literals.has(code),
    );
    expect(unsent).toEqual([]);
  });

  test("gives every answer one status, and every other code a channel", () => {
    for (const [code, spec] of Object.entries(COMPUTER_CODES)) {
      const answer = isAnswerCode(code);
      expect({ code, answer, status: "status" in spec }).toEqual({
        code,
        answer: "status" in spec,
        status: "status" in spec,
      });
      if (answer) {
        expect(statusOf(code)).toBeGreaterThanOrEqual(400);
      } else {
        expect({ code, told: "note" in spec || "screen" in spec }).toEqual({
          code,
          told: true,
        });
      }
    }
  });

  test("tells a message that is a code from one that only looks like one", () => {
    expect(isAnswerCode("laf:browser_failed")).toBe(true);
    // Listed, and not an answer: a note never leaves as a failure's status.
    expect(isAnswerCode("laf:dialog" satisfies ComputerCode)).toBe(false);
    expect(isAnswerCode("laf:made_up")).toBe(false);
    expect(isAnswerCode("toString")).toBe(false);
    expect(isAnswerCode(undefined)).toBe(false);
  });
});
