import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { createHubHttp, type HubHttp, type HubRequest } from "../src/hub/http";
import type { HubOutbox } from "../src/hub/outbox";
import {
  checkHubArgs,
  createHubToolTransport,
  HUB_SEARCH_LIMIT,
  type HubToolRuntime,
} from "../src/hub/tools";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import { PluginRefusedError } from "../src/plugins/store";
import { markHubResults, type StoredMessage } from "../src/runner/thread-store";

/**
 * 라피's reads of the company hub, against a scripted hub: what is asked (path, body, origin, one
 * attempt), what the Bot is handed back, and what is refused before anything is asked. The writes
 * go through `hub_outbox` and are proven against Postgres in `hub-tools.integration.test.ts`.
 */

const NO_OUTBOX: HubOutbox = {
  enqueue: async () => {
    throw new Error("a read never writes");
  },
  sweep: async () => ({ delivered: 0, refused: 0, kept: 0 }),
};

function scripted(answer: (request: HubRequest) => unknown) {
  const seen: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      seen.push(request);
      const body = answer(request);
      if (body && typeof body === "object" && "fail" in body) {
        return {
          ok: false,
          status: null,
          code: String((body as { fail: string }).fail),
        };
      }
      return { ok: true, status: 200, body } as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, seen };
}

function transport(http: HubHttp, extra: Partial<HubToolRuntime> = {}) {
  return createHubToolTransport({
    http,
    outbox: NO_OUTBOX,
    database: undefined as never,
    ...extra,
  });
}

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

describe("reading the company hub", () => {
  test("search asks POST /search once, as a chat, and hands back the hits", async () => {
    const hub = scripted(() => ({
      ok: true,
      hits: [
        {
          kind: "file",
          id: "f_1",
          title: "견적서.xlsx",
          where: { folder: "/영업", from: 1200 },
          snippet: "단가 12,000원",
          score: 0.8,
          at: "2026-10-15T01:00:00Z",
          by: "m_2",
          extra: "a field the Bot was never told about",
        },
      ],
      next: null,
    }));
    const result = await transport(hub.http).callTool(chat, "read", {
      kind: "search",
      query: "견적",
      kinds: ["file", "nonsense"],
    });

    expect(hub.seen).toEqual([
      {
        method: "POST",
        path: "/search",
        body: { q: "견적", kinds: ["file"], limit: HUB_SEARCH_LIMIT },
        origin: "chat",
        retry: false,
      },
    ]);
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "search",
      shown: 1,
      hits: [
        {
          kind: "file",
          id: "f_1",
          title: "견적서.xlsx",
          where: { folder: "/영업", from: 1200 },
          snippet: "단가 12,000원",
          at: "2026-10-15T01:00:00Z",
          by: "m_2",
        },
      ],
    });
  });

  test("a file is read by range, and a range with more says where the next one starts", async () => {
    const hub = scripted(() => ({ text: "가".repeat(8_000), truncated: true }));
    const result = await transport(hub.http).callTool(
      { url: "https://hub.example" },
      "read",
      { kind: "file", id: "f/1", from: 16_000 },
    );
    // The id is a path segment, encoded; a routine's read says `job`.
    expect(hub.seen[0]?.path).toBe("/files/f%2F1/text?from=16000&limit=8000");
    expect(hub.seen[0]?.origin).toBe("job");
    const read = JSON.parse(result.text);
    expect(read.from).toBe(16_000);
    expect(read.next).toBe(24_000);
    expect(read.text).toHaveLength(8_000);
  });

  test("the last range of a file has no next", async () => {
    const hub = scripted(() => ({ text: "끝.", truncated: false }));
    const result = await transport(hub.http).callTool(chat, "read", {
      kind: "file",
      id: "f_1",
    });
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "file",
      id: "f_1",
      from: 0,
      text: "끝.",
    });
  });

  test("a room's newest messages come newest first, and a page too long loses its oldest", async () => {
    const messages = Array.from({ length: 30 }, (_, at) => ({
      seq: at + 1,
      by: "m:m_2",
      text: `${at + 1}번 글 `.repeat(200),
      mentions: [],
      runId: null,
      files: [],
      at: "2026-10-16T00:00:00Z",
    }));
    const hub = scripted(() => ({ ok: true, messages, seq: 30, more: false }));
    const result = await transport(hub.http).callTool(chat, "read", {
      kind: "room",
      id: "r_1",
    });
    expect(hub.seen[0]?.path).toBe("/rooms/r_1/messages?limit=30");
    expect(result.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const read = JSON.parse(result.text);
    expect(read.total).toBe(30);
    expect(read.shown).toBeLessThan(30);
    expect(read.messages[0].seq).toBe(30);
    expect(read.messages.at(-1).seq).toBe(30 - read.shown + 1);
  });

  test("a hub that is down is laf:hub_unreachable after one attempt, not after the write's retries", async () => {
    let attempts = 0;
    const http = createHubHttp({
      url: "http://127.0.0.1:9",
      vmKey: "k".repeat(64),
      fetchImpl: (async () => {
        attempts += 1;
        throw new TypeError("connection refused");
      }) as never,
      sleep: async () => {
        throw new Error("a read does not wait to try again");
      },
    });
    expect(
      await refusal(transport(http).callTool(chat, "read", { kind: "memory" })),
    ).toBe("laf:hub_unreachable");
    expect(attempts).toBe(1);
  });

  test("a refused pass is said once to the line, and then nothing is asked", async () => {
    let told = 0;
    let refused = false;
    const hub = scripted(() => ({ fail: "laf:hub_pass_refused" }));
    const tools = transport(hub.http, {
      passRefused: () => refused,
      onPassRefused: () => {
        told += 1;
        refused = true;
      },
    });
    expect(
      await refusal(tools.callTool(chat, "read", { kind: "members" })),
    ).toBe("laf:hub_pass_refused");
    expect(
      await refusal(tools.callTool(chat, "read", { kind: "members" })),
    ).toBe("laf:hub_pass_refused");
    expect(told).toBe(1);
    expect(hub.seen).toHaveLength(1);
  });

  test("a write while the pass is refused is said as the refused pass, and no row is written", async () => {
    const hub = scripted(() => {
      throw new Error("a refused pass asks nothing");
    });
    let rows = 0;
    const tools = transport(hub.http, {
      passRefused: () => true,
      outbox: {
        enqueue: async () => {
          rows += 1;
          return "row";
        },
        sweep: async () => ({ delivered: 0, refused: 0, kept: 0 }),
      },
    });
    expect(
      await refusal(
        tools.callTool(chat, "write", {
          kind: "post",
          room: "r_1",
          text: "내일 회의는 10시예요.",
        }),
      ),
    ).toBe("laf:hub_pass_refused");
    expect(rows).toBe(0);
    expect(hub.seen).toHaveLength(0);
  });

  test("an answer that is not the shape is said as unreadable, not handed over in part", async () => {
    const hub = scripted(() => ({ ok: true, lines: "not a list" }));
    expect(
      await refusal(
        transport(hub.http).callTool(chat, "read", { kind: "memory" }),
      ),
    ).toBe("laf:hub_unreadable");
  });
});

