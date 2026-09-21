import { describe, expect, test } from "bun:test";
import type { ComposerDraft } from "./draft";
import { type QueuedMessage, reduceQueue } from "./queue";

function draft(
  text: string,
  commandIds: string[] = [],
  agentIds: readonly string[] = [],
): ComposerDraft {
  return { text, agentIds, commandIds, isEmpty: false };
}

/** Park one message and hand back the queue it produced, which is what every case starts from. */
function park(
  queue: readonly QueuedMessage[],
  id: string,
  text: string,
  commandIds: string[] = [],
  agentIds: readonly string[] = [],
): readonly QueuedMessage[] {
  return reduceQueue(queue, {
    busy: true,
    draft: draft(text, commandIds, agentIds),
    id,
    type: "submit",
  }).queue;
}

describe("submitting", () => {
  test("an idle send goes straight out and queues nothing", () => {
    const sent = draft("open the invoices page");
    const result = reduceQueue([], {
      busy: false,
      draft: sent,
      id: "one",
      type: "submit",
    });

    expect(result.run).toBe(sent);
    expect(result.queue).toEqual([]);
  });

  test("an idle send takes anything already waiting with it", () => {
    // Not a state the app is supposed to reach, which is exactly why the rule has to hold here on
    // its own: a new message that jumped the queue would run before the correction it corrects.
    const waiting = park([], "one", "no, the other one");
    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("the Q3 file"),
      id: "two",
      type: "submit",
    });

    expect(result.run?.text).toBe("no, the other one\nthe Q3 file");
    expect(result.queue).toEqual([]);
  });

  test("an idle send that empties a queue carries its skills too", () => {
    const waiting = park([], "one", "/search invoices", ["search"]);
    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("/summarize it", ["summarize"]),
      id: "two",
      type: "submit",
    });

    expect(result.run?.commandIds).toEqual(["search", "summarize"]);
  });

  test("a send while the Bot is working waits instead of running", () => {
    const result = reduceQueue([], {
      busy: true,
      draft: draft("no, the other one"),
      id: "one",
      type: "submit",
    });

    expect(result.run).toBeNull();
    expect(result.queue).toEqual([
      { id: "one", text: "no, the other one", commandIds: [], agentIds: [] },
    ]);
  });

  test("keeps the order they were typed in", () => {
    let queue = park([], "one", "first");
    queue = park(queue, "two", "second");
    queue = park(queue, "three", "third");

    expect(queue.map((message) => message.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("settling", () => {
  test("a burst of corrections costs one turn, not three", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "the Q3 file");
    queue = park(queue, "three", "and skip the summary");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe(
      "no, the other one\nthe Q3 file\nand skip the summary",
    );
    expect(result.queue).toEqual([]);
  });

  test("stopping the Bot is what makes the correction run", () => {
    // The whole of stop-then-steer. Nothing below says "stop": pressing it ends the turn, and the
    // end of a turn is the only thing the drain is listening for.
    const queue = park([], "one", "stop reading, just summarise it");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe("stop reading, just summarise it");
    expect(result.queue).toEqual([]);
  });

  test("a turn ending with nothing waiting starts nothing", () => {
    const result = reduceQueue([], { type: "settle" });

    expect(result.run).toBeNull();
    expect(result.queue).toEqual([]);
  });

  test("a queued mention is who the drained turn is for", () => {
    const queue = park(
      [],
      "one",
      "@Knowledge check that again",
      [],
      ["knowledge"],
    );

    expect(reduceQueue(queue, { type: "settle" }).run?.agentIds).toEqual([
      "knowledge",
    ]);
  });

  test("two colleagues named in one message stay named together", () => {
    const queue = park(
      [],
      "one",
      "@Knowledge @Risk both look at this",
      [],
      ["knowledge", "risk-analyst"],
    );

    expect(reduceQueue(queue, { type: "settle" }).run?.agentIds).toEqual([
      "knowledge",
      "risk-analyst",
    ]);
  });

  test("two colleagues asked in two breaths are two turns, not one merged turn", () => {
    /*
     * A room gives the turn to whoever was named. Joining these would have handed both sentences
     * to the same colleague — the first person's question asked of the second.
     */
    let queue = park([], "one", "@Knowledge check that", [], ["knowledge"]);
    queue = park(queue, "two", "@Risk take a look", [], ["risk-analyst"]);

    const first = reduceQueue(queue, { type: "settle" });
    expect(first.run?.agentIds).toEqual(["knowledge"]);
    expect(first.run?.text).toBe("@Knowledge check that");
    expect(first.queue).toHaveLength(1);

    const second = reduceQueue(first.queue, { type: "settle" });
    expect(second.run?.agentIds).toEqual(["risk-analyst"]);
    expect(second.run?.text).toBe("@Risk take a look");
  });

  test("the same two colleagues named in either order are one audience", () => {
    let queue = park(
      [],
      "one",
      "@Knowledge @Risk have a look",
      [],
      ["knowledge", "risk-analyst"],
    );
    queue = park(
      queue,
      "two",
      "@Risk @Knowledge by this evening",
      [],
      ["risk-analyst", "knowledge"],
    );

    const drained = reduceQueue(queue, { type: "settle" });
    expect(drained.run?.text).toBe(
      "@Knowledge @Risk have a look\n@Risk @Knowledge by this evening",
    );
    expect(drained.queue).toEqual([]);
  });

  test("a message naming one of the two starts a turn of its own", () => {
    let queue = park(
      [],
      "one",
      "@Knowledge @Risk have a look",
      [],
      ["knowledge", "risk-analyst"],
    );
    queue = park(queue, "two", "@Risk just you then", [], ["risk-analyst"]);

    const first = reduceQueue(queue, { type: "settle" });
    expect(first.run?.agentIds).toEqual(["knowledge", "risk-analyst"]);
    expect(first.queue).toHaveLength(1);
  });

  test("naming nobody leaves the room asking whoever it was already asking", () => {
    let queue = park([], "one", "check that again");
    queue = park(queue, "two", "and summarise it");

    expect(reduceQueue(queue, { type: "settle" }).run?.agentIds).toEqual([]);
  });

  test("an earlier mention survives a later message that names nobody", () => {
    // "Ask Risk. ... and be brief" is one instruction for Risk, not one for Risk and one for
    // whoever happens to be bound.
    let queue = park([], "one", "@Risk take a look", [], ["risk-analyst"]);
    queue = park(queue, "two", "and be brief");

    expect(reduceQueue(queue, { type: "settle" }).run?.agentIds).toEqual([
      "risk-analyst",
    ]);
  });

  test("carries the skills that were invoked, once each", () => {
    let queue = park([], "one", "/search invoices", ["search"]);
    queue = park(queue, "two", "/search receipts too", ["search"]);
    queue = park(queue, "three", "/summarize it", ["summarize"]);

    expect(reduceQueue(queue, { type: "settle" }).run?.commandIds).toEqual([
      "search",
      "summarize",
    ]);
  });

  test("draining twice does not resend what has already gone", () => {
    const queue = park([], "one", "no, the other one");
    const drained = reduceQueue(queue, { type: "settle" });

    expect(reduceQueue(drained.queue, { type: "settle" }).run).toBeNull();
  });
});

describe("removing", () => {
  test("takes a message back before it runs", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "actually never mind");

    const result = reduceQueue(queue, { id: "two", type: "remove" });

    expect(result.queue.map((message) => message.text)).toEqual([
      "no, the other one",
    ]);
    expect(result.run).toBeNull();
  });

  test("what is left is what still runs on settle", () => {
    let queue = park([], "one", "keep this");
    queue = park(queue, "two", "drop this");
    queue = reduceQueue(queue, { id: "two", type: "remove" }).queue;

    expect(reduceQueue(queue, { type: "settle" }).run?.text).toBe("keep this");
  });

  test("removing the last one leaves nothing to run", () => {
    const queue = park([], "one", "second thoughts");
    const left = reduceQueue(queue, { id: "one", type: "remove" }).queue;

    expect(left).toEqual([]);
    expect(reduceQueue(left, { type: "settle" }).run).toBeNull();
  });

  test("an id that is not in the queue changes nothing at all", () => {
    // Same array, not an equal one: a removal that missed must not cost a re-render.
    const queue = park([], "one", "no, the other one");

    expect(reduceQueue(queue, { id: "elsewhere", type: "remove" }).queue).toBe(
      queue,
    );
  });

  test("two identical corrections are two entries and only one is taken back", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "no, the other one");

    const result = reduceQueue(queue, { id: "one", type: "remove" });

    expect(result.queue).toEqual([
      { id: "two", text: "no, the other one", commandIds: [], agentIds: [] },
    ]);
  });
});
