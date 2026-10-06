/**
 * The consent pin, end to end against a real database.
 *
 * Three claims, each the contract's own sentence: registration is the consent
 * (first sync lands approved); a definition that changes afterwards loses the
 * consent (paused, refused, re-approvable); and a declaration is believed —
 * read-only runs unasked, everything guarded stops for a person.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { McpTool } from "../src/plugins/mcp";
// Imported for its side effect as much as its value: a static import is evaluated before this
// file's body, so the snapshot inside it is taken before the `mock.module` below replaces anything.
import { realMcpModule } from "./support/mcp-module";

let toolsOnServer: McpTool[] = [];

/**
 * The vendor this suite talks to, which is no vendor at all.
 *
 * `mock.module` is process-wide in bun and it MERGES: every file is evaluated before any test runs,
 * so this replaces `listTools` and `callTool` for the whole run in whatever order the files are
 * listed. Three other suites carry a note about that and answer it by injecting `callVendor`. A
 * suite whose subject IS the transport cannot answer it that way, so this one puts the real module
 * back when it is finished — and installs its own stub again on the way in, in case a suite that
 * needed the real transport ran first.
 */
const stubbedVendor = () => ({
  listTools: async () => toolsOnServer,
  callTool: async () => ({ text: "ok", isError: false, truncated: false }),
  McpServerError: class McpServerError extends Error {},
});

mock.module("../src/plugins/mcp", stubbedVendor);

