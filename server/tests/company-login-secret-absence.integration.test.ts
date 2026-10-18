import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ComputerClient } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { SnapshotResult } from "../src/computer/schema";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  hubOutbox,
  hubVaultOrigins,
  lafThreadMessages,
} from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import {
  companyLoginResult,
  createCompanyVault,
  noteVaultOrigins,
  vaultOriginsUsed,
} from "../src/hub/vault";
import { recentLines } from "../src/log";
import { appendMessages, messagesFor } from "../src/runner/thread-store";
import { HISTORY_PAGE, historyPage } from "../src/turns/history";
import { TEST_POOL } from "./support/database";

/**
 * WHAT IS KEPT AFTER A COMPANY LOGIN WENT INTO A PAGE, against a real Postgres: the trail's rows,
 * the conversation as the next turn and a window read it, the hub outbox, and the server's log —
 * serialised whole, with the company login's two values nowhere in any of it. The product's rule
 * for a value a person typed (CLAUDE.md, "Never record what somebody typed"; the same test for a
 * person's secret is `thread-secret-absence.integration.test.ts`), held for the value that came
 * from the hub.
 *
 * The run is the whole of one: a fill, a sign-in looked at, a busy answer, a hub that stopped
 * answering, and the run's end that gives the lease back and reports the device. The hub is a
 * script answering as #258 does; the outbox is the real one, on the same hub caller, so a vault
 * call that went through it would be a row here.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const WHO = "company-user-CANARY-4410";
const PASSWORD = "C0mpany!Pass-CANARY-2287";
/** Its own host, so this file's row in `hub_vault_origins` is its own to clean up. */
const ORIGIN = `https://seller-${randomUUID().slice(0, 8)}.example`;

const threadIds: string[] = [];

afterAll(async () => {
  // Scoped to what this file made. The trail is append-only, and its rows stay with the test
  // database, which is made afresh on every run.
  for (const threadId of threadIds) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  await database
    .delete(hubVaultOrigins)
    .where(eq(hubVaultOrigins.origin, ORIGIN));
  await database.$client.close();
});

const LOGIN_PAGE: SnapshotResult = {
  snapshotId: 3,
  url: `${ORIGIN}/login`,
  title: "Login",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "아이디" },
    { ref: "e2", role: "textbox", name: "비밀번호", type: "password" },
  ],
};

function scriptedHub() {
  const requests: HubRequest[] = [];
  const state = { down: false, busy: false };
  let leases = 0;
  const http: HubHttp = {
    request: async <T>(request: HubRequest): Promise<HubAnswer<T>> => {
      requests.push(request);
      if (state.down) {
        return { ok: false, status: null, code: "laf:hub_unreachable" };
      }
      const [, , , action] = request.path.split("/");
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, body }) as HubAnswer<T>;
      if (request.path === "/vault") {
        return ok({
          ok: true,
          logins: [
            {
              id: "shop",
              label: "공용 쇼핑몰",
              site: null,
              origins: [ORIGIN],
              canUse: true,
              concurrent: false,
            },
          ],
        });
      }
      if (action === "lease") {
        if (state.busy) {
          return { ok: false, status: 409, code: "laf:vault_busy" };
        }
        leases += 1;
        return ok({
          ok: true,
          lease: `${"b".repeat(63)}${leases}`,
          until: new Date(Date.now() + 600_000).toISOString(),
          concurrent: false,
        });
      }
      if (action === "open") {
        return ok({ ok: true, username: WHO, password: PASSWORD });
      }
      return ok({ ok: true });
    },
    socket: () => ({ url: "ws://hub.invalid/events", headers: {} }),
  };
  return { http, requests, state };
}

