import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { hubOutbox } from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import { createHubToolTransport } from "../src/hub/tools";
import { PluginRefusedError } from "../src/plugins/store";

/**
 * 라피's writes to the company hub, against a real Postgres: each one a `hub_outbox` row before it is
 * a request, so a hub that is down keeps it and a hub that comes back gets it once — with the same
 * key the first attempt carried.
 *
 * The hub is a script, recorded; the outbox's waits between retries are instant, so a sweep against
 * a hub that is down ends at once instead of after ten seconds.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 4 },
);

afterEach(async () => {
  const keys = sent.map((request) => request.idempotencyKey ?? "");
  const rows = [...new Set([...keys, ...made])].filter(Boolean);
  if (rows.length) {
    await database.delete(hubOutbox).where(inArray(hubOutbox.id, rows));
  }
  sent.length = 0;
  made.length = 0;
});

afterAll(async () => {
  await database.$client.close();
});

const sent: HubRequest[] = [];
const made: string[] = [];

function hubAnswering(answer: () => HubAnswer<unknown>) {
  const http: HubHttp = {
    async request(request) {
      sent.push(request);
      return answer() as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  const outbox = createHubOutbox({ database, http, sleep: async () => {} });
  const enqueue = outbox.enqueue;
  outbox.enqueue = async (write) => {
    const id = await enqueue(write);
    made.push(id);
    return id;
  };
  const tools = createHubToolTransport({
    http,
    outbox,
    database,
    // Never resolves: the answer must come from the sweep having finished, not from a timer.
    sleep: () => new Promise<void>(() => {}),
  });
  return { tools, outbox };
}

const down: HubAnswer<unknown> = {
  ok: false,
  status: null,
  code: "laf:hub_unreachable",
};
const took: HubAnswer<unknown> = { ok: true, status: 201, body: { ok: true } };
const chat = { url: "https://hub.example", drawnOn: "conversation" as const };

async function rowOf(id: string) {
  const [row] = await database
    .select()
    .from(hubOutbox)
    .where(inArray(hubOutbox.id, [id]));
  return row;
}

describe("writing to the company hub", () => {
  test("a post goes as this person's 라피, once, with the row's id as its key", async () => {
    const { tools } = hubAnswering(() => took);
    const result = await tools.callTool(chat, "write", {
      kind: "post",
      room: "r_1",
      text: "내일 회의는 10시예요.",
      mentions: ["m_2", "m_2", " "],
    });

    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "post",
      sent: true,
    });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/rooms/r_1/messages");
    expect(request?.origin).toBe("chat");
    expect(request?.body).toEqual({
      text: "내일 회의는 10시예요.",
      mentions: ["m_2"],
      as: "bot",
    });
    expect(made).toEqual([request?.idempotencyKey ?? ""]);
    expect((await rowOf(made[0] ?? ""))?.deliveredAt).not.toBeNull();
  });

  test("a hub that is down keeps the write, the Bot is told not to send it again, and it goes once when the hub is back", async () => {
    let up = false;
    const { tools, outbox } = hubAnswering(() => (up ? took : down));
    const result = await tools.callTool(chat, "write", {
      kind: "propose_memory",
      content: "우리 팀은 금요일 오후에 정산한다.",
      evidence: "정산은 금요일 오후에 해요",
    });

    const said = JSON.parse(result.text);
    expect(said.sent).toBe(false);
    expect(said.note).toContain("다시 보내지 마라");
    const id = made[0] ?? "";
    expect((await rowOf(id))?.deliveredAt).toBeNull();
    const tried = sent.length;
    expect(tried).toBeGreaterThan(0);

    up = true;
    expect(await outbox.sweep()).toEqual({ delivered: 1, refused: 0, kept: 0 });
    expect(await outbox.sweep()).toEqual({ delivered: 0, refused: 0, kept: 0 });
    const delivered = sent.slice(tried);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.idempotencyKey).toBe(id);
    expect(delivered[0]?.path).toBe("/memory/proposals");
    expect(delivered[0]?.body).toEqual({
      content: "우리 팀은 금요일 오후에 정산한다.",
      evidence: {
        kind: "chat",
        id: null,
        excerpt: "정산은 금요일 오후에 해요",
      },
    });
    // Every attempt carried the same key: a hub that took one and lost its answer writes nothing twice.
    expect(new Set(sent.map((request) => request.idempotencyKey))).toEqual(
      new Set([id]),
    );
  });

  test("a write the hub refuses is the hub's fact, and the row is not offered again", async () => {
    const { tools, outbox } = hubAnswering(() => ({
      ok: false,
      status: 403,
      code: "laf:hub_forbidden",
    }));
    let code: string | null = null;
    try {
      await tools.callTool(chat, "write", {
        kind: "skill",
        id: "weekly-report",
        title: "주간 보고",
        instructions: "금요일마다 한 주를 정리한다.",
      });
    } catch (error) {
      if (error instanceof PluginRefusedError) code = error.code;
    }
    expect(code).toBe("laf:hub_forbidden");
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.path).toBe("/skills/weekly-report");
    expect((await rowOf(made[0] ?? ""))?.refusedAt).not.toBeNull();
    await outbox.sweep();
    expect(sent).toHaveLength(1);
  });

  test("a write that meets a refused pass is said as the refused pass, not as kept, and the row waits", async () => {
    const { tools } = hubAnswering(() => ({
      ok: false,
      status: 401,
      code: "laf:hub_pass_refused",
    }));
    let code: string | null = null;
    try {
      await tools.callTool(chat, "write", {
        kind: "post",
        room: "r_1",
        text: "내일 회의는 10시예요.",
      });
    } catch (error) {
      if (error instanceof PluginRefusedError) code = error.code;
    }
    expect(code).toBe("laf:hub_pass_refused");
    // A 401 ends nothing: the row is neither delivered nor refused, for a pass that works.
    const row = await rowOf(made[0] ?? "");
    expect(row?.lastCode).toBe("laf:hub_pass_refused");
    expect(row?.deliveredAt).toBeNull();
    expect(row?.refusedAt).toBeNull();
  });
});
