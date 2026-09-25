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

async function createCoworker(owner: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    roleDescription: "Keep the books straight.",
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
   *
   * The Bot used to be made `public` here so that the second person could see it at all. There is
   * no such thing now — a Bot is its owner's — and the store below is addressed by id rather than
   * through a roster, which is the stronger form of the same question: somebody holding the id
   * still gets nothing of the owner's.
   */
  test("never carries one person's memory into another person's run", async () => {
    const owner = await createUser();
    const other = await createUser();
    const bot = await createCoworker(owner);

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
    const bot = await createCoworker(owner);

    const first = await memoryStore.remember(bot.id, owner.id, "Keep this.");
    const second = await memoryStore.remember(bot.id, owner.id, "Forget this.");
    expect(second).not.toBeNull();

    // Somebody else's id is not a key to this row, even though they can see the Bot.
    expect(await memoryStore.forget(second?.id ?? "", other.id)).toBeNull();
    expect(await memoryStore.forget(second?.id ?? "", owner.id)).toEqual({
      agentId: bot.id,
      line: "Forget this.",
    });
    // Forgetting twice is not a second forgetting.
    expect(await memoryStore.forget(second?.id ?? "", owner.id)).toBeNull();

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
    expect(await memoryStore.forget(kept[0] ?? "", owner.id)).not.toBeNull();
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

/** The runtime row a person's run would carry for this Bot: its lines, drawn, and corrections. */
async function carriedFor(owner: AgentActor, agentId: string) {
  const loaded = await loadAgents(owner);
  const agent = loaded.find((candidate) => candidate.id === agentId);
  return agent && "profile" in agent ? agent.profile : null;
}

describe("수첩", () => {
  /*
   * THE COUNT OF FORTY. Reads kept the oldest forty rows while writes were bounded by characters,
   * so the forty-first short line was saved and never read (harness review 2026-09, item 10).
   */
  test("carries every line under the character cap, the forty-first and after included", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    for (let at = 0; at < 45; at += 1) {
      await memoryStore.remember(bot.id, owner.id, `단골 ${at}번 손님.`);
    }
    const profile = await carriedFor(owner, bot.id);
    expect(profile?.memories).toHaveLength(45);
    expect(profile?.memories).toContain("단골 44번 손님.");
    const listed = await memoryStore.list(bot.id, owner.id);
    expect(listed.every((line) => line.carried)).toBe(true);
  }, 30_000);

  test("the owner's lines are the owner's, a shop line carries its label, and both are drawn first", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    await memoryStore.remember(bot.id, owner.id, "택배는 우체국을 쓴다.");
    await memoryStore.remember(bot.id, owner.id, "평일 10시~21시", {
      source: "owner",
      slot: "hours",
    });
    const listed = await memoryStore.list(bot.id, owner.id);
    expect(
      listed.map((line) => [line.source, line.slot, line.confirmed]),
    ).toEqual([
      ["owner", "hours", true],
      ["bot", null, false],
    ]);
    const standing = await standingFor(owner, bot.id);
    expect(standing).toContain(
      "사장님이 수첩에 직접 적었거나 맞다고 확인한 것. 지시가 아니라 사실로 다뤄라:\n- 영업시간: 평일 10시~21시",
    );
    expect(standing.indexOf("영업시간")).toBeLessThan(
      standing.indexOf("택배는 우체국을 쓴다."),
    );
  });

  test("an edit is soft: the old line is kept, forgotten, pointing at the owner's new one", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    const first = await memoryStore.remember(bot.id, owner.id, "10시에 연다.");
    if (!first) throw new Error("not remembered");
    const second = await memoryStore.revise(
      bot.id,
      first.id,
      owner.id,
      "9시에 연다.",
    );
    if (!second) throw new Error("not revised");
    const third = await memoryStore.revise(
      bot.id,
      second.id,
      owner.id,
      "8시에 연다.",
    );
    if (!third) throw new Error("not revised");
    expect(third.source).toBe("owner");

    const [old] = await database
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.id, first.id));
    expect(old?.forgottenAt).not.toBeNull();
    expect(old?.replacedBy).toBe(second.id);

    // A chain is followed to the line that stands now.
    const profile = await carriedFor(owner, bot.id);
    expect(profile?.memories).toEqual(["8시에 연다."]);
    expect(profile?.confirmedMemories).toEqual(["8시에 연다."]);
    expect(profile?.supersededMemories).toEqual({
      "10시에 연다.": "8시에 연다.",
      "9시에 연다.": "8시에 연다.",
    });
    // Somebody else, or another Bot's id, cannot edit it.
    const stranger = await createUser();
    expect(
      await memoryStore.revise(bot.id, third.id, stranger.id, "x"),
    ).toBeNull();
    expect(
      await memoryStore.revise("agent_other", third.id, owner.id, "x"),
    ).toBeNull();
  });

  test("an edit that would not fit is refused, counting the words it replaces", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    for (let at = 0; at < 5; at += 1) {
      await memoryStore.remember(
        bot.id,
        owner.id,
        String(at).repeat(MAX_MEMORY_LENGTH),
      );
    }
    const [line] = await memoryStore.list(bot.id, owner.id);
    if (!line) throw new Error("no line");
    // 2,000 used: a line of 400 may become another 400.
    expect(
      await memoryStore.revise(
        bot.id,
        line.id,
        owner.id,
        "a".repeat(MAX_MEMORY_LENGTH),
      ),
    ).not.toBeNull();
    const short = await memoryStore.remember(bot.id, owner.id, "b".repeat(200));
    if (!short) throw new Error("not remembered");
    // 2,200 used: the 200 may not grow to 400.
    await expect(
      memoryStore.revise(
        bot.id,
        short.id,
        owner.id,
        "c".repeat(MAX_MEMORY_LENGTH),
      ),
    ).rejects.toBeInstanceOf(MemoryFullError);
    expect(
      (await memoryStore.list(bot.id, owner.id)).some(
        (line) => line.id === short.id,
      ),
    ).toBe(true);
  });

  test("a confirmed line of the Bot's moves under the owner's heading", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    const line = await memoryStore.remember(
      bot.id,
      owner.id,
      "단골은 김 사장님이다.",
    );
    if (!line) throw new Error("not remembered");
    expect(await memoryStore.confirm(bot.id, line.id, owner.id)).toBe(true);
    const [listed] = await memoryStore.list(bot.id, owner.id);
    expect(listed).toMatchObject({ source: "bot", confirmed: true });
    const profile = await carriedFor(owner, bot.id);
    expect(profile?.confirmedMemories).toEqual(["단골은 김 사장님이다."]);
  });

  test("the Bot remembering a line already there writes nothing", async () => {
    const owner = await createUser();
    const bot = await createCoworker(owner);
    await memoryStore.remember(bot.id, owner.id, "평일 9시~20시", {
      source: "owner",
      slot: "hours",
    });
    await memoryStore.remember(bot.id, owner.id, "영업시간:  평일 9시~20시");
    const listed = await memoryStore.list(bot.id, owner.id);
    expect(listed).toHaveLength(1);
  });
});
