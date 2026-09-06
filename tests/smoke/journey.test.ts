import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * One journey through a running deployment, over HTTP.
 *
 * Every other test in this repository proves a decision in isolation. This one proves the parts are
 * wired to each other: the server reaches the account's computer, the gateway decides before the
 * browser acts, the browser acts, the trail records it, and a question raised in the middle can be
 * answered on the approvals surface and the same action then completes. Nearly every defect worth
 * catching late lives in those joins rather than inside any one of them.
 *
 * IT SERVES ITS OWN PAGE. The journey used to drive example.com, which made a test of this
 * deployment's wiring depend on somebody else's website and gave it nothing worth clicking. The
 * fixture below is a shop's confirm page with a 결제하기 button on it — the exact thing the shipped
 * boundary asks about — served from this process, so the run is deterministic and the click is one
 * a real deployment would stop for.
 *
 * Not part of `bun run test`. It needs a deployment that is actually up, with Docker, so it is asked
 * for by name:
 *
 *   bash scripts/start.sh
 *   bun run test:smoke
 *
 * `LAF_API_URL` points it at a deployment on other ports. Without `LAF_SMOKE` the file is skipped,
 * so `bun run test` stays honest on a machine with nothing running. See docs/development.md.
 *
 * IT MAKES ITS OWN BOT AND TAKES IT AWAY AGAIN. It used to drive `risk-analyst`, a Bot the tenant
 * package shipped; the package ships none now — a Bot starts with nothing set and belongs to the
 * person who made it — so a smoke test that assumes one is a smoke test that fails on every
 * deployment for a reason that has nothing to do with the joins it is checking. `LAF_SMOKE_BOT`
 * still names an existing Bot for anybody who would rather it used theirs.
 */

const asked = process.env.LAF_SMOKE === "1";
const API = process.env.LAF_API_URL ?? "http://localhost:3001";
const suppliedBot = process.env.LAF_SMOKE_BOT;

/**
 * How the Bot's browser reaches a page this process is serving.
 *
 * The computer runs in a container and `localhost` there is the container. `host.docker.internal`
 * is Docker's name for the machine outside it. The navigation guard refuses it by NAME — `.internal`
 * is one of the suffixes `net/host-verdict` calls not publicly routable — so the server this run
 * talks to must have `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` (`smoke.yml` sets it; measured on
 * 2026-09-06: without it the Bot is told the address is inside the deployment and gives up). A
 * deployment that runs the computer some other way sets this.
 */
const FIXTURE_HOST =
  process.env.LAF_SMOKE_FIXTURE_HOST ?? "host.docker.internal";

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

/** The Bot this run acts as: the supplied one, or the one made in `beforeAll`. */
let BOT = suppliedBot ?? "";
let createdBotId: string | null = null;

/** The page the Bot is sent to, and the address it is reachable at from inside the container. */
let fixture: ReturnType<typeof Bun.serve> | null = null;
let fixtureUrl = "";

/**
 * A word that exists nowhere but on the fixture page, minted per run.
 *
 * It is what makes the model half of this journey mean anything. A Bot asked for the title of a
 * page could produce "주문 확인" from the URL and the instruction alone and look like it had
 * browsed; it cannot produce this, so an answer carrying it is an answer that came through the
 * computer. It also keeps two runs against the same supplied Bot from sharing an approval
 * fingerprint, since the page address is part of it.
 */
const NONCE = Math.random().toString(36).slice(2, 8).toUpperCase();
const TITLE = `주문 확인 ${NONCE}`;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

type Trail = {
  events: {
    eventType: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }[];
};

const trail = () => json<Trail>("/api/admin/audit-events?limit=50");

beforeAll(async () => {
  if (!asked) return;
  const reachable = await api("/api/capabilities")
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `No deployment is answering at ${API}. Start one with \`bash scripts/start.sh\`, or set LAF_API_URL.`,
    );
  }

  /*
   * The shop page, served by the test.
   *
   * Port 0 so two runs on one machine cannot collide. The button's label is 결제하기, which is the
   * first word in the shipped `MONEY_WORDS` list — this fixture is the reason the assertion further
   * down can be about the boundary a deployment actually gets rather than one the test wrote.
   */
  fixture = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><html lang="ko"><head><meta charset="utf-8">
         <title>${TITLE}</title></head><body>
         <h1>${TITLE}</h1>
         <p id="state">아직 결제하지 않았습니다</p>
         <button id="pay" onclick="document.getElementById('state').textContent='결제 완료'">결제하기</button>
         <button id="back">계속 쇼핑하기</button>
         </body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  });
  fixtureUrl = `http://${FIXTURE_HOST}:${fixture.port}/`;

  if (BOT) return;

  const { agent } = await json<{ agent: { id: string } }>("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name: `Smoke ${Date.now()}`,
      title: "Smoke test",
      roleDescription: "Made by tests/smoke/journey.test.ts. Safe to delete.",
      visibility: "private",
    }),
  });
  BOT = agent.id;
  createdBotId = agent.id;
});

