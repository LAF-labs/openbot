import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createFleetNotifier, signFleetBody } from "../src/fleet/notify";

/**
 * The notice that decides whether a machine keeps running.
 *
 * The receiver is in another repository, so the envelope is a contract rather than an
 * implementation detail: a byte that moves here is a signature that stops verifying over there, and
 * the failure lands as a fleet that ignores a withdrawal — the account gone, the VM still billed.
 * So the signature is asserted against a value computed OUTSIDE this file rather than by calling
 * the same function twice, which would agree with itself no matter what it did.
 *
 * The other half is what must never happen: this webhook leaves the deployment, and the person it
 * is about has just asked to be forgotten. `at` is injected so the whole body is fixed.
 */

const ORIGIN = "https://example.agent.laf-co.com";
const SECRET = "fleet-secret";
const PSEUDONYM = "deleted-0123456789abcdef";
const AT = new Date("2026-09-03T09:00:00.000Z");

/** Computed with `openssl dgst -sha256 -hmac`, not with the function under test. */
const GOLDEN_BODY =
  '{"event":"account.deleted","origin":"https://example.agent.laf-co.com","actor":"deleted-0123456789abcdef","remainingAccounts":0,"at":"2026-09-03T09:00:00.000Z"}';
const GOLDEN_SIGNATURE =
  "sha256=87e5f2ebc070ddbee206fb3e267921191ea3c47ff662bc557334c69fb7cb5f42";

type Sent = { url: string; headers: Headers; body: string };

function notifierOn(answers: Array<Response | Error>) {
  const sent: Sent[] = [];
  const rows: AuditEventInput[] = [];
  const waits: number[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };

  const notifier = createFleetNotifier({
    webhookUrl: "https://fleet.laf-co.test/hooks/deployments",
    secret: SECRET,
    origin: ORIGIN,
    auditStore,
    now: () => AT,
    // Not a real wait: three attempts with the real backoff would put 1.25 seconds into the suite
    // for a case whose whole point is that nobody is left waiting on it.
    sleep: async (milliseconds) => void waits.push(milliseconds),
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: new Headers(init.headers),
        body: String(init.body),
      });
      const answer = answers[sent.length - 1] ?? answers[answers.length - 1];
      if (answer instanceof Error) throw answer;
      return answer as Response;
    }) as unknown as typeof fetch,
  });

  return { notifier, sent, rows, waits };
}

const ok = () => new Response(null, { status: 204 });
const failing = (status: number) => () => new Response(null, { status });

describe("the notice the fleet acts on", () => {
  test("signs the exact bytes it sends", async () => {
    const { notifier, sent } = notifierOn([ok()]);
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 0,
    });

    const [call] = sent;
    expect(call?.body).toBe(GOLDEN_BODY);
    expect(call?.headers.get("x-laf-signature")).toBe(GOLDEN_SIGNATURE);
    expect(call?.headers.get("x-laf-event")).toBe("account.deleted");
    expect(call?.headers.get("content-type")).toBe("application/json");
    // The receiver verifies over the body it received, so the two have to be the same string.
    expect(signFleetBody(call?.body ?? "", SECRET)).toBe(
      call?.headers.get("x-laf-signature") ?? "",
    );
  });

  test("a different secret produces a different signature", () => {
    // Cheap, and it is the assertion that catches a signature computed over a constant.
    expect(signFleetBody(GOLDEN_BODY, "another-secret")).not.toBe(
      GOLDEN_SIGNATURE,
    );
  });

  test("carries the headcount and no address", async () => {
    const { notifier, sent } = notifierOn([ok()]);
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 3,
    });

    const payload = JSON.parse(sent[0]?.body ?? "{}");
    expect(payload).toEqual({
      event: "account.deleted",
      origin: ORIGIN,
      actor: PSEUDONYM,
      remainingAccounts: 3,
      at: AT.toISOString(),
    });
    /*
     * The whole frame, serialised, searched for the shape of an address. The fleet identifies a
     * customer by origin and this is the one wire on which a person who has just asked to be
     * forgotten could be named — the same test the demonstration recorder gets for passwords.
     */
    const frame = JSON.stringify({
      body: sent[0]?.body,
      headers: [...(sent[0]?.headers ?? new Headers())],
    });
    expect(frame).not.toContain("@");
  });

  test("says it was told, in a row that holds no body", async () => {
    const { notifier, rows } = notifierOn([ok()]);
    await notifier.notify({
      event: "account.created",
      actor: "user-42",
      remainingAccounts: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("fleet.notified");
    expect(rows[0]?.targetType).toBe("fleet");
    expect(rows[0]?.targetId).toBe(ORIGIN);
    expect(rows[0]?.actorUserId).toBe("user-42");
    expect(rows[0]?.payload).toEqual({
      event: "account.created",
      status: "204",
      attempts: 1,
      remainingAccounts: 1,
    });
  });
});

describe("a fleet that cannot be reached", () => {
  test("tries three times, backs off, and does not throw", async () => {
    const { notifier, sent, rows, waits } = notifierOn([failing(503)()]);

    // The assertion is the absence of a rejection: the rows are already gone by the time this runs.
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 0,
    });

    expect(sent).toHaveLength(3);
    expect(waits).toEqual([250, 1_000]);
    expect(rows[0]?.eventType).toBe("fleet.notify_failed");
    expect(rows[0]?.payload).toMatchObject({ status: "503", attempts: 3 });
  });

  test("retries a connection that never opened", async () => {
    const { notifier, sent, rows } = notifierOn([
      new Error("connection refused"),
    ]);
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 0,
    });

    expect(sent).toHaveLength(3);
    expect(rows[0]?.eventType).toBe("fleet.notify_failed");
    expect(rows[0]?.payload).toMatchObject({ status: "unreachable" });
  });

  test("gives up at once on a refusal it would only repeat", async () => {
    /*
     * A 401 is the fleet reading the notice and rejecting it — a signature it cannot verify, an
     * origin it has never heard of. The identical bytes twice more change nothing and the person
     * who pressed delete is waiting on this, so the row is written on the first answer.
     */
    const { notifier, sent, rows, waits } = notifierOn([failing(401)()]);
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 0,
    });

    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(rows[0]?.eventType).toBe("fleet.notify_failed");
    expect(rows[0]?.payload).toMatchObject({ status: "401", attempts: 1 });
  });

  test("succeeds on a retry and records the attempt it took", async () => {
    const { notifier, sent, rows } = notifierOn([failing(500)(), ok()]);
    await notifier.notify({
      event: "account.deleted",
      actor: PSEUDONYM,
      remainingAccounts: 0,
    });

    expect(sent).toHaveLength(2);
    expect(rows[0]?.eventType).toBe("fleet.notified");
    expect(rows[0]?.payload).toMatchObject({ attempts: 2, status: "204" });
  });

  test("an audit trail that is down does not fail the notice either", async () => {
    const notifier = createFleetNotifier({
      webhookUrl: "https://fleet.laf-co.test/hooks/deployments",
      secret: SECRET,
      origin: ORIGIN,
      now: () => AT,
      sleep: async () => undefined,
      auditStore: {
        insert: async () => {
          throw new Error("audit_events is unavailable");
        },
      },
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });

    await expect(
      notifier.notify({
        event: "account.deleted",
        actor: PSEUDONYM,
        remainingAccounts: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
