import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createScreenViewAudit } from "../src/computer/screen-view";

/**
 * The one row a looked-at screen leaves.
 *
 * `docs/laf/data-lifecycle.md` §5 said, in so many words, that an administrator could watch a Bot's
 * live browser and nothing recorded it. This is the record: who looked at whose Bot's screen, with
 * what role, by which of the two doors — the live socket, or a finished recording read back — and
 * whether it was their own Bot. The owner is recorded too; the payload is what tells the reader
 * which rows are somebody looking at somebody else's logins.
 */

function trail() {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  return { rows, auditStore };
}

const OWNER = "owner-user";

describe("a live screen being watched", () => {
  test("an administrator opening somebody else's Bot leaves one row", async () => {
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => OWNER,
    });

    await audit.opened("bot-1", { id: "manager", role: "admin" });

    expect(rows).toEqual([
      {
        eventType: "computer.screen_viewed",
        targetType: "bot",
        targetId: "bot-1",
        actorUserId: "manager",
        payload: {
          bot: "bot-1",
          source: "live",
          ownerUserId: OWNER,
          own: false,
          viewerRole: "admin",
        },
      },
    ]);
  });

  test("the owner watching their own Bot is recorded, and the row says it is theirs", async () => {
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => OWNER,
    });

    await audit.opened("bot-1", { id: OWNER, role: "user" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ own: true, viewerRole: "user" });
  });

  test("a Bot nobody owns is still somebody's logins, so the row is written", async () => {
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => null,
    });

    await audit.opened("bot-1", { id: "manager", role: "admin" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ ownerUserId: null, own: false });
  });

  test("an owner lookup that fails is not read as the owner watching", async () => {
    // The one outcome that would soften the row is "it was theirs"; an error must not become that.
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => {
        throw new Error("database away");
      },
    });

    await audit.opened("bot-1", { id: OWNER, role: "user" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ ownerUserId: null, own: false });
  });

  test("a trail that cannot be written does not stop the screen opening", async () => {
    const audit = createScreenViewAudit({
      auditStore: {
        insert: async () => {
          throw new Error("trail away");
        },
      },
      ownerOf: async () => OWNER,
    });

    await expect(
      audit.opened("bot-1", { id: "manager", role: "admin" }),
    ).resolves.toBeUndefined();
  });
});

describe("a recording being read back", () => {
  test("one row per recording and reader, however often the panel asks", async () => {
    // The panel reads the recording on every mount and once a second while it is being made; the
    // fact is that one finished recording was looked at, so the second and tenth read add nothing.
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => OWNER,
    });
    const viewer = { id: OWNER, role: "user" as const };

    await audit.replayed("bot-1", viewer, { startedAt: 1_000 });
    await audit.replayed("bot-1", viewer, { startedAt: 1_000 });
    await audit.replayed("bot-1", viewer, { startedAt: 1_000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      source: "demonstration",
      own: true,
    });
  });

  test("a new recording, or a different reader, is a new row", async () => {
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => OWNER,
    });

    await audit.replayed(
      "bot-1",
      { id: OWNER, role: "user" },
      { startedAt: 1 },
    );
    await audit.replayed(
      "bot-1",
      { id: OWNER, role: "user" },
      { startedAt: 2 },
    );
    await audit.replayed(
      "bot-1",
      { id: "manager", role: "admin" },
      { startedAt: 2 },
    );

    expect(rows.map((row) => [row.actorUserId, row.payload.own])).toEqual([
      [OWNER, true],
      [OWNER, true],
      ["manager", false],
    ]);
  });

  test("the once is per Bot: two Bots' recordings are two rows", async () => {
    const { rows, auditStore } = trail();
    const audit = createScreenViewAudit({
      auditStore,
      ownerOf: async () => OWNER,
    });
    const viewer = { id: OWNER, role: "user" as const };

    await audit.replayed("bot-1", viewer, { startedAt: 5 });
    await audit.replayed("bot-2", viewer, { startedAt: 5 });

    expect(rows.map((row) => row.targetId)).toEqual(["bot-1", "bot-2"]);
  });
});
