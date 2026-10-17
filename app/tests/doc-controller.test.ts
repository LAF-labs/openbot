import { describe, expect, test } from "bun:test";
import { RENEW_MS } from "../src/components/docs/block-lock";
import {
  createDocController,
  type DocDoors,
  type DocTimers,
  SAVE_AFTER_MS,
} from "../src/components/docs/doc-controller";
import { routeFrame } from "../src/components/docs/doc-editor";
import type { DocBlock, DocOp, OpenDoc } from "../src/lib/hub/docs";
import { RequestRefusedError } from "../src/lib/refusals";

/**
 * The open document (`components/docs/doc-controller.ts`) against scripted doors and a clock the
 * test turns: the hold's life (taken on focus, renewed every five seconds, let go on leaving or
 * moving, lost when somebody else has it), the order and shape of what is sent, a refused save
 * reopened with the colleague's text, and the live frames each reaching the part they name.
 */

function clock() {
  let now = 1_000_000;
  let next = 1;
  const timers = new Map<
    number,
    { at: number; run: () => void; every: number | null }
  >();
  const api: DocTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run, every: null });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    setInterval: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run, every: ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id as number),
  };
  /** Moves the clock, running what falls due in order, and lets the promises they start settle. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += timer.every;
      timer.run();
      await settle();
    }
    now = end;
    await settle();
  };
  return { api, advance };
}

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const block = (id: string, text: string, version = 1): DocBlock => ({
  id,
  kind: "paragraph",
  text,
  attrs: {},
  version,
  hash: `h${version}`,
});

const doc = (blocks: DocBlock[], holds: OpenDoc["holds"] = []): OpenDoc => ({
  doc: {
    id: "d_1",
    title: "회의록",
    folder: "/",
    updatedAt: null,
    updatedBy: null,
  },
  blocks,
  holds,
});

function harness(first: OpenDoc) {
  const time = clock();
  const calls: string[] = [];
  const saved: DocOp[][] = [];
  let current = first;
  let lockAnswer: "held" | "busy" = "held";
  let saveAnswer: (ops: DocOp[]) => DocBlock[] = (ops) =>
    ops.flatMap((op) => {
      if (op.op === "replace") {
        const was = current.blocks.find((one) => one.id === op.id);
        return was
          ? [
              {
                ...was,
                ...(op.text !== undefined ? { text: op.text } : {}),
                version: was.version + 1,
              },
            ]
          : [];
      }
      if (op.op === "insert_after") {
        return [{ ...block(op.newId, op.text, 1), kind: op.kind }];
      }
      return [];
    });
  const doors: DocDoors = {
    read: async () => {
      calls.push("read");
      return current;
    },
    readBlock: async (id) => {
      calls.push(`readBlock ${id}`);
      return current.blocks.find((one) => one.id === id) ?? null;
    },
    save: async (ops) => {
      calls.push(`save ${ops.map((op) => op.op).join("+")}`);
      saved.push(ops);
      return saveAnswer(ops);
    },
    lock: async (id) => {
      calls.push(`lock ${id}`);
      return lockAnswer;
    },
    unlock: async (id) => {
      calls.push(`unlock ${id}`);
    },
  };
  let made = 0;
  const controller = createDocController({
    doors,
    meId: "m_me",
    timers: time.api,
    newKey: () => `key-${++made}`,
    newBlockId: () => `b_new${String(++made).padStart(8, "0")}`,
  });
  controller.load(first);
  return {
    controller,
    calls,
    saved,
    time,
    setDoc: (next: OpenDoc) => {
      current = next;
    },
    setLock: (answer: "held" | "busy") => {
      lockAnswer = answer;
    },
    setSave: (answer: (ops: DocOp[]) => DocBlock[]) => {
      saveAnswer = answer;
    },
  };
}

describe("the hold on the block being written in", () => {
  test("is taken on focus, renewed every five seconds, and let go on leaving", async () => {
    const run = harness(doc([block("b_1", "가"), block("b_2", "나")]));
    run.controller.focus("b_1");
    await settle();
    expect(run.calls).toEqual(["lock b_1"]);
    await run.time.advance(RENEW_MS * 2);
    expect(run.calls).toEqual(["lock b_1", "lock b_1", "lock b_1"]);
    run.controller.leave();
    await settle();
    expect(run.calls.at(-1)).toBe("unlock b_1");
    // Let go: no more renewals.
    await run.time.advance(RENEW_MS * 2);
    expect(run.calls.filter((call) => call === "lock b_1")).toHaveLength(3);
  });

  test("moving to another block lets go of the first before taking the second", async () => {
    const run = harness(doc([block("b_1", "가"), block("b_2", "나")]));
    run.controller.focus("b_1");
    await settle();
    run.controller.focus("b_2");
    await settle();
    expect(run.calls).toEqual(["lock b_1", "unlock b_1", "lock b_2"]);
    expect(run.controller.snapshot().activeKey).toBe("b_2");
  });

  test("a block somebody else holds does not open, and says who", async () => {
    const until = 1_000_000 + 10_000;
    const run = harness(
      doc(
        [block("b_1", "가")],
        [{ blockId: "b_1", memberId: "m_2", name: "민수", until }],
      ),
    );
    expect(run.controller.focus("b_1")).toBe(false);
    expect(run.calls).toEqual([]);
    expect(run.controller.snapshot().notice).toEqual({
      kind: "busy",
      name: "민수",
    });
    // Their hold ends on the hub's clock; the block opens again without a read.
    await run.time.advance(10_100);
    expect(run.controller.snapshot().holds).toEqual([]);
    expect(run.controller.focus("b_1")).toBe(true);
  });

  test("a renewal refused because somebody else took it closes the box and says so", async () => {
    const run = harness(doc([block("b_1", "가")]));
    run.controller.focus("b_1");
    await settle();
    run.setLock("busy");
    await run.time.advance(RENEW_MS);
    expect(run.controller.snapshot().activeKey).toBeNull();
    expect(run.controller.snapshot().notice).toEqual({ kind: "lost" });
  });

  test("this person's own hold, read back from the hub, is never drawn as somebody else's", () => {
    const run = harness(
      doc(
        [block("b_1", "가")],
        [
          {
            blockId: "b_1",
            memberId: "m_me",
            name: "나",
            until: 1_000_000 + 9_000,
          },
        ],
      ),
    );
    expect(run.controller.snapshot().holds).toEqual([]);
  });
});

describe("what is sent", () => {
  test("typing saves once, after the pause, with the version it was typed against", async () => {
    const run = harness(doc([block("b_1", "가", 4)]));
    run.controller.focus("b_1");
    run.controller.input("b_1", "가나");
    run.controller.input("b_1", "가나다");
    await run.time.advance(SAVE_AFTER_MS - 1);
    expect(run.saved).toEqual([]);
    await run.time.advance(1);
    expect(run.saved).toEqual([
      [{ op: "replace", id: "b_1", version: 4, text: "가나다" }],
    ]);
  });

  test("nothing is saved mid-syllable; the syllable's end saves what was assembled", async () => {
    const run = harness(doc([block("b_1", "", 1)]));
    run.controller.focus("b_1");
    run.controller.compositionStart();
    run.controller.input("b_1", "ㅎ");
    run.controller.input("b_1", "하");
    await run.time.advance(SAVE_AFTER_MS * 3);
    expect(run.saved).toEqual([]);
    run.controller.compositionEnd("b_1", "한");
    await run.time.advance(SAVE_AFTER_MS);
    expect(run.saved).toEqual([
      [{ op: "replace", id: "b_1", version: 1, text: "한" }],
    ]);
  });

  test("Enter draws the new block at once; the hub gets the head and the new block in one batch, by the id made here", async () => {
    const run = harness(doc([block("b_1", "앞뒤", 2)]));
    run.controller.focus("b_1");
    await settle();
    run.controller.split("b_1", "앞", "뒤");
    const drawn = run.controller.snapshot();
    expect(
      drawn.rows.map((row) => [row.key, row.block.text, row.isNew]),
    ).toEqual([
      ["b_1", "앞", false],
      ["b_new00000001", "뒤", true],
    ]);
    expect(drawn.activeKey).toBe("b_new00000001");
    // Typed into the new block before the hub answered: it follows the insert, by the same id.
    run.controller.input("b_new00000001", "뒤에 더");
    await run.controller.settled();
    await run.time.advance(SAVE_AFTER_MS);
    expect(run.saved).toEqual([
      [
        { op: "replace", id: "b_1", version: 2, text: "앞" },
        {
          op: "insert_after",
          id: "b_1",
          newId: "b_new00000001",
          kind: "paragraph",
          text: "뒤에 더",
          attrs: {},
        },
      ],
    ]);
    expect(run.calls).toContain("lock b_new00000001");
    expect(run.controller.snapshot().rows[1]?.isNew).toBe(false);
  });

  test("Backspace at the start joins the text above and deletes the block, in one batch", async () => {
    const run = harness(doc([block("b_1", "앞", 3), block("b_2", "뒤", 5)]));
    run.controller.focus("b_2");
    run.controller.mergeUp("b_2");
    expect(run.controller.snapshot().activeKey).toBe("b_1");
    expect(run.controller.snapshot().caret).toBe(1);
    await run.controller.settled();
    expect(run.saved).toEqual([
      [
        { op: "replace", id: "b_1", version: 3, text: "앞뒤" },
        { op: "delete", id: "b_2", version: 5 },
      ],
    ]);
  });

  test("a check toggled, a kind chosen: what that kind carries, and no other kind's keys", async () => {
    const run = harness(
      doc([
        {
          ...block("b_1", "할 것", 1),
          kind: "check",
          attrs: { checked: false },
        },
      ]),
    );
    run.controller.toggleCheck("b_1");
    await run.controller.settled();
    run.controller.setKind("b_1", "paragraph", "할 것");
    await run.controller.settled();
    expect(run.saved).toEqual([
      [{ op: "replace", id: "b_1", version: 1, attrs: { checked: true } }],
      [
        {
          op: "replace",
          id: "b_1",
          version: 2,
          kind: "paragraph",
          attrs: {},
          text: "할 것",
        },
      ],
    ]);
  });
});

describe("a save somebody else got to first", () => {
  test("is read again and reopened with theirs, and the person is told", async () => {
    const run = harness(doc([block("b_1", "원래", 1), block("b_2", "옆", 1)]));
    run.controller.focus("b_1");
    run.controller.input("b_1", "내가 고친 글");
    run.setDoc(doc([block("b_1", "민수가 고친 글", 2), block("b_2", "옆", 1)]));
    run.setSave(() => {
      throw new RequestRefusedError("stale", 409, "laf:doc_block_changed");
    });
    const resetBefore = run.controller.snapshot().rows[0]?.reset ?? 0;
    await run.time.advance(SAVE_AFTER_MS);
    await run.controller.settled();
    await settle();
    const after = run.controller.snapshot();
    expect(after.notice).toEqual({ kind: "stale" });
    expect(after.rows[0]?.block.text).toBe("민수가 고친 글");
    expect(after.rows[0]?.block.version).toBe(2);
    expect(after.rows[0]?.reset).toBe(resetBefore + 1);
    // Still open: the person goes on from the colleague's text, against its new version.
    expect(after.activeKey).toBe("b_1");
    run.setSave((ops) => [block("b_1", "x", 3)].slice(0, ops.length));
    run.controller.input("b_1", "민수가 고친 글!");
    await run.time.advance(SAVE_AFTER_MS);
    expect(run.saved.at(-1)).toEqual([
      { op: "replace", id: "b_1", version: 2, text: "민수가 고친 글!" },
    ]);
  });

  test("a read never overwrites the block being written in", () => {
    const run = harness(doc([block("b_1", "원래", 1)]));
    run.controller.focus("b_1");
    run.controller.input("b_1", "쓰는 중");
    run.controller.load(doc([block("b_1", "다른 글", 2)]));
    expect(run.controller.snapshot().rows[0]?.block.text).toBe("쓰는 중");
  });
});

describe("live frames", () => {
  test("a colleague's block saved is read alone and redrawn; the block being written is not", async () => {
    const run = harness(doc([block("b_1", "가", 1), block("b_2", "나", 1)]));
    run.controller.focus("b_1");
    run.setDoc(doc([block("b_1", "바뀜", 2), block("b_2", "나도 바뀜", 2)]));
    routeFrame(
      run.controller,
      { kind: "hub.doc.block_changed", refId: "d_1/b_2" },
      "d_1",
    );
    routeFrame(
      run.controller,
      { kind: "hub.doc.block_changed", refId: "d_1/b_1" },
      "d_1",
    );
    routeFrame(
      run.controller,
      { kind: "hub.doc.block_changed", refId: "d_9/b_2" },
      "d_1",
    );
    await settle();
    expect(run.calls.filter((call) => call.startsWith("read"))).toEqual([
      "readBlock b_2",
      "readBlock b_1",
    ]);
    const rows = run.controller.snapshot().rows;
    expect(rows.map((row) => row.block.text)).toEqual(["가", "나도 바뀜"]);
  });

  test("a hold frame draws who is writing at once, and its letting go clears it", () => {
    const run = harness(doc([block("b_1", "가")]));
    routeFrame(
      run.controller,
      {
        kind: "hub.doc.lock",
        doc: "d_1",
        block: "b_1",
        member: "m_2",
        name: "민수",
        until: new Date(1_000_000 + 15_000).toISOString(),
      },
      "d_1",
    );
    expect(run.controller.snapshot().holds).toEqual([
      {
        blockId: "b_1",
        memberId: "m_2",
        name: "민수",
        until: 1_000_000 + 15_000,
      },
    ]);
    routeFrame(
      run.controller,
      {
        kind: "hub.doc.lock",
        doc: "d_1",
        block: "b_1",
        member: "m_2",
        name: "민수",
        until: null,
      },
      "d_1",
    );
    expect(run.controller.snapshot().holds).toEqual([]);
  });

  test("a document changed whole is read once for a burst of frames", async () => {
    const run = harness(doc([block("b_1", "가")]));
    for (let index = 0; index < 5; index += 1) {
      routeFrame(
        run.controller,
        { kind: "hub.doc.changed", refId: "d_1" },
        "d_1",
      );
    }
    routeFrame(
      run.controller,
      { kind: "hub.doc.changed", refId: "d_2" },
      "d_1",
    );
    await run.time.advance(100);
    expect(run.calls).toEqual(["read"]);
  });
});
