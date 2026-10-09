import { describe, expect, test } from "bun:test";
import {
  isSameAsk,
  SECRET_FIELDS_MAX,
  SECRET_LABEL_MAX,
  secretAskName,
  secretFieldsOf,
} from "../shared/secret-ask";
import { computerTool } from "../shared/tools/computer";

/**
 * A CARD THAT ASKS A PERSON FOR VALUES, READ THE SAME WAY BY EVERYBODY WHO READS IT
 * (`shared/secret-ask.ts`, 2026-10-10).
 *
 * The tool the model calls, the server that judges the card, the computer that holds it and the
 * card a person types into all read the request through one function. What it takes for a card,
 * and what it refuses to, is held here once rather than in four suites that could each agree with
 * themselves.
 */
describe("the boxes a request names", () => {
  test("are read from a list, or from the one label and ref the tool took before a card held several", () => {
    expect(
      secretFieldsOf({
        fields: [
          { ref: "e1", label: "아이디" },
          { ref: " e2 ", label: "비밀번호" },
        ],
      }),
    ).toEqual([
      { ref: "e1", label: "아이디" },
      { ref: "e2", label: "비밀번호" },
    ]);
    // A conversation from before 2026-10-10 holds this shape, and a model reading it writes it.
    expect(secretFieldsOf({ label: "인증번호", ref: "e7" })).toEqual([
      { ref: "e7", label: "인증번호" },
    ]);
    // The list is the request where there is one: a stray `ref` beside it names nothing more.
    expect(
      secretFieldsOf({ fields: [{ ref: "e1", label: "값" }], ref: "e9" }),
    ).toEqual([{ ref: "e1", label: "값" }]);
  });

  test("are each named in one bounded line, and say something honest when the Bot named nothing", () => {
    const long = "가".repeat(SECRET_LABEL_MAX + 40);
    expect(
      secretFieldsOf({
        fields: [
          { ref: "e1", label: "  네이버\n\t비밀번호  " },
          { ref: "e2", label: long },
          { ref: "e3", label: "   " },
          { ref: "e4" },
          { ref: "e5", label: 7 },
        ],
      })?.map((field) => field.label),
    ).toEqual([
      "네이버 비밀번호",
      "가".repeat(SECRET_LABEL_MAX),
      "the value this page is asking for",
      "the value this page is asking for",
      "the value this page is asking for",
    ]);
  });

  test("are no card at all with none, with more than a card holds, with one box twice, or with something that is not a box", () => {
    const box = (n: number) => ({ ref: `e${n}`, label: "값" });
    const most = Array.from({ length: SECRET_FIELDS_MAX }, (_, n) => box(n));
    expect(secretFieldsOf({ fields: most })).toHaveLength(SECRET_FIELDS_MAX);
    for (const args of [
      null,
      undefined,
      {},
      { label: "ref가 없다" },
      { fields: [] },
      { fields: [...most, box(99)] },
      // Two values for one field: the second would replace the first, in an order nobody chose.
      { fields: [box(1), { ...box(1), label: "한 번 더" }] },
      { fields: [box(1), { ref: " e1 ", label: "빈칸만 다른 같은 칸" }] },
      { fields: [box(1), null] },
      { fields: [box(1), "e2"] },
      { fields: [{ label: "ref가 없는 칸" }] },
      { fields: [{ ref: "   ", label: "빈 ref" }] },
      { fields: [{ ref: 7, label: "숫자 ref" }] },
      // A list that is not a list is not rescued by the old shape beside it.
      { fields: "e1", ref: "e1", label: "값" },
      { ref: "" },
    ]) {
      expect([JSON.stringify(args), secretFieldsOf(args as never)]).toEqual([
        JSON.stringify(args),
        null,
      ]);
    }
  });

  test("give the card one line to be called by, in the order a person is shown them", () => {
    expect(secretAskName([{ label: "아이디" }, { label: "비밀번호" }])).toBe(
      "아이디, 비밀번호",
    );
    expect(secretAskName([{ label: "인증번호" }])).toBe("인증번호");
  });
});

describe("which ask an ask is", () => {
  test("is its boxes, in order, and the snapshot they are of — and nothing a model wrote", () => {
    const ask = { refs: ["e1", "e2"], snapshotId: 3 };
    expect(isSameAsk(ask, { refs: ["e1", "e2"], snapshotId: 3 })).toBe(true);
    for (const another of [
      { refs: ["e2", "e1"], snapshotId: 3 },
      { refs: ["e1"], snapshotId: 3 },
      { refs: ["e1", "e2", "e3"], snapshotId: 3 },
      { refs: ["e1", "e2"], snapshotId: 4 },
      { refs: ["e1", "e2"] },
    ]) {
      expect(isSameAsk(ask, another)).toBe(false);
      expect(isSameAsk(another, ask)).toBe(false);
    }
    // Where neither side says which snapshot, the boxes alone are compared.
    expect(isSameAsk({ refs: ["e1"] }, { refs: ["e1"] })).toBe(true);
  });
});

describe("the tool a model is handed", () => {
  test("takes a list of boxes bounded by what a card holds, and no longer one label and ref", () => {
    const tool = computerTool("computer_request_secret");
    if (!tool) throw new Error("the tool is not in the catalogue");
    const schema = tool.parameters as unknown as {
      required: string[];
      properties: Record<
        string,
        { type?: string; minItems?: number; maxItems?: number; items?: unknown }
      >;
    };
    expect(schema.required).toEqual(["fields", "snapshotId"]);
    // `login` is the one thing beside them, and never required: which saved login, by an id the
    // tool itself handed back, where a site has several (2026-10-10, record §6, piece 2-4).
    expect(Object.keys(schema.properties).sort()).toEqual([
      "fields",
      "login",
      "snapshotId",
    ]);
    expect(schema.properties.login).toMatchObject({ type: "string" });
    expect(schema.properties.fields).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: SECRET_FIELDS_MAX,
      items: { type: "object", required: ["ref", "label"] },
    });
  });
});
