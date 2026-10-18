import { describe, expect, test } from "bun:test";
import type { HubHttp, HubRequest } from "../src/hub/http";
import type { HubOutbox } from "../src/hub/outbox";
import {
  checkHubArgs,
  createHubToolTransport,
  HUB_DOC_OPS_MAX,
} from "../src/hub/tools";
import { PluginRefusedError } from "../src/plugins/store";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";

/**
 * 라피 and the team's documents (`hub/tools.ts`, kinds `doc` and `doc_blocks`), against a scripted
 * hub: a document is read as marked markdown, and changed only a block at a time, each op naming the
 * hash its block had when 라피 read it. A stale hash or a block a person is writing in is the hub's
 * 409, handed to the Bot at once as a refusal it has Korean for — never kept in the outbox for
 * later, where it would be refused after the turn had ended.
 */

const NO_OUTBOX: HubOutbox = {
  enqueue: async () => {
    throw new Error("a document write never goes through the outbox");
  },
  sweep: async () => ({ delivered: 0, refused: 0, kept: 0 }),
};

const HASH_A = "0123456789abcdef";
const HASH_B = "fedcba9876543210";

function scripted(
  answer: (
    request: HubRequest,
  ) => { status: number; body: unknown } | { status: number; code: string },
) {
  const seen: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      seen.push(request);
      const reply = answer(request);
      if ("code" in reply) {
        return { ok: false, status: reply.status, code: reply.code };
      }
      return { ok: true, status: reply.status, body: reply.body } as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, seen };
}

const transport = (http: HubHttp) =>
  createHubToolTransport({
    http,
    outbox: NO_OUTBOX,
    database: undefined as never,
  });

const chat = { url: "https://hub.example", drawnOn: "conversation" as const };

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof PluginRefusedError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("라피 reads a team document", () => {
  test("with an id: the document's marked markdown, asked once as a chat", async () => {
    const markdown = `<!-- b_aaaaaaaaaa ${HASH_A} -->\n# 3월 마감\n\n<!-- b_bbbbbbbbbb ${HASH_B} -->\n- 견적 보내기`;
    const hub = scripted(() => ({
      status: 200,
      body: { ok: true, rev: 7, markdown },
    }));
    const result = await transport(hub.http).callTool(chat, "read", {
      kind: "doc",
      id: "d_1",
    });
    expect(hub.seen).toEqual([
      { path: "/docs/d_1/markdown", origin: "chat", retry: false },
    ]);
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "doc",
      id: "d_1",
      markdown,
    });
  });

  test("without an id: the list, without the fields the Bot was never told about", async () => {
    const hub = scripted(() => ({
      status: 200,
      body: {
        ok: true,
        docs: [
          {
            id: "d_1",
            title: "3월 마감",
            folder: "/",
            visibility: "all",
            rev: 4,
            updatedAt: "2026-10-17T01:00:00.000Z",
          },
        ],
        next: null,
      },
    }));
    const result = await transport(hub.http).callTool(chat, "read", {
      kind: "doc",
    });
    expect(hub.seen.map((request) => request.path)).toEqual(["/docs"]);
    expect(JSON.parse(result.text).docs).toEqual([
      {
        id: "d_1",
        title: "3월 마감",
        folder: "/",
        at: "2026-10-17T01:00:00.000Z",
      },
    ]);
  });
});

describe("라피 changes a document's blocks", () => {
  test("the ops go now, spelled again, each with the hash it read, under a key", async () => {
    const hub = scripted(() => ({
      status: 200,
      body: {
        ok: true,
        rev: 8,
        blocks: [
          {
            id: "b_bbbbbbbbbb",
            kind: "list",
            text: "견적 보냄",
            hash: HASH_A,
            version: 3,
          },
        ],
        deleted: [],
      },
    }));
    const result = await transport(hub.http).callTool(chat, "write", {
      kind: "doc_blocks",
      doc: "d_1",
      ops: [
        {
          op: "replace",
          id: "b_bbbbbbbbbb",
          expectHash: HASH_B,
          text: "견적 보냄",
          version: 99,
          attrs: { checked: true },
        },
      ],
    });
    expect(hub.seen).toHaveLength(1);
    const [sent] = hub.seen;
    expect(sent?.method).toBe("POST");
    expect(sent?.path).toBe("/docs/d_1/blocks");
    expect(sent?.origin).toBe("chat");
    expect(sent?.retry).toBe(false);
    expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // What a person's save carries (`version`) and what the Bot was never offered (`attrs`) are not sent.
    expect(sent?.body).toEqual({
      ops: [
        {
          op: "replace",
          id: "b_bbbbbbbbbb",
          expectHash: HASH_B,
          text: "견적 보냄",
        },
      ],
    });
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "doc_blocks",
      sent: true,
      blocks: [{ id: "b_bbbbbbbbbb", kind: "list", hash: HASH_A }],
      deleted: [],
    });
  });

  test.each([["laf:doc_block_changed"], ["laf:doc_block_busy"]])(
    "the hub's 409 %s reaches the Bot at once, with Korean for it",
    async (code) => {
      const hub = scripted(() => ({ status: 409, code }));
      const refused = await refusal(
        transport(hub.http).callTool(chat, "write", {
          kind: "doc_blocks",
          doc: "d_1",
          ops: [{ op: "delete", id: "b_bbbbbbbbbb", expectHash: HASH_A }],
        }),
      );
      expect(refused).toBe(code);
      expect(hub.seen).toHaveLength(1);
      expect(TOOL_RESULT_KO[code]).toContain("하나도 저장되지 않았다");
    },
  );

  test.each([
    ["an op with no hash", [{ op: "replace", id: "b_1", text: "x" }]],
    [
      "a hash in another shape",
      [{ op: "replace", id: "b_1", expectHash: "abc", text: "x" }],
    ],
    [
      "a whole-document op",
      [{ op: "replace_all", id: "d_1", expectHash: HASH_A, text: "x" }],
    ],
    [
      "a replace that changes nothing",
      [{ op: "replace", id: "b_1", expectHash: HASH_A }],
    ],
    [
      "a move with nowhere to go",
      [{ op: "move", id: "b_1", expectHash: HASH_A }],
    ],
    [
      "a kind the Bot is not offered",
      [{ op: "insert_after", id: "b_1", expectHash: HASH_A, kind: "file" }],
    ],
    ["no ops", []],
  ])("%s is refused before anybody is asked", async (_name, ops) => {
    const hub = scripted(() => ({ status: 200, body: { ok: true } }));
    const args = { kind: "doc_blocks", doc: "d_1", ops };
    expect(() => checkHubArgs("write", args)).toThrow(PluginRefusedError);
    expect(
      await refusal(transport(hub.http).callTool(chat, "write", args)),
    ).toBe("laf:tool_arguments_invalid");
    expect(hub.seen).toHaveLength(0);
  });

  test("more ops than one call takes are refused; as many are taken", () => {
    const op = { op: "delete", id: "b_1", expectHash: HASH_A };
    const args = (count: number) => ({
      kind: "doc_blocks",
      doc: "d_1",
      ops: Array.from({ length: count }, () => op),
    });
    expect(() => checkHubArgs("write", args(HUB_DOC_OPS_MAX))).not.toThrow();
    expect(() => checkHubArgs("write", args(HUB_DOC_OPS_MAX + 1))).toThrow(
      PluginRefusedError,
    );
  });
});
