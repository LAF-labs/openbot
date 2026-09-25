import { describe, expect, test } from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import { failureSentence, pressOnce } from "../src/lib/press";

/**
 * ONE PRESS: THE RE-CHECK, THE ACTION, AND A FAILURE AS A SENTENCE A PERSON CAN READ.
 *
 * Every dialog that sends something goes through `pressOnce` (`docs/laf/dialogs.md`). The two
 * promises that matter are held here: a re-check that says the action no longer applies means the
 * action is never sent, and whatever went wrong comes back as words from this app's dictionary —
 * never the browser's "Failed to fetch".
 */

describe("pressOnce", () => {
  test("acts, and says it is done", async () => {
    const sent: string[] = [];
    const outcome = await pressOnce({
      act: async () => {
        sent.push("delete");
      },
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(sent).toEqual(["delete"]);
  });

  test("asks first, and sends nothing when it no longer applies", async () => {
    const seen: string[] = [];
    const outcome = await pressOnce({
      recheck: async () => {
        seen.push("recheck");
        return "This Bot has already been deleted.";
      },
      act: async () => {
        seen.push("delete");
      },
    });
    expect(outcome).toEqual({
      kind: "moot",
      sentence: "This Bot has already been deleted.",
    });
    expect(seen).toEqual(["recheck"]);
  });

  test("a re-check with nothing to say lets the action go", async () => {
    const seen: string[] = [];
    await pressOnce({
      recheck: async () => {
        seen.push("recheck");
        return null;
      },
      act: () => {
        seen.push("delete");
      },
    });
    expect(seen).toEqual(["recheck", "delete"]);
  });

  test("a refusal comes back as the sentence it was thrown with", async () => {
    const outcome = await pressOnce({
      act: async () => {
        throw new Error("That routine is no longer there.");
      },
    });
    expect(outcome).toEqual({
      kind: "failed",
      sentence: "That routine is no longer there.",
    });
  });

  test("a re-check that could not be asked is a failure, not a go-ahead", async () => {
    const acted: string[] = [];
    const outcome = await pressOnce({
      recheck: async () => {
        throw new TypeError("Failed to fetch");
      },
      act: () => {
        acted.push("delete");
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(acted).toEqual([]);
  });
});

describe("failureSentence", () => {
  const unreachable =
    "The server could not be reached. Please try again in a moment.";
  const general = "That did not go through. Try again.";

  test("the browser's three words for a request nothing answered are one sentence of ours", () => {
    for (const said of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(failureSentence(new TypeError(said))).toBe(unreachable);
    }
    expect(ko[unreachable]).toBeTruthy();
  });

  test("an engine's error is never shown as it is", () => {
    expect(
      failureSentence(
        new TypeError("Cannot read properties of undefined (reading 'id')"),
      ),
    ).toBe(general);
    expect(failureSentence(new SyntaxError("JSON Parse error"))).toBe(general);
    expect(
      failureSentence(new DOMException("The user aborted.", "AbortError")),
    ).toBe(general);
    expect(ko[general]).toBeTruthy();
  });

  test("an error of ours is its own message, and anything else is the general sentence", () => {
    expect(failureSentence(new Error("저장하지 못했어요."))).toBe(
      "저장하지 못했어요.",
    );
    class Refused extends Error {}
    expect(failureSentence(new Refused("이미 삭제되었어요."))).toBe(
      "이미 삭제되었어요.",
    );
    expect(failureSentence(new Error("   "))).toBe(general);
    expect(failureSentence("a string")).toBe(general);
    expect(failureSentence(undefined)).toBe(general);
  });
});
