import { describe, expect, test } from "bun:test";
import { docHoldFrame } from "../src/hub/link";

/**
 * "쓰는 중" reaches the app over the VM's line (`hub/link.ts`): the hub's `doc.lock` light frame —
 * not an event, not numbered — is passed on as `hub.doc.lock` with the fields the editor draws,
 * and nothing else is mistaken for one.
 */
describe("the hub's hold frame on the VM's line", () => {
  test("a hold taken passes on with who and until when, and a hold let go with null", () => {
    const taken = {
      kind: "doc.lock",
      doc: "d_1",
      block: "b_abcdefghij",
      member: "m_2",
      name: "민수",
      until: "2026-10-17T07:00:15.000Z",
      extra: "dropped",
    };
    expect(docHoldFrame(taken)).toEqual({
      kind: "hub.doc.lock",
      doc: "d_1",
      block: "b_abcdefghij",
      member: "m_2",
      name: "민수",
      until: "2026-10-17T07:00:15.000Z",
    });
    expect(docHoldFrame({ ...taken, name: null, until: null })).toMatchObject({
      name: null,
      until: null,
    });
  });

  test.each([
    ["a numbered event", { kind: "event", seq: 4, type: "doc.changed" }],
    [
      "a hold with no block",
      { kind: "doc.lock", doc: "d_1", member: "m_2", name: null, until: null },
    ],
    [
      "a hold whose until is a number",
      {
        kind: "doc.lock",
        doc: "d_1",
        block: "b_1",
        member: "m_2",
        name: null,
        until: 5,
      },
    ],
    ["not an object", "doc.lock"],
  ])("%s is not one", (_name, frame) => {
    expect(docHoldFrame(frame)).toBeNull();
  });
});
