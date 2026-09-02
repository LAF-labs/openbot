import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * One journey through a running deployment, over HTTP.
 *
 * Every other test in this repository proves a decision in isolation. This one proves the parts are
 * wired to each other: the server reaches the account's computer, the gateway decides before the
 * browser acts, the browser acts, and the trail records it. Nearly every defect worth catching late
 * lives in those joins rather than inside any one of them.
 *
 * Not part of `bun run test`. It needs a deployment that is actually up, with a model key and
 * Docker, so it is asked for by name:
 *
 *   bash scripts/start.sh
 *   bun run test:smoke
 *
 * `LAF_API_URL` points it at a deployment on other ports. Without `LAF_SMOKE` the file is
 * skipped, so `bun run test` stays honest on a machine with nothing running.
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

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

/** The Bot this run acts as: the supplied one, or the one made in `beforeAll`. */
let BOT = suppliedBot ?? "";
let createdBotId: string | null = null;

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
    "reaches a page through the gateway, and the trail records it",
    async () => {
      const before = Date.now();
      const result = await json<{ url: string; title: string }>(
        `/api/computers/${BOT}/navigate`,
        {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com" }),
        },
      );
      expect(result.url).toContain("example.com");
      expect(result.title).toBe("Example Domain");

      // The screenshot proves the computer is really there rather than the navigate being answered
      // from somewhere else.
      const shot = await json<{ base64: string; width: number }>(
        `/api/computers/${BOT}/screenshot`,
      );
      expect(shot.base64.length).toBeGreaterThan(0);
      expect(shot.width).toBeGreaterThan(0);

      const trail = await json<{
        events: { eventType: string; createdAt: string }[];
      }>("/api/admin/audit-events?limit=25");
      const recorded = trail.events.some(
        (event) =>
          event.eventType.startsWith("computer.") &&
          Date.parse(event.createdAt) >= before - 60_000,
      );
      expect(recorded).toBe(true);
    },
    COMPUTER_TIMEOUT_MS,
  );

  test(
    "is refused by a boundary, and the refusal is recorded with its rule",
    async () => {
      const original = await json<{ policy: unknown }>("/api/computers/policy");
      const rule = 'contains(page.host, "example.com")';

      // The listing nests it under `policy`; the write takes the policy itself.
      await json("/api/computers/policy", {
        method: "PUT",
        body: JSON.stringify({
          mode: "enforce",
          deny: [rule],
          allow: ["true"],
        }),
      });

      try {
        const refused = await api(`/api/computers/${BOT}/navigate`, {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com" }),
        });
        expect(refused.ok).toBe(false);
        expect((await refused.text()).toLowerCase()).toContain("policy");

        const trail = await json<{
          events: { eventType: string; payload: Record<string, unknown> }[];
        }>("/api/admin/audit-events?limit=25");
        const refusal = trail.events.find((event) =>
          event.eventType.includes("refused"),
        );
        expect(refusal).toBeDefined();
      } finally {
        // Whatever this deployment had before, it gets back, including on a failure above.
        await json("/api/computers/policy", {
          method: "PUT",
          body: JSON.stringify(original.policy),
        });
      }
    },
    COMPUTER_TIMEOUT_MS,
  );
});
