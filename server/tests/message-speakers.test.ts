import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { attribute, speakersOf } from "../src/runner/laf-runner";

const said = (id: string, by?: string): Message =>
  ({
    id,
    role: "assistant",
    content: id,
    ...(by ? { lafAgentId: by } : {}),
  }) as unknown as Message;

describe("who said it, kept across saves", () => {
  test("a speaker already recorded survives an input that arrived stripped", () => {
    // Every run hands the whole history back with our fields gone; the record is what is stored.
    const stored = [said("m1", "risk-analyst"), said("m2", "knowledge")];
    const merged = attribute(
      [said("m1"), said("m2"), said("m3", "general-assistant")],
      speakersOf(stored),
    );
    expect(
      merged.map((m) => (m as { lafAgentId?: string }).lafAgentId),
    ).toEqual(["risk-analyst", "knowledge", "general-assistant"]);
  });

  test("a message carrying its own record keeps it, and only a new turn can", () => {
    /*
     * The message's own field beats the stored map — which sounds like a way to rename an older
     * reply and is not one. The only messages that reach a save carrying this field are the ones
     * `assistantMessagesFrom` just built for the run that is ending. Everything else arrives from
     * the client, and both doors strip it: AG-UI's message schemas are zod `strip`, and
     * `/threads/:id/messages` rebuilds each message from a fixed whitelist on the way out.
     */
    const merged = attribute(
      [said("m1", "knowledge")],
      speakersOf([said("m1", "risk-analyst")]),
    );
    expect((merged[0] as { lafAgentId?: string }).lafAgentId).toBe("knowledge");

    // The stripped case, which is the one that actually happens on every save.
    const stripped = attribute(
      [said("m1")],
      speakersOf([said("m1", "risk-analyst")]),
    );
    expect((stripped[0] as { lafAgentId?: string }).lafAgentId).toBe(
      "risk-analyst",
    );
  });

  test("a message nobody recorded a speaker for keeps none", () => {
    // No fallback, deliberately: filling one in would put a colleague's words under another's name.
    const merged = attribute([said("m1")], new Map());
    expect("lafAgentId" in (merged[0] as object)).toBe(false);
  });
});
