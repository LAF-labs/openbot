import { describe, expect, test } from "bun:test";
import { computerTool } from "../../shared/tools/computer";
import { createRepeatDetector } from "../src/computer/repeat";
import { readFileInputOf } from "../src/computer/schema";

/**
 * Reading a filed result past its cut: `computer_read_file` with `offset` and `limit`.
 *
 * Since harness phase 2 a result over 20,000 characters is cut once, where it is first seen, and the
 * whole is filed in `.results/`. A read of that file was cut at the same place again, so nothing past
 * the head was reachable (2026-09-25). The range is the way on; these are the doors it goes through.
 */

describe("the arguments a read takes", () => {
  test("a path alone is the read it always was", () => {
    expect(readFileInputOf({ path: " notes.md " })).toEqual({
      path: "notes.md",
    });
  });

  test("a part, in characters, passes as given", () => {
    expect(
      readFileInputOf({ path: ".results/c1.txt", offset: 20_000, limit: 500 }),
    ).toEqual({ path: ".results/c1.txt", offset: 20_000, limit: 500 });
    expect(readFileInputOf({ path: "a.txt", offset: 0 })).toEqual({
      path: "a.txt",
      offset: 0,
    });
  });

  test("a part that is not a whole count is refused, not read somewhere else", () => {
    for (const args of [
      { path: "a.txt", offset: -1 },
      { path: "a.txt", offset: 1.5 },
      { path: "a.txt", offset: "20000" },
      { path: "a.txt", limit: 0 },
      { path: "a.txt", limit: Number.NaN },
      { offset: 10 },
      { path: "  " },
    ]) {
      expect(readFileInputOf(args)).toBeNull();
    }
  });
});

describe("reading on is not going round in circles", () => {
  test("each part of one file is its own call to the repeat count; the same part twice is not", async () => {
    let time = 1_000_000;
    const detector = createRepeatDetector({ now: () => time });
    const read = (part?: string) =>
      detector.observe("bot-1", {
        tool: "computer_read_file",
        filePath: ".results/c1.txt",
        ...(part ? { part } : {}),
      });
    for (const part of ["0+", "15000+", "30000+", "45000+", "60000+"]) {
      expect((await read(part)).count).toBe(1);
    }
    expect((await read("15000+")).count).toBe(2);
    time += 1;
    // A read with no part is the whole-file read it always was, counted as before.
    expect((await read()).count).toBe(1);
    expect((await read()).count).toBe(2);
  });
});

describe("the schema a model is handed", () => {
  const tool = computerTool("computer_read_file");

  test("two optional numbers beside the path, nothing required but the path", () => {
    const properties = tool?.parameters.properties as Record<
      string,
      { type: string }
    >;
    expect(Object.keys(properties)).toEqual(["path", "offset", "limit"]);
    expect(properties.offset?.type).toBe("number");
    expect(properties.limit?.type).toBe("number");
    expect(tool?.parameters.required).toEqual(["path"]);
  });

  /*
   * Every tool rides in front of every message (CLAUDE.md, "The footprint ladder"). The range added
   * 161 characters to this one (298 → 459); the ceiling is where a later edit has to say why.
   */
  test("stays small", () => {
    expect(JSON.stringify(tool).length).toBeLessThanOrEqual(480);
  });
});