afterAll(async () => {
  fixture?.stop(true);
  // Its own seat back. An account has five, and a smoke run per deploy would eat them all.
  if (!createdBotId) return;
  await api(`/api/agents/${createdBotId}`, { method: "DELETE" }).catch(
    () => null,
  );
});

describe.skipIf(!asked)("a deployment that is up", () => {
  test("answers for itself before anything else is asked of it", async () => {
    const capabilities = await json<{ status: string }>("/api/capabilities");
    expect(capabilities.status).toBe("ok");
  });

  test("has Bots registered with the runtime", async () => {
    const info = await json<{ agents: Record<string, unknown> }>(
      "/api/copilotkit/info",
    );
    expect(Object.keys(info.agents).length).toBeGreaterThan(0);
  });

  test("mints thread ids that say which deployment they came from", async () => {
    const { threadId } = await json<{ threadId: string }>("/api/threads/mint", {
      method: "POST",
    });
    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe.skipIf(!asked)("a Bot acting on its computer", () => {
  test(
    "reaches the page this test is serving, and the trail records it",
    async () => {
      const before = Date.now();
      const result = await json<{ url: string; title: string }>(
        `/api/computers/${BOT}/navigate`,
        { method: "POST", body: JSON.stringify({ url: fixtureUrl }) },
      );
      // Chromium really loaded the page this process served: the title carries this run's nonce,
      // which exists nowhere else.
      expect(result.title).toBe(TITLE);

      // The screenshot proves the computer is really there rather than the navigate being answered
      // from somewhere else.
      const shot = await json<{ base64: string; width: number }>(
        `/api/computers/${BOT}/screenshot`,
      );
      expect(shot.base64.length).toBeGreaterThan(0);
      expect(shot.width).toBeGreaterThan(0);

      const recorded = (await trail()).events.filter(
        (event) =>
          event.eventType.startsWith("computer.") &&
          Date.parse(event.createdAt) >= before - 60_000,
      );
      expect(recorded.length).toBeGreaterThan(0);
      // Attributed to this Bot, not to whichever computer answered.
      expect(recorded.some((event) => event.payload.bot === BOT)).toBe(true);
    },
    COMPUTER_TIMEOUT_MS,
  );

  test(
    "is stopped by the boundary this deployment ships, and completes once somebody says yes",
    async () => {
      /*
       * THE WHOLE POINT OF THE PRODUCT, END TO END, ON THE DEFAULT POLICY.
       *
       * Nothing is written to the policy here: what stops this click is the `ask` list a fresh
       * deployment gets, matching 결제 in the button's accessible name. A test that wrote its own
       * rule first would prove the evaluator works and say nothing about whether a person who
       * installs this is protected.
       */
      await json(`/api/computers/${BOT}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url: fixtureUrl }),
      });

      const snapshot = await json<{
        snapshotId: number;
        elements: { ref: string; name?: string; role: string }[];
      }>(`/api/computers/${BOT}/snapshot`, { method: "POST" });
      const pay = snapshot.elements.find((element) =>
        (element.name ?? "").includes("결제하기"),
      );
      if (!pay) {
        throw new Error(
          `The fixture's 결제하기 button was not in the snapshot: ${JSON.stringify(snapshot.elements).slice(0, 300)}`,
        );
      }

      const asking = await api(`/api/computers/${BOT}/click`, {
        method: "POST",
        body: JSON.stringify({ ref: pay.ref, snapshotId: snapshot.snapshotId }),
      });
      // 409 and not 403: a question, not a refusal. A deployment that collapsed the two would turn
      // every ask rule into a deny rule, which is the failure the ask list exists to prevent.
      expect(asking.status).toBe(409);
      const question = (await asking.json()) as {
        awaitingApproval?: boolean;
        approvalId?: string;
        rule?: string;
        question?: string;
      };
      expect(question.awaitingApproval).toBe(true);
      expect(question.rule).toContain("결제");
      const approvalId = question.approvalId as string;

      // It is waiting on the surface a person would answer it on, and not only in the reply.
      const waiting = await json<{ approvals: { id: string }[] }>(
        `/api/approvals/${BOT}`,
      );
      expect(waiting.approvals.map((one) => one.id)).toContain(approvalId);

      // Somebody says yes, once, on the approvals route.
      await json(`/api/approvals/${BOT}/${approvalId}`, {
        method: "POST",
        body: JSON.stringify({ granted: true }),
      });

      // And the same action, presented with the answer, goes through to Chromium.
      const done = await json<{ action: string; url: string }>(
        `/api/computers/${BOT}/click`,
        {
          method: "POST",
          body: JSON.stringify({
            ref: pay.ref,
            snapshotId: snapshot.snapshotId,
            approvalId,
          }),
        },
      );
      expect(done.action).toBe("click");

      // The page changed, which is what "the action completed" means outside this server.
      const after = await json<{ text: string }>(`/api/computers/${BOT}/read`);
      expect(after.text).toContain("결제 완료");

      // Three rows: it was asked, it was answered, and it was carried out.
      const events = (await trail()).events;
      const mine = (type: string) =>
        events.filter(
          (event) =>
            event.eventType === type &&
            (event.payload.bot === BOT ||
              event.payload.approval === approvalId),
        );
      expect(mine("approval.requested").length).toBeGreaterThan(0);
      expect(mine("approval.granted").length).toBeGreaterThan(0);
      const allowed = mine("computer.action_allowed");
      expect(allowed.length).toBeGreaterThan(0);
      // Who allowed it, recorded — an action carried out on somebody's say-so must say whose.
      expect(
        allowed.some(
          (event) =>
            (event.payload.decision as { approvedBy?: string } | undefined)
              ?.approvedBy !== undefined,
        ),
      ).toBe(true);
    },
    COMPUTER_TIMEOUT_MS,
  );

  test(
    "a No is not softened by a second attempt",
    async () => {
      // The other half of the same journey, and the one that used to be missing: declining has to
      // mean "not this", not "not this second".
      await json(`/api/computers/${BOT}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url: fixtureUrl }),
      });
      const snapshot = await json<{
        snapshotId: number;
        elements: { ref: string; name?: string }[];
      }>(`/api/computers/${BOT}/snapshot`, { method: "POST" });
      const pay = snapshot.elements.find((element) =>
        (element.name ?? "").includes("결제하기"),
      );
      const click = (body: object) =>
        api(`/api/computers/${BOT}/click`, {
          method: "POST",
          body: JSON.stringify(body),
        });

      const asking = await click({
        ref: pay?.ref,
        snapshotId: snapshot.snapshotId,
      });
      expect(asking.status).toBe(409);
      const { approvalId } = (await asking.json()) as { approvalId: string };

      await json(`/api/approvals/${BOT}/${approvalId}`, {
        method: "POST",
        body: JSON.stringify({ granted: false }),
      });

      const again = await click({
        ref: pay?.ref,
        snapshotId: snapshot.snapshotId,
      });
      // Refused outright rather than asked again: a model told no cannot wear somebody down by
      // repeating the request.
      expect(again.status).toBe(403);
      expect((await again.json()).code).toBe("laf:declined_recently");
    },
    COMPUTER_TIMEOUT_MS,
  );
});

/**
 * A model-driven turn, which is the only part of this journey that needs a key.
 *
 * Skipped by name when there is no model, rather than failed: the joins above are worth checking on
 * a deployment that has not been given one, and a suite that goes red for a missing key teaches
 * people to ignore it.
 *
 * Driven through a routine rather than the chat stream, because a routine's run is the same server
 * side tool loop with the same toolkit and it answers on one synchronous request — a smoke test
 * that had to parse an SSE stream to find out whether the Bot did anything would be a test of the
 * parsing.
 */
const withModel = asked && process.env.LAF_SMOKE_MODEL !== "0";

describe.skipIf(!withModel)("a Bot asked to do something", () => {
  test(
    "runs, uses its computer, and leaves a record of what it did",
    async () => {
      const created = await api("/api/routines", {
        method: "POST",
        body: JSON.stringify({
          agentId: BOT,
          name: `smoke-${Date.now()}`,
          instruction: `${fixtureUrl} 페이지를 열고, 제목이 무엇인지 한 문장으로 알려줘. 아무것도 누르지 마.`,
          schedule: { kind: "interval", minutes: 1440 },
        }),
      });
      if (created.status === 501) {
        throw new Error(
          "This deployment cannot run routines, so the model half of the journey cannot be checked.",
        );
      }
      const { routine } = (await created.json()) as { routine: { id: string } };

      try {
        await json(`/api/routines/${routine.id}/run`, { method: "POST" });
        const { runs } = await json<{
          runs: { ok: boolean; error?: string; answer?: string }[];
        }>(`/api/routines/${routine.id}/runs`);

        expect(runs.length).toBeGreaterThan(0);
        const last = runs[0];
        if (!last?.ok) {
          throw new Error(
            `The Bot's run failed: ${last?.error ?? "no reason"}`,
          );
        }
        // It read the page rather than answering from the instruction. The nonce is in the HTML this
        // process served and in nothing the Bot was told, so an answer carrying it went through the
        // computer — which is the join this half of the journey exists to check.
        expect(last.answer ?? "").toContain(NONCE);
      } finally {
        await api(`/api/routines/${routine.id}`, { method: "DELETE" }).catch(
          () => null,
        );
      }
    },
    COMPUTER_TIMEOUT_MS,
  );
});
