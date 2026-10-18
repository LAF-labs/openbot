import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { put } from "../../hub/tests/support/files";
import {
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "../../hub/tests/support/hub";
import { call } from "../../hub/tests/support/write";
import { createDatabase } from "../src/db/client";
import { hubOutbox } from "../src/db/schema";
import {
  createHubHttp,
  type HubAnswer,
  type HubHttp,
  type HubRequest,
} from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import { createHubToolTransport } from "../src/hub/tools";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
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
const chat = {
  url: "https://hub.example",
  botId: "bot_1",
  drawnOn: "conversation" as const,
};

async function rowOf(id: string) {
  const [row] = await database
    .select()
    .from(hubOutbox)
    .where(inArray(hubOutbox.id, [id]));
  return row;
}

/** A query of this database blocked on a row lock — the tool's read, waiting out an attempt. */
async function somebodyWaitsOnALock() {
  const rows = (await database.execute(sql`
    select 1 from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'
  `)) as unknown as unknown[];
  return rows.length > 0;
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

  test("a 라피's answer to a room question goes under that question's id as its run, and the body is the room's own shape", async () => {
    const { tools } = hubAnswering(() => took);
    await tools.callTool(chat, "write", {
      kind: "post",
      room: "r_1",
      text: "오늘은 16일이에요.",
      mentions: [],
      replyTo: 3,
    });
    const [request] = sent.slice(-1);
    expect(request?.run).toBe("room:r_1:3");
    expect(request?.body).toEqual({
      text: "오늘은 16일이에요.",
      mentions: [],
      as: "bot",
    });
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
        id: "bot_1",
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

  test("a write whose answer is still on its way when the wait ends gets the hub's answer, not kept", async () => {
    let asked = () => {};
    const inFlight = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let answer = (_answer: HubAnswer<unknown>) => {};
    const http: HubHttp = {
      request(request) {
        sent.push(request);
        asked();
        return new Promise((resolve) => {
          answer = resolve as never;
        });
      },
      socket: () => ({ url: "ws://unused", headers: {} }),
    };
    const outbox = createHubOutbox({ database, http, sleep: async () => {} });
    const tools = createHubToolTransport({
      http,
      outbox,
      database,
      // The wait ends the moment the attempt is out, with the hub's answer still held.
      sleep: () => inFlight,
    });
    let settled = false;
    const outcome = tools
      .callTool(chat, "write", {
        kind: "post",
        room: "r_gone",
        text: "내일 회의는 10시예요.",
      })
      .then(
        (result) => ({ said: JSON.parse(result.text) }),
        (error) => ({ code: (error as PluginRefusedError).code }),
      )
      .finally(() => {
        settled = true;
      });
    await inFlight;
    // The hub answers only once the tool has read the row: waiting on its lock, or done without.
    while (!settled && !(await somebodyWaitsOnALock())) await Bun.sleep(5);
    answer({ ok: false, status: 404, code: "laf:hub_not_found" });

    expect(await outcome).toEqual({ code: "laf:hub_not_found" });
    const row = await rowOf(sent[0]?.idempotencyKey ?? "");
    expect(row?.refusedAt).not.toBeNull();
    // Its sweep ended here, so it cannot take the next test's row to a hub that never answers.
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

/**
 * The same two tools against the real hub of `hub/` — served on port 0 against a database of its
 * own — so the paths, bodies and answers are the ones the hub's routes take and give, not a script
 * of them. Written after a proposal's evidence id went as `null` and every proposal was refused.
 */
describe("against the real hub", () => {
  let hub: TestHub;
  const staff = { pass: newPass(), id: "" };
  const admin = { pass: newPass(), id: "" };
  const colleague = { pass: newPass(), id: "" };

  beforeAll(async () => {
    hub = await startTestHub();
    staff.id = (
      await putMember(hub, {
        email: "staff@laf.test",
        name: "김",
        vmOrigin: "https://staff.agent.test",
        pass: staff.pass,
      })
    ).id;
    admin.id = (
      await putMember(hub, {
        email: "admin@laf.test",
        role: "admin",
        vmOrigin: "https://admin.agent.test",
        pass: admin.pass,
      })
    ).id;
    colleague.id = (
      await putMember(hub, {
        email: "colleague@laf.test",
        vmOrigin: "https://colleague.agent.test",
        pass: colleague.pass,
      })
    ).id;
  });

  afterAll(async () => {
    await hub.stop();
  });

  /** The staff member's VM: its pass, its outbox on this Postgres, its two tools. */
  function staffVm() {
    const http = createHubHttp({
      url: hub.url,
      vmKey: staff.pass,
      sleep: async () => {},
    });
    const outbox = createHubOutbox({ database, http, sleep: async () => {} });
    const enqueue = outbox.enqueue;
    outbox.enqueue = async (write) => {
      const id = await enqueue(write);
      made.push(id);
      return id;
    };
    return createHubToolTransport({
      http,
      outbox,
      database,
      sleep: () => new Promise<void>(() => {}),
    });
  }

  test("a proposed line reaches the hub and waits for an admin, with where it came from", async () => {
    const result = await staffVm().callTool(chat, "write", {
      kind: "propose_memory",
      content: "우리 팀은 금요일 오후에 정산한다.",
      evidence: "정산은 금요일 오후에 해요",
    });
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "propose_memory",
      sent: true,
    });
    const waiting = await call(hub, admin.pass, "GET", "/memory/proposals");
    expect(waiting.body.proposals).toEqual([
      expect.objectContaining({
        content: "우리 팀은 금요일 오후에 정산한다.",
        proposedBy: staff.id,
        evidence: {
          kind: "chat",
          id: "bot_1",
          excerpt: "정산은 금요일 오후에 해요",
        },
      }),
    ]);
  });

  test("a team skill as long as the hub takes goes up, and reads back as whole JSON that says it is cut", async () => {
    const tools = staffVm();
    const instructions = `${"가".repeat(19_999)}끝`;
    const sent = await tools.callTool(chat, "write", {
      kind: "skill",
      id: "weekly-report",
      title: "주간 보고",
      summary: "금요일에 한 주를 정리한다",
      instructions,
    });
    expect(JSON.parse(sent.text).sent).toBe(true);

    const listed = JSON.parse(
      (await tools.callTool(chat, "read", { kind: "skill" })).text,
    );
    expect(listed.skills).toEqual([
      {
        slug: "weekly-report",
        title: "주간 보고",
        summary: "금요일에 한 주를 정리한다",
      },
    ]);
    const read = await tools.callTool(chat, "read", {
      kind: "skill",
      id: "weekly-report",
    });
    expect(read.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const skill = JSON.parse(read.text);
    expect(skill.skill.title).toBe("주간 보고");
    expect(instructions.startsWith(skill.skill.instructions)).toBe(true);
    expect(skill.total).toBe(instructions.length);
    expect(skill.shown).toBeLessThan(skill.total);
  });

  test("search finds a team file, and its text is read on from where the last range ended", async () => {
    const tools = staffVm();
    const text = `월말 정산서 ${"😀".repeat(9_000)} 마지막`;
    const file = await put(hub, staff.pass, {
      meta: { name: "월말 정산서.txt" },
      text,
      bytes: randomUUID(),
    });
    const found = JSON.parse(
      (await tools.callTool(chat, "read", { kind: "search", query: "정산서" }))
        .text,
    );
    expect(found.hits.map((hit: { id: string }) => hit.id)).toContain(file.id);

    const first = JSON.parse(
      (await tools.callTool(chat, "read", { kind: "file", id: file.id })).text,
    );
    expect(first.next).toBe(8_000);
    const second = JSON.parse(
      (
        await tools.callTool(chat, "read", {
          kind: "file",
          id: file.id,
          from: first.next,
        })
      ).text,
    );
    expect(second.next).toBeUndefined();
    expect(first.text + second.text).toBe(text);
  });

  test("a post mentions a colleague of the room, as this person's 라피, and the room reads it back", async () => {
    const tools = staffVm();
    const created = await call(hub, staff.pass, "POST", "/rooms", {
      body: { name: "영업팀", members: [colleague.id] },
    });
    const roomId = (created.body.room as { id: string }).id;
    const rooms = JSON.parse(
      (await tools.callTool(chat, "read", { kind: "room" })).text,
    );
    const room = rooms.rooms.find((one: { id: string }) => one.id === roomId);
    expect(room.members).toContain(colleague.id);

    const posted = await tools.callTool(chat, "write", {
      kind: "post",
      room: roomId,
      text: "내일 회의는 10시예요.",
      mentions: [colleague.id],
    });
    expect(JSON.parse(posted.text).sent).toBe(true);
    const read = JSON.parse(
      (await tools.callTool(chat, "read", { kind: "room", id: roomId })).text,
    );
    expect(read.messages).toEqual([
      {
        seq: 1,
        by: `bot:${staff.id}`,
        text: "내일 회의는 10시예요.",
        mentions: [colleague.id],
        at: expect.any(String),
      },
    ]);
  });
});
