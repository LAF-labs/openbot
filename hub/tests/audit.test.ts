import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { hubAudit } from "../src/db/schema";
import { startTestHub, type TestHub } from "./support/hub";

let hub: TestHub;
let id = 0;
beforeAll(async () => {
  hub = await startTestHub();
  const [row] = await hub.database
    .insert(hubAudit)
    .values({
      action: "member.joined",
      member: "fleet",
      target: "m_x",
      outcome: "ok",
    })
    .returning({ id: hubAudit.id });
  id = row?.id ?? 0;
});
afterAll(() => hub.stop());

describe("hub_audit", () => {
  test("takes a new row", async () => {
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.id, id));
    expect(rows.map((row) => row.action)).toEqual(["member.joined"]);
  });

  test.each([
    ["an update", sql`update hub_audit set outcome = 'refused'`],
    ["a delete", sql`delete from hub_audit`],
    ["a truncate", sql`truncate hub_audit`],
  ])("refuses %s, and the row is as it was", async (_name, statement) => {
    const refusal = await hub.database.execute(statement).then(
      () => null,
      (error: unknown) => error,
    );
    expect(
      String((refusal as { cause?: unknown })?.cause ?? refusal),
    ).toContain("hub_audit is append-only");
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.id, id));
    expect(rows.map((row) => row.outcome)).toEqual(["ok"]);
  });
});
