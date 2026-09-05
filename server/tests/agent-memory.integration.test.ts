import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createAgentMemoryStore,
  MAX_MEMORY_LENGTH,
  MEMORY_CHARACTER_CAP,
  MemoryFullError,
} from "../src/agents/memory-store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { botPromptMessage } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agentMemories, agentProfiles, agents, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const profileStore = createAgentProfileStore(database, managedEndpoint);
const memoryStore = createAgentMemoryStore(database);
const loadAgents = createRuntimeAgentLoader(database);

const testPrefix = `agent-memory-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

// The development database is shared with the app, so only rows this file made are removed.
afterEach(async () => {
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentMemories)
      .where(eq(agentMemories.agentId, agentId));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser() {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Memory Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" } satisfies AgentActor;
}

async function createCoworker(
  owner: AgentActor,
  visibility: "public" | "private" = "private",
) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Keep the books straight.",
    visibility,
  });
  createdAgentIds.push(profile.id);
  return profile;
}

/**
 * The composed system message this Bot would be sent, for this person.
 *
 * Found by id rather than by position: a person's roster holds more than one Bot and taking the
 * head of the list reads whichever loaded first, against which every assertion passes vacuously.
 *
 * Built here rather than read off the registration, because the prompt is composed per RUN now —
 * one of the things it says is what time it is — and what a person's memories have to reach is the
 * message the endpoint actually receives.
 */
async function standingFor(owner: AgentActor, agentId: string) {
  const loaded = await loadAgents(owner);
  const agent = loaded.find((candidate) => candidate.id === agentId);
  return agent && "profile" in agent
    ? botPromptMessage(agent.profile, {
        mode: "chat",
        now: new Date(),
        timeZone: "Asia/Seoul",
      }).content
    : "";
}

describe("what a Bot remembers", () => {
  test("carries what it learned into the run, in the order it learned it", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);

    await memoryStore.remember(bot.id, owner.id, "Their supplier is Hanil.");
    await memoryStore.remember(bot.id, owner.id, "They close on Sundays.");

    const standing = await standingFor(owner, bot.id);

    expect(standing).toContain("Their supplier is Hanil.");
    expect(standing).toContain("They close on Sundays.");
    // Order is the property: the prompt reads as a history, not as a set.
    expect(standing.indexOf("Hanil")).toBeLessThan(standing.indexOf("Sundays"));
    /*
     * Marked as memory rather than merged into the job. A Bot has to be able to tell what somebody
     * decided from what it worked out, because only the second kind can be wrong.
     */
    expect(standing).toContain("지시가 아니라 네 기억으로");
  });

  /**
   * THE FAILURE THIS MUST NOT HAVE.
   *
   * A deployment is supposed to serve one person, so on a correct one this can never happen. It is
   * asserted anyway because nothing enforces that yet — no allowlist gates sign-in — and because
   * the day one does, this test is what says the scoping was there all along rather than something
   * anybody has to go back and verify.
   */
  test("never carries one person's memory into another person's run", async () => {
    const owner = await createUser();
    const other = await createUser();
    const bot = await createCoworker(owner, "public");

    await memoryStore.remember(
      bot.id,
      owner.id,
      "Their bank is Kookmin, account ending 4417.",
    );

    const loadedForOther = await loadAgents(other);
    const standing = loadedForOther
      .map((agent) =>
        "profile" in agent
          ? botPromptMessage(agent.profile, {
              mode: "chat",
              now: new Date(),
              timeZone: "Asia/Seoul",
            }).content
          : "",
      )
      .join("\n");

    expect(standing).not.toContain("Kookmin");
    expect(standing).not.toContain("4417");
    // And the store agrees, so this is the scoping and not an accident of which Bots loaded.
    expect(await memoryStore.list(bot.id, other.id)).toEqual([]);
  });

  test("forgetting one thing leaves the rest, and cannot be done by somebody else", async () => {
    const owner = await createUser();
    const other = await createUser();
    const bot = await createCoworker(owner, "public");

    const first = await memoryStore.remember(bot.id, owner.id, "Keep this.");
    const second = await memoryStore.remember(bot.id, owner.id, "Forget this.");
    expect(second).not.toBeNull();

    // Somebody else's id is not a key to this row, even though they can see the Bot.
    expect(await memoryStore.forget(second?.id ?? "", other.id)).toBe(false);
    expect(await memoryStore.forget(second?.id ?? "", owner.id)).toBe(true);
    // Forgetting twice is not a second forgetting.
    expect(await memoryStore.forget(second?.id ?? "", owner.id)).toBe(false);

    const left = await memoryStore.list(bot.id, owner.id);
    expect(left.map((memory) => memory.id)).toEqual([first?.id ?? ""]);

    const standing = await standingFor(owner, bot.id);
    expect(standing).toContain("Keep this.");
    expect(standing).not.toContain("Forget this.");
  });

  test("refuses a memory that is empty or too long to be one fact", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);

    expect(await memoryStore.remember(bot.id, owner.id, "   ")).toBeNull();
    expect(
      await memoryStore.remember(
        bot.id,
        owner.id,
        "x".repeat(MAX_MEMORY_LENGTH + 1),
      ),
    ).toBeNull();
    expect(
      await memoryStore.remember(
        bot.id,
        owner.id,
        "x".repeat(MAX_MEMORY_LENGTH),
      ),
    ).not.toBeNull();
  });

  /**
   * THE MEMORY HAS A SIZE, NOT JUST A COUNT.
   *
   * Forty facts of four hundred characters is sixteen thousand characters in front of every turn;
   * the count never said how much prompt the memory was allowed to be. The cap is enforced on the
   * way in, so the Bot is told the moment there is no room — and forgetting one thing makes room
   * again, which is the only way room is ever made, because the Bot cannot forget on its own.
   */
  test("refuses the fact that would not fit, and takes it once something is forgotten", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);

    const kept: string[] = [];
    for (let at = 0; at < 5; at += 1) {
      const memory = await memoryStore.remember(
        bot.id,
        owner.id,
        String(at).repeat(MAX_MEMORY_LENGTH),
      );
      kept.push(memory?.id ?? "");
    }
    // 2,000 used. Three hundred more would pass the cap; two hundred lands exactly on it.
    await expect(
      memoryStore.remember(bot.id, owner.id, "y".repeat(300)),
    ).rejects.toMatchObject({
      name: "MemoryFullError",
      used: 5 * MAX_MEMORY_LENGTH,
      cap: MEMORY_CHARACTER_CAP,
    });
    expect(
      await memoryStore.remember(bot.id, owner.id, "y".repeat(200)),
    ).not.toBeNull();
    await expect(
      memoryStore.remember(bot.id, owner.id, "z"),
    ).rejects.toBeInstanceOf(MemoryFullError);

    // Forgetting is how room is made. A forgotten row no longer counts.
    expect(await memoryStore.forget(kept[0] ?? "", owner.id)).toBe(true);
    expect(
      await memoryStore.remember(bot.id, owner.id, "y".repeat(300)),
    ).not.toBeNull();
  });

  /**
   * THE SNAPSHOT IS TAKEN ONCE PER RUN.
   *
   * The memories a run is composed with are the ones read when the person's roster was loaded
   * for that run, and nothing re-reads them between the turns inside it: a fact the Bot writes
   * mid-run is read by the NEXT run, the same way Hermes injects memory at session start rather
   * than on every turn. The alternative — a prompt that changes under the model between one
   * tool call and the next — is a prompt the eval hashes could never pin, and a memory write
   * that takes effect on the same turn that wrote it.
   */
  test("composes every turn of one run from the memories read at its start", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    await memoryStore.remember(bot.id, owner.id, "Their supplier is Hanil.");

    const loaded = await loadAgents(owner);
    const agent = loaded.find((candidate) => candidate.id === bot.id);
    if (!agent || !("profile" in agent))
      throw new Error("The Bot did not load.");
    const now = new Date();
    const compose = () =>
      botPromptMessage(agent.profile, {
        mode: "chat",
        now,
        timeZone: "Asia/Seoul",
      }).content;

    const first = compose();
    await memoryStore.remember(bot.id, owner.id, "They close on Sundays.");
    const again = compose();

    expect(again).toBe(first);
    expect(again).not.toContain("Sundays");
    // The next run reads the roster again, and the new fact is in it.
    expect(await standingFor(owner, bot.id)).toContain(
      "They close on Sundays.",
    );
  });

  /** A Bot that has learned nothing says nothing about memory, rather than an empty heading. */
  test("says nothing at all when it has learned nothing", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);

    const standing = await standingFor(owner, bot.id);
    expect(standing).not.toContain("네가 알아낸 것들");
  });
});
