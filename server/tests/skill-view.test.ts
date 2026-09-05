import { describe, expect, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { SKILL_VIEW } from "../../shared/tools/skills";
import { createUnattendedTools } from "../src/runner/unattended";

/**
 * The unattended loop's half of `skill_view`: offered only where there is a skill to read, and
 * answered by the store — which is where the grant is rechecked and the row is written.
 */

const actor = { id: "person-1", userId: "person-1" };

function fakeStore(skills: string[], allowed = true) {
  const viewed: unknown[] = [];
  const store = {
    listForAgent: async () => ({
      tools: [],
      skills: skills.map((slug) => ({
        slug,
        title: slug,
        summary: `${slug} 요약`,
        instructions: `${slug} 본문`,
      })),
    }),
    callTool: async () => {
      throw new Error("no MCP tool is offered in this test");
    },
    viewSkill: async (input: {
      slug: string;
      agentId: string;
      actorId?: string;
    }) => {
      viewed.push(input);
      return allowed
        ? {
            allowed: true as const,
            skill: {
              slug: "재고정리",
              title: "재고 정리",
              summary: "창고 재고를 센다",
              instructions: "1. 창고 페이지를 연다. 2. 수량을 표로 적는다.",
            },
          }
        : { allowed: false as const, reason: "laf:skill_not_granted" };
    },
  };
  return { store, viewed };
}

describe("skill_view in an unattended run", () => {
  test("is offered only to a Bot that holds a skill", async () => {
    const none = await createUnattendedTools({
      pluginStore: fakeStore([]).store,
    })("bot-1", actor);
    expect(none.tools.map((tool) => tool.name)).not.toContain("skill_view");

    const some = await createUnattendedTools({
      pluginStore: fakeStore(["재고정리"]).store,
    })("bot-1", actor);
    const offered = some.tools.find((tool) => tool.name === "skill_view");
    // The catalogue's own words, not a copy.
    expect(offered?.description).toBe(SKILL_VIEW.description);
    expect(offered?.parameters).toBe(SKILL_VIEW.parameters);
  });

  test("reads the body through the store, as this Bot for this person", async () => {
    const { store, viewed } = fakeStore(["재고정리"]);
    const toolkit = await createUnattendedTools({ pluginStore: store })(
      "bot-1",
      actor,
    );

    const outcome = await toolkit.execute("skill_view", { name: "/재고정리" });

    expect(viewed).toEqual([
      { slug: "/재고정리", agentId: "bot-1", actorId: "person-1" },
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      slug: "재고정리",
      instructions: "1. 창고 페이지를 연다. 2. 수량을 표로 적는다.",
    });
  });

  test("a skill this Bot does not hold is refused with the code the Bot knows", async () => {
    const { store } = fakeStore(["재고정리"], false);
    const toolkit = await createUnattendedTools({ pluginStore: store })(
      "bot-1",
      actor,
    );

    expect(await toolkit.execute("skill_view", { name: "몰래" })).toEqual({
      ok: false,
      refused: true,
      code: "laf:skill_not_granted",
      reason: toolResultText("laf:skill_not_granted"),
    });
  });
});