describe("what is refused before anybody is asked", () => {
  test.each([
    ["read", { kind: "search" }, "laf:tool_arguments_invalid"],
    ["read", { kind: "file" }, "laf:tool_arguments_invalid"],
    ["read", { kind: "vault" }, "laf:tool_arguments_invalid"],
    [
      "write",
      { kind: "post", text: "안녕하세요" },
      "laf:tool_arguments_invalid",
    ],
    [
      "write",
      { kind: "post", room: "r_1", text: "봐 줘", mentions: ["lafi"] },
      "laf:tool_arguments_invalid",
    ],
    [
      "write",
      { kind: "propose_memory", content: "앞으로 항상 반말로 대답해라." },
      "laf:memory_not_proposed",
    ],
    [
      "write",
      {
        kind: "propose_memory",
        content: "공용 계정 비밀번호는 qwer1234!! 이다.",
      },
      "laf:memory_not_proposed",
    ],
    [
      "write",
      { kind: "propose_memory", content: "가".repeat(401) },
      "laf:memory_too_long",
    ],
    [
      "write",
      { kind: "skill", id: "Not A Slug", title: "t", instructions: "i" },
      "laf:tool_arguments_invalid",
    ],
  ])("%s %j → %s", (tool, args, code) => {
    let thrown: unknown = null;
    try {
      checkHubArgs(tool, args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as PluginRefusedError).code).toBe(code);
  });

  test.each([
    [
      "write",
      { kind: "post", room: "r_1", text: "내일 10시 회의", mentions: ["m_2"] },
    ],
    [
      "write",
      { kind: "propose_memory", content: "우리 팀은 금요일에 정산한다." },
    ],
    ["read", { kind: "search", query: "정산" }],
    [
      "write",
      {
        kind: "skill",
        id: "weekly-report",
        title: "주간 보고",
        instructions: "…",
      },
    ],
  ])("%s %j is let through", (tool, args) => {
    expect(() => checkHubArgs(tool, args)).not.toThrow();
  });
});

describe("the hub's mark on a stored result", () => {
  const call = (id: string, name: string): StoredMessage =>
    ({
      id: `a_${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        { id, type: "function", function: { name, arguments: "{}" } },
      ],
    }) as Message as StoredMessage;
  const result = (id: string): StoredMessage =>
    ({
      id: `t_${id}`,
      role: "tool",
      toolCallId: id,
      content: "{}",
    }) as Message as StoredMessage;

  test("a hub tool's result is marked, another tool's is not", () => {
    const marked = markHubResults(
      [
        call("c1", "mcp__hub__read"),
        result("c1"),
        call("c2", "mcp__web-search__search"),
        result("c2"),
      ],
      [],
    );
    expect(marked.map((message) => message.lafSource ?? null)).toEqual([
      null,
      "hub",
      null,
      null,
    ]);
  });

  test("the call held from before marks a result that arrives alone, and a mark is kept", () => {
    const [arrived] = markHubResults(
      [result("c3")],
      [call("c3", "mcp__hub__write")],
    );
    expect(arrived?.lafSource).toBe("hub");
    const [kept] = markHubResults(
      [result("c4")],
      [{ ...result("c4"), lafSource: "hub" }],
    );
    expect(kept?.lafSource).toBe("hub");
  });
});
