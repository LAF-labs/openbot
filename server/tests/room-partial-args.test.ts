import { describe, expect, test } from "bun:test";
import { textOfPartialArgs } from "../src/rooms/stream";

/**
 * The two facts about @ag-ui/client 0.0.57 that the room's typing indicator rests on.
 *
 * Both fail SILENTLY if a version bump changes them — the indicator would simply never appear —
 * so they are pinned here rather than trusted from a type.
 */
/*
 * Imported by path rather than by name: `untruncate-json` is @ag-ui/client's dependency, not ours,
 * and adding it to our package.json to write a test would be adding a dependency to assert a fact
 * about somebody else's. The path is what a version bump would break, which is the point.
 */
const { default: untruncateJson } = (await import(
  "../../node_modules/.bun/untruncate-json@0.0.1/node_modules/untruncate-json/dist/esm/index.js"
)) as { default: (json: string) => string };

describe("what `partialToolCallArgs` actually is", () => {
  test("untruncate-json returns a STRING, which is why the published type lies", () => {
    const partial = untruncateJson('{"text":"안녕하세요, 리스');
    expect(typeof partial).toBe("string");
    expect(partial).toBe('{"text":"안녕하세요, 리스"}');
  });

  test("so the live text is parsed out of it, never indexed off it", () => {
    expect(textOfPartialArgs(untruncateJson('{"text":"안녕하세요, 리스'))).toBe(
      "안녕하세요, 리스",
    );
    // What indexing it as the declared `Record<string, any>` would have produced.
    expect(
      (untruncateJson('{"text":"안녕"}') as unknown as { text?: string }).text,
    ).toBeUndefined();
  });

  test("a fragment too early to parse reports nothing rather than guessing", () => {
    expect(textOfPartialArgs('{"te')).toBeNull();
    expect(textOfPartialArgs(undefined)).toBeNull();
    expect(textOfPartialArgs({ text: "already an object" })).toBeNull();
  });

  test("a call whose argument is not a string is not speech", () => {
    expect(textOfPartialArgs('{"text":42}')).toBeNull();
    expect(textOfPartialArgs('{"other":"x"}')).toBeNull();
  });
});
