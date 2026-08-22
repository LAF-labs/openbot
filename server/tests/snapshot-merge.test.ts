/**
 * The merge that keeps a delivered message alive across a client's next turn.
 *
 * Every run's input is the caller's copy of the thread, and it used to replace the snapshot
 * wholesale. A routine can deliver an answer into the thread while no tab is open; a tab hydrated
 * before that would then, on its next turn, overwrite the thread with a history that never had it.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { mergeKeepingStoredOnly } from "../src/runner/laf-runner";

const m = (id: string, role = "user"): Message =>
  ({ id, role, content: id }) as Message;
const ids = (messages: Message[]) => messages.map((x) => x.id);

describe("merging the client's history with the store", () => {
  test("a stored message the client never saw is kept where it was", () => {
    const stored = [m("u1"), m("a1", "assistant"), m("routine", "assistant")];
    const incoming = [m("u1"), m("a1", "assistant"), m("u2")];
    expect(ids(mergeKeepingStoredOnly(stored, incoming))).toEqual([
      "u1",
      "a1",
      "routine",
      "u2",
    ]);
  });

  test("the client's own order wins where both agree", () => {
    const stored = [m("u1"), m("a1", "assistant")];
    const incoming = [
      m("u1"),
      m("a1", "assistant"),
      m("u2"),
      m("a2", "assistant"),
    ];
    expect(ids(mergeKeepingStoredOnly(stored, incoming))).toEqual(
      ids(incoming),
    );
  });

  test("an empty store changes nothing", () => {
    expect(ids(mergeKeepingStoredOnly([], [m("u1")]))).toEqual(["u1"]);
  });

  test("a store the client has never seen goes first, in order", () => {
    const stored = [m("old1"), m("old2", "assistant")];
    expect(ids(mergeKeepingStoredOnly(stored, [m("new1")]))).toEqual([
      "old1",
      "old2",
      "new1",
    ]);
  });
});