describe("a run that signed in with a company login", () => {
  test("leaves neither value in the trail, the conversation, the outbox or the log — and the page did get them", async () => {
    const logsFrom = recentLines.lines().length;
    const person = `owner-${randomUUID()}`;
    const threadId = `thread-company-${randomUUID()}`;
    threadIds.push(threadId);
    const actor = { id: person, userId: person, threadId };
    const hub = scriptedHub();
    // The real outbox, on the same caller: anything written for the hub to keep is a row in it.
    const outbox = createHubOutbox({ database, http: hub.http });
    const outboxBefore = await database.select().from(hubOutbox);

    const pageGot: string[] = [];
    let page = LOGIN_PAGE;
    const client = {
      snapshot: async () => page,
      control: async () => ({
        holder: "bot",
        since: "2026-10-16T00:00:00.000Z",
        requested: false,
      }),
      whereFields: async (refs: string[]) => ({
        fields: refs.map((ref) => ({
          ref,
          origin: ORIGIN,
          kind: ref === "e2" ? ("password" as const) : ("text" as const),
        })),
      }),
      fillLogin: async (fields: { value: string }[]) => {
        pageGot.push(...fields.map((field) => field.value));
        return { filled: true, fields: fields.length, url: page.url };
      },
      runEnded: async () => ({ ended: true, closed: 1 }),
      forBot() {
        return client;
      },
    } as unknown as ComputerClient;
    const gateway = createComputerGateway({
      client,
      auditStore: createAuditStore(database),
      policy: () => ({ deny: [], ask: [], allow: ["true"] }),
      companyLogins: {
        vault: createCompanyVault({ http: hub.http }),
        noteOrigins: (origins) => noteVaultOrigins(database, origins),
      },
    });
    const ask = async (login?: string) => {
      page = LOGIN_PAGE;
      await gateway.snapshot("bot-1");
      return gateway.requestSecret("bot-1", "bot-1", actor, {
        fields: [
          { ref: "e1", label: "아이디" },
          { ref: "e2", label: "비밀번호" },
        ],
        snapshotId: 3,
        ...(login ? { login } : {}),
      });
    };

    // The same site asked while another VM holds it, and again with the hub gone (the company
    // login named: unnamed, the sign-in would go on without it); then filled, signed in, and the
    // run ends.
    const ready = await ask();
    hub.state.busy = true;
    const busy = await ask();
    hub.state.busy = false;
    hub.state.down = true;
    const gone = await ask("company:shop");
    hub.state.down = false;
    const filled = await ask();
    page = {
      snapshotId: 4,
      url: `${ORIGIN}/orders`,
      title: "Orders",
      truncated: false,
      elements: [{ ref: "f1", role: "link", name: "주문" }],
    };
    await gateway.snapshot("bot-1");
    await gateway.runEnded("bot-1", threadId);
    await outbox.sweep();

    expect(filled.loginFilled?.company).toBe(true);
    expect(busy.loginBusy?.id).toBe("company:shop");
    expect(gone.companyLoginUnavailable).toBe(true);
    // The canaries are real: the page was handed both.
    expect(ready.loginFilled?.company).toBe(true);
    expect(pageGot).toEqual([WHO, PASSWORD, WHO, PASSWORD]);

    // The conversation as a turn files it: each call, and what the Bot was told.
    const history = [ready, busy, gone, filled].flatMap((answer, index) => {
      const id = `call-${index}`;
      return [
        {
          id: `assistant-${id}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id,
              type: "function",
              function: {
                name: "computer_request_secret",
                arguments: JSON.stringify({
                  fields: [{ ref: "e1" }, { ref: "e2" }],
                  snapshotId: 3,
                }),
              },
            },
          ],
        },
        {
          id: `tool-${id}`,
          role: "tool",
          toolCallId: id,
          content: JSON.stringify(companyLoginResult(answer)),
        },
      ] as Message[];
    });
    await appendMessages(database, threadId, history);
    const forTheModel = await messagesFor(database, threadId);
    const forAWindow = await historyPage(database, threadId, {
      before: null,
      limit: HISTORY_PAGE,
    });
    const trail = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, person));
    const outboxAfter = await database.select().from(hubOutbox);
    const originsKept = await database.select().from(hubVaultOrigins);
    // The site is kept for leaving the company, once however often it was filled.
    expect(await vaultOriginsUsed(database)).toContain(ORIGIN);
    expect(
      originsKept
        .filter((row) => row.origin === ORIGIN)
        .map((row) => row.origin),
    ).toEqual([ORIGIN]);

    // Something was written in each place, so their silence below is not an empty record.
    expect(
      trail.some((row) => row.payload.action === "computer_fill_login"),
    ).toBe(true);
    expect(forTheModel.length).toBe(8);
    // Nothing was queued for the hub: not the lease, not its release, not the device.
    expect(outboxAfter.length).toBe(outboxBefore.length);

    const everything = JSON.stringify([
      trail,
      forTheModel,
      forAWindow.messages,
      outboxAfter,
      originsKept,
      recentLines.lines().slice(logsFrom),
      hub.requests,
      [ready, busy, gone, filled],
    ]);
    for (const secret of [WHO, PASSWORD]) {
      expect(everything).not.toContain(secret);
    }
    // And the run gave the lease back and told the hub of the device.
    expect(
      hub.requests.filter((one) => one.path.endsWith("/release")),
    ).toHaveLength(1);
    expect(
      hub.requests.filter((one) => one.path.endsWith("/verified")),
    ).toHaveLength(1);
  });
});
