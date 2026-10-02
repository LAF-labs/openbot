import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { type AuditEventInput, createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * A GRANT DOES NOT OUTLIVE WHAT IT GRANTED.
 *
 * `plugin_grants` is keyed by a name — `<server id>/<tool>` for a tool, the slug for a skill — and
 * cascades only with the Bot. So removing a connector or a skill left its grants standing, naming
 * something that no longer existed, shown on no screen: the page that reports grants a server no
 * longer advertises reads them off the server's own row, and there was none. The NEXT thing made
 * under that name then arrived already granted — a different server added under an old id, since a
 * custom server's id is the administrator's to choose; a skill written later under the same slug,
 * with whatever its new author put in it — on every Bot that used to hold the old one, with nobody
 * granting anything and no row in the trail saying a grant had been made.
 *
 * From upstream OpenBot (#572 for a server, #563 for a skill; MIT).
 *
 * NOTHING HERE REACHES A VENDOR: the server rows are written directly, so no listing is asked for,
 * and removal makes no call out.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_grant_removal_${suite}`;
const otherBotId = `agent_grant_removal_other_${suite}`;
const by = `admin-${suite}@laf.test`;

const goneServer = `plugtest-gone-${suite}`;
const keptServer = `plugtest-kept-${suite}`;
/** A name the removed one is a prefix of: `split_part`, not `LIKE`, is what keeps this one. */
const longerServer = `${goneServer}-two`;
const goneRef = `${goneServer}/search_things`;
/** Held, and no longer advertised: a grant the tool list cannot find and the removal still must. */
const withdrawnRef = `${goneServer}/withdrawn_tool`;
const keptRef = `${keptServer}/search_things`;
const longerRef = `${longerServer}/search_things`;

const goneSkill = `standup-${suite}`;
const keptSkill = `kept-${suite}`;

/** Every row the store wrote to the trail, so a removal's own row can be read without a query. */
const events: AuditEventInput[] = [];
const persisting = createAuditStore(database);

const store = createPluginStore({
  database,
  auditStore: {
    insert: async (event) => {
      events.push(event);
      await persisting.insert(event);
    },
  },
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ deny: [], ask: [], allow: ["true"] }),
  approvals: createApprovalRegistry(),
  callVendor: async () => {
    throw new Error("nothing in this file calls a vendor");
  },
});

async function addServer(id: string) {
  await database
    .insert(mcpServers)
    .values({
      id,
      title: `Grant removal ${id}`,
      vendor: "mcp.test.invalid",
      url: "https://mcp.test.invalid/mcp",
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId: id,
      name: "search_things",
      description: "Search things.",
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();
}

/** What this suite's Bots hold, as the table has it. Sorted here: the database's collation is its own. */
async function held(kind: "mcp" | "skill") {
  const rows = await database
    .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
    .from(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, kind),
        inArray(pluginGrants.agentId, [botId, otherBotId]),
      ),
    );
  return rows.map((row) => `${row.ref} @ ${row.agentId}`).sort();
}

/** The tools a run would be offered, by ref. */
const offered = async (agentId: string) =>
  (await store.listForAgent(agentId)).tools.map((tool) => tool.ref).sort();

beforeAll(async () => {
  for (const id of [botId, otherBotId]) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, [botId, otherBotId]));
  // The tool rows cascade with their server.
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [goneServer, keptServer, longerServer]));
  await database
    .delete(skills)
    .where(inArray(skills.slug, [goneSkill, keptSkill]));
  await database.delete(agents).where(inArray(agents.id, [botId, otherBotId]));
  await database.$client.close();
});

describe("removing a connector", () => {
  test("takes its grants with it, and no other connector's", async () => {
    for (const id of [goneServer, keptServer, longerServer]) {
      await addServer(id);
    }
    await store.grant("mcp", goneRef, botId, by);
    await store.grant("mcp", goneRef, otherBotId, by);
    await store.grant("mcp", withdrawnRef, botId, by);
    await store.grant("mcp", keptRef, botId, by);
    await store.grant("mcp", longerRef, botId, by);

    events.length = 0;
    await store.removeServer(goneServer, by);

    expect(await held("mcp")).toEqual(
      [`${keptRef} @ ${botId}`, `${longerRef} @ ${botId}`].sort(),
    );

    // The trail says what went and from whom: these grants were each made by a row of their own,
    // and a release nobody recorded would leave the trail saying a Bot still holds them.
    const removal = events.find(
      (event) => event.payload.change === "mcp_server_removed",
    );
    expect(removal?.payload).toEqual({
      actor: by,
      change: "mcp_server_removed",
      server: goneServer,
      releasedGrants: [goneRef, withdrawnRef],
      bots: [botId, otherBotId],
    });
  });

  test("a server added later under the same name is granted to nobody", async () => {
    // A different server, as far as anybody can tell: the id is the administrator's to choose.
    await addServer(goneServer);

    expect(await store.decide("mcp", goneRef, botId)).toEqual({
      allowed: false,
      reason: "laf:tool_not_granted",
    });
    expect(await offered(botId)).toEqual([keptRef, longerRef].sort());
    expect(await offered(otherBotId)).toEqual([]);
  });

  test("a connector nobody was granted is removed with nothing to say about grants", async () => {
    events.length = 0;
    await store.removeServer(goneServer, by);

    const removal = events.find(
      (event) => event.payload.change === "mcp_server_removed",
    );
    expect(removal?.payload).toEqual({
      actor: by,
      change: "mcp_server_removed",
      server: goneServer,
    });
  });
});

describe("uninstalling a skill", () => {
  const write = (slug: string, instructions: string) =>
    store.installSkill({
      slug,
      title: slug,
      summary: "For a test.",
      instructions,
      ownerUserId: null,
      by,
    });

  test("takes its grants with it, and no other skill's", async () => {
    await write(goneSkill, "The first author's standup.");
    await write(keptSkill, "Another skill.");
    await store.grant("skill", goneSkill, botId, by);
    await store.grant("skill", goneSkill, otherBotId, by);
    await store.grant("skill", keptSkill, botId, by);

    events.length = 0;
    await store.uninstallSkill(goneSkill, by);

    expect(await held("skill")).toEqual([`${keptSkill} @ ${botId}`]);

    const removal = events.find(
      (event) => event.payload.change === "skill_uninstalled",
    );
    expect(removal?.payload).toEqual({
      actor: by,
      change: "skill_uninstalled",
      skill: goneSkill,
      bots: [botId, otherBotId],
    });
  });

  test("a skill written later under the same name is on no Bot", async () => {
    await write(goneSkill, "Somebody else's words, under the old name.");

    expect(await store.decide("skill", goneSkill, botId)).toEqual({
      allowed: false,
      reason: "laf:skill_not_granted",
    });
    // What a run is told. The second author's instructions were on both Bots at once.
    expect(
      (await store.listForAgent(botId)).skills.map((skill) => skill.slug),
    ).toEqual([keptSkill]);
    expect((await store.listForAgent(otherBotId)).skills).toEqual([]);
    expect(
      await store.viewSkill({ slug: goneSkill, agentId: otherBotId }),
    ).toEqual({ allowed: false, reason: "laf:skill_not_granted" });
  });
});