import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const readOnly: McpTool = {
  name: "orders.list",
  description: "List orders",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const payout: McpTool = {
  name: "payout.send",
  description: "Send a payout",
  inputSchema: { type: "object" },
  annotations: { "x-laf/effect": "money" },
};

describeDb("plugin definition consent", () => {
  const database = createDatabase(databaseUrl ?? "");
  const serverId = `laf-test-${randomUUID().slice(0, 8)}`;
  const actorId = `user-${randomUUID().slice(0, 8)}`;
  const botId = `bot-${randomUUID().slice(0, 8)}`;
  /**
   * Whether the tool a stranded-grant row names was still held when the row was written. The row
   * is the only record of that moment, so it goes in before the tool is deleted; this is how a test
   * sees the order without making a statement fail.
   */
  const heldWhenStrandedWasWritten: boolean[] = [];
  const trail = createAuditStore(database);
  const store = createPluginStore({
    database,
    auditStore: {
      insert: async (event) => {
        const payload = event.payload as { change?: string; refs?: string[] };
        if (payload.change === "grants_not_advertised") {
          for (const ref of payload.refs ?? []) {
            const [server, ...name] = ref.split("/");
            const held = await database
              .select({ name: mcpTools.name })
              .from(mcpTools)
              .where(
                and(
                  eq(mcpTools.serverId, server ?? ""),
                  eq(mcpTools.name, name.join("/")),
                ),
              );
            heldWhenStrandedWasWritten.push(held.length === 1);
          }
        }
        await trail.insert(event);
      },
    },
    credentials: credentialVaultStub({ readSecret: async () => null }),
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
    approvals: createApprovalRegistry(),
  });

  beforeAll(async () => {
    // Again here, not only at load: a suite that needs the real transport restores it, and bun's
    // module mocks are one shared registry for the whole run.
    mock.module("../src/plugins/mcp", stubbedVendor);
    await database.insert(users).values({
      id: actorId,
      name: "Consent Tester",
      email: `${actorId}@test.local`,
      emailVerified: false,
    });
    await database.insert(agents).values({
      id: botId,
      name: "Consent Bot",
      type: "built_in",
      configuration: { systemPrompt: "" },
    });
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Consent Test Server",
      vendor: "test.local",
      url: "https://mcp.test.local/mcp",
      provenance: "custom",
    });
    for (const tool of [readOnly, payout]) {
      await database.insert(pluginGrants).values({
        kind: "mcp",
        ref: `${serverId}/${tool.name}`,
        agentId: botId,
        grantedBy: actorId,
      });
    }
  });

  afterAll(async () => {
    // The door is left as this deployment ships it. Leaving the stub behind is how a suite about
    // the transport itself ends up asserting against a stub of the transport.
    mock.module("../src/plugins/mcp", () => realMcpModule);
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(agents).where(eq(agents.id, botId));
    await database.delete(users).where(eq(users.id, actorId));
    await database.$client.close();
  });

  test("registration is the consent: the first sync lands approved", async () => {
    toolsOnServer = [readOnly, payout];
    const result = await store.refreshTools(serverId);
    expect(result.tools).toBe(2);
    expect(result.paused ?? 0).toBe(0);
    const rows = await database
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId));
    expect(rows.every((row) => row.needsReview === false)).toBe(true);
    expect(rows.every((row) => typeof row.definitionHash === "string")).toBe(
      true,
    );
    const stored = rows.find((row) => row.name === readOnly.name);
    expect(stored?.annotations).toEqual({ readOnlyHint: true });
  });

  test("a believed read-only declaration runs without asking anybody", async () => {
    const result = await store.callTool({
      ref: `${serverId}/${readOnly.name}`,
      args: {},
      botId,
      actorId,
    });
    expect(result.isError).toBe(false);
  });

  test("a money declaration stops for a person even though policy allows", async () => {
    await expect(
      store.callTool({
        ref: `${serverId}/${payout.name}`,
        args: { amount: 10 },
        botId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginNeedsApprovalError);
  });

  test("a changed definition loses the consent and is refused until reviewed", async () => {
    toolsOnServer = [
      { ...readOnly, annotations: { readOnlyHint: false } },
      payout,
    ];
    const result = await store.refreshTools(serverId);
    expect(result.paused).toBe(1);

    await expect(
      store.callTool({
        ref: `${serverId}/${readOnly.name}`,
        args: {},
        botId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const approved = await store.approveToolDefinition(
      serverId,
      readOnly.name,
      actorId,
    );
    expect(approved).toBe(true);

    // Approved as it now is: a declared, non-destructive write. That class has
    // no floor — the written policy decides, and this one allows — so approval
    // restores operation rather than opening a permanent toll gate.
    const restored = await store.callTool({
      ref: `${serverId}/${readOnly.name}`,
      args: {},
      botId,
      actorId,
    });
    expect(restored.isError).toBe(false);
  });

  test("a tool that appears after registration waits for review", async () => {
    toolsOnServer = [
      { ...readOnly, annotations: { readOnlyHint: false } },
      payout,
      {
        name: "orders.export",
        description: "Export",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
    ];
    const result = await store.refreshTools(serverId);
    expect(result.paused).toBe(1);
    const [row] = await database
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId))
      .then((rows) => rows.filter((r) => r.name === "orders.export"));
    expect(row?.needsReview).toBe(true);
    expect(row?.reviewReason).toBe("appeared after registration");
  });

  /*
   * A DEFINITION THAT SHIPS WITH THIS BUILD IS NOT A VENDOR'S (the owner, 2026-10-06). The two
   * tests above are somebody else's server, and stay as they are. Here the server is one whose tool
   * list is this repository's own code — a catalogue adapter, no vendor asked — standing as a
   * previous build left it: one definition different, one tool that did not exist yet.
   *
   * Until this rule, a description edited in a release paused the tool for everybody already
   * connected, and nothing told them (the review of #90 put six definitions back rather than
   * ship that). Only the weather and web-search entries were spared, by a loop of their own.
   */
  describe("a definition that ships with this build", () => {
    const shippedId = "google-business-profile";
    let mine = false;
    const rowsOf = () =>
      database.select().from(mcpTools).where(eq(mcpTools.serverId, shippedId));
    /** The trail's rows about these tools — every one, or only those not seen before. */
    const trailRows = (names: string[]) =>
      database
        .select()
        .from(auditEvents)
        .where(
          inArray(
            auditEvents.targetId,
            names.map((name) => `${shippedId}/${name}`),
          ),
        );
    /*
     * BY IDENTITY, NOT BY THE CLOCK. The rows are stamped by the database, whose clock is a
     * container's; "everything since a moment this process noted" loses a row to a second of drift
     * one run in a few (seen on the first afternoon of this test).
     */
    const newSince = async (names: string[], seen: ReadonlySet<string>) =>
      (await trailRows(names))
        .filter((event) => !seen.has(event.id))
        .map((event) => ({
          what: event.eventType,
          tool: event.targetId?.slice(shippedId.length + 1),
          by: (event.payload as { actor?: string }).actor ?? null,
          change: (event.payload as { change?: string }).change ?? null,
        }))
        .sort((a, b) =>
          `${a.tool} ${a.what}`.localeCompare(`${b.tool} ${b.what}`),
        );

    beforeAll(async () => {
      const made = await database
        .insert(mcpServers)
        .values({
          id: shippedId,
          title: "Google Business Profile",
          vendor: "Google",
          url: "https://mybusiness.googleapis.com/v4",
          provenance: "first-party",
        })
        .onConflictDoNothing()
        .returning({ id: mcpServers.id });
      mine = made.length > 0;
      // The registration: everything this build offers lands approved.
      await store.refreshTools(shippedId);
    });

    afterAll(async () => {
      // Only what this suite made: another suite's row under the same catalogue key is not ours.
      if (mine) {
        await database.delete(mcpServers).where(eq(mcpServers.id, shippedId));
      }
    });

    test("a changed one and a new one are taken as they arrive, each with one row that says the deployment took it", async () => {
      const [changed, appeared] = await rowsOf();
      if (!changed || !appeared) throw new Error("the adapter lists two tools");
      expect([changed.needsReview, appeared.needsReview]).toEqual([
        false,
        false,
      ]);
      await database
        .update(mcpTools)
        .set({ definitionHash: "what-the-last-build-shipped" })
        .where(
          and(
            eq(mcpTools.serverId, shippedId),
            eq(mcpTools.name, changed.name),
          ),
        );
      await database
        .delete(mcpTools)
        .where(
          and(
            eq(mcpTools.serverId, shippedId),
            eq(mcpTools.name, appeared.name),
          ),
        );

      const seen = new Set(
        (await trailRows([changed.name, appeared.name])).map(
          (event) => event.id,
        ),
      );
      const result = await store.refreshTools(shippedId);
      expect(result.paused ?? 0).toBe(0);

      const after = await rowsOf();
      expect(
        after.filter((row) => row.needsReview).map((row) => row.name),
      ).toEqual([]);
      // This build's definition is the one held again, and the new tool is there.
      expect(
        after.find((row) => row.name === changed.name)?.definitionHash,
      ).toBe(changed.definitionHash);
      expect(after.some((row) => row.name === appeared.name)).toBe(true);
      /*
       * One row each, of a kind of its own. Not the pair a person's review leaves — "paused until
       * somebody reviews it", then "approved as it now is" — which on the audit screen read as a
       * tool that stopped and a person who looked, when nothing stopped and nobody did (review of
       * #110).
       */
      expect(await newSince([changed.name, appeared.name], seen)).toEqual(
        [
          {
            what: "mcp.tool_definition_shipped",
            tool: appeared.name,
            by: "deployment",
            change: "appeared",
          },
          {
            what: "mcp.tool_definition_shipped",
            tool: changed.name,
            by: "deployment",
            change: "definition",
          },
        ].sort((a, b) =>
          `${a.tool} ${a.what}`.localeCompare(`${b.tool} ${b.what}`),
        ),
      );
    });

    test("one left waiting by an earlier build is accepted at the next refresh", async () => {
      const [waiting] = await rowsOf();
      if (!waiting) throw new Error("the adapter lists a tool");
      await database
        .update(mcpTools)
        .set({ needsReview: true, reviewReason: "definition changed" })
        .where(
          and(
            eq(mcpTools.serverId, shippedId),
            eq(mcpTools.name, waiting.name),
          ),
        );
      const seen = new Set(
        (await trailRows([waiting.name])).map((event) => event.id),
      );
      await store.refreshTools(shippedId);
      expect((await rowsOf()).filter((row) => row.needsReview)).toEqual([]);
      expect(await newSince([waiting.name], seen)).toEqual([
        {
          what: "mcp.tool_definition_shipped",
          tool: waiting.name,
          by: "deployment",
          change: "waiting",
        },
      ]);
    });

    test("at boot every shipped service is brought up to this build in one pass, and a vendor's is not asked", async () => {
      const [stale] = await rowsOf();
      if (!stale) throw new Error("the adapter lists a tool");
      await database
        .update(mcpTools)
        .set({ definitionHash: "what-the-last-build-shipped" })
        .where(
          and(eq(mcpTools.serverId, shippedId), eq(mcpTools.name, stale.name)),
        );
      // The vendor's server, with something new on it that only a person may accept.
      const vendorBefore = await database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId));
      toolsOnServer = [
        ...toolsOnServer,
        {
          name: "orders.delete",
          description: "Delete",
          inputSchema: {},
          annotations: {},
        },
      ];

      await store.refreshShippedDefinitions();

      const row = (await rowsOf()).find((tool) => tool.name === stale.name);
      expect(row?.definitionHash).toBe(stale.definitionHash);
      expect(row?.needsReview).toBe(false);
      const vendorAfter = await database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId));
      expect(vendorAfter.map((tool) => tool.name).sort()).toEqual(
        vendorBefore.map((tool) => tool.name).sort(),
      );
      // And what a person had not reviewed there is still waiting for one.
      expect(
        vendorAfter.filter((tool) => tool.needsReview).map((tool) => tool.name),
      ).toEqual(
        vendorBefore
          .filter((tool) => tool.needsReview)
          .map((tool) => tool.name),
      );
    });

    test("the pass at boot leaves alone a service this deployment cannot serve right now", async () => {
      /*
       * 알림톡 on a deployment built without the partner's module answers with a stand-in that
       * lists nothing — because nothing can be asked of it, not because the entry offers nothing.
       * Refreshing that would delete the tools a person connected (and write that their grants
       * point at nothing), to put them back at the first boot the module returns.
       */
      const standInId = "kakao-alimtalk";
      const made = await database
        .insert(mcpServers)
        .values({
          id: standInId,
          title: "카카오 알림톡",
          vendor: "Kakao",
          url: "https://api.solapi.com",
          provenance: "first-party",
          toolsRefreshedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: mcpServers.id });
      if (made.length === 0) return; // Another suite's row under the same key is not ours to test on.
      try {
        await database.insert(mcpTools).values({
          serverId: standInId,
          name: "send",
          description: "Send",
          inputSchema: {},
          annotations: {},
          definitionHash: "as-connected",
          needsReview: false,
        });

        await store.refreshShippedDefinitions();

        const kept = await database
          .select({ name: mcpTools.name, hash: mcpTools.definitionHash })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, standInId));
        expect(kept).toEqual([{ name: "send", hash: "as-connected" }]);
      } finally {
        await database.delete(mcpServers).where(eq(mcpServers.id, standInId));
      }
    });
  });

  test("a grant left pointing at nothing goes in the trail as its tool goes, once, and not again at every refresh after", async () => {
    // A boot refreshes every shipped service now; a row at every refresh would be a row at every
    // restart for as long as the grant stood (review of #110).
    const strandedIds = async () =>
      (
        await database
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetId, serverId))
      )
        .filter(
          (event) =>
            (event.payload as { change?: string }).change ===
            "grants_not_advertised",
        )
        .map((event) => ({
          id: event.id,
          refs: (event.payload as { refs?: string[] }).refs,
        }));
    const before = new Set((await strandedIds()).map((row) => row.id));

    // The vendor withdraws the payout tool, which this suite's Bot holds a grant on.
    toolsOnServer = [{ ...readOnly, annotations: { readOnlyHint: false } }];
    await store.refreshTools(serverId);
    const written = (await strandedIds()).filter((row) => !before.has(row.id));
    expect(written.map((row) => row.refs)).toEqual([
      [`${serverId}/${payout.name}`],
    ]);
    // Written while the tool was still held: after the delete there is no second moment, and a
    // refresh that failed just past it would have left the trail nothing (review of #110).
    expect(heldWhenStrandedWasWritten).toEqual([true]);

    await store.refreshTools(serverId);
    expect(
      (await strandedIds()).filter((row) => !before.has(row.id)).length,
    ).toBe(1);
  });
});
