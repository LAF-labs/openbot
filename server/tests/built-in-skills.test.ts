import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { skillIndexText } from "../../shared/prompt/skill-index";
import { SKILL_SLUG_PATTERN } from "../../shared/tools/skills";
import { offeredTools } from "../src/plugins/built-in-skill-sync";
import { PUBLIC_DATA_TOOLS } from "../src/plugins/public-data-rest";
import {
  parseSkillFile,
  readBuiltInSkills,
} from "../src/plugins/built-in-skills";

/**
 * The skills the package ships (`tenant/laf/skills/*.md`), read the way the server reads them at
 * boot. A file that does not parse is a deployment that boots without its skills and says so only
 * in a log line, so it fails here instead.
 */

const PACKAGE = join(import.meta.dir, "../../tenant/laf");
/** What a VM holding the data.go.kr key adds to a Bot's tools, by name. */
const PUBLIC_DATA_TOOL_NAMES = PUBLIC_DATA_TOOLS.map((tool) => tool.name);

describe("the package's skills", () => {
  test("every file parses into a name, a title, one line and a body", async () => {
    const skills = await readBuiltInSkills(PACKAGE);
    expect(skills.length).toBeGreaterThanOrEqual(3);
    for (const skill of skills) {
      expect(SKILL_SLUG_PATTERN.test(skill.slug)).toBe(true);
      expect(skill.title.length).toBeGreaterThan(0);
      expect(skill.instructions.length).toBeGreaterThan(100);
      // The prompt's index cuts a line at 80 characters; one that is cut loses its address.
      expect(skill.summary.length).toBeLessThanOrEqual(80);
    }
    expect(new Set(skills.map((skill) => skill.slug)).size).toBe(skills.length);
  });

  test("the index they add to every prompt stays small", async () => {
    const index = skillIndexText(await readBuiltInSkills(PACKAGE));
    // Every request pays for it (the footprint ladder); four hundred characters is about the
    // size of one tool's description. RAISED 2026-09-27 from 500 to 560 for 목표's skill (phase 9),
    // the rung below a tool: its one line is what makes "오늘 30분 했어" reach the goal's timeline,
    // and the four goal tools themselves cost the head nothing (they are behind the bridge).
    expect(index.length).toBeLessThan(560);
  });

  test("아침 브리핑 looks at the weather for a person whose place is not known — Seoul's, and says so", async () => {
    /*
     * The skill told the routine not to look ("위치를 모르면 찾지 않고 '위치를 몰라 날씨는 못
     * 봤어요'라고만 쓴다") while the routine's own place line, since 2026-10-05, says Seoul's basis
     * (the owner: "fallback은 서울"): two instructions in one run, and the skill's is the one read
     * last (review of pull request 91). It agrees with the place line now, and tells a run that is
     * handed yesterday's "못 봤어요" not to repeat it.
     */
    const briefing = (await readBuiltInSkills(PACKAGE)).find(
      (skill) => skill.slug === "아침브리핑",
    );
    if (!briefing) throw new Error("the package ships no 아침브리핑");
    expect(briefing.instructions).not.toContain("위치를 모르면 찾지 않고");
    expect(briefing.instructions).not.toContain("라고만 쓴다");
    expect(briefing.instructions).toContain(
      "위치를 모르는 사람은 서울 기준으로 온다",
    );
    expect(briefing.instructions).toContain(
      '위치를 몰라서 서울이면 "서울 기준"',
    );
  });

  test("a file without front matter, or without a body, is refused by name", () => {
    expect(() => parseSkillFile("bare.md", "본문만")).toThrow("bare.md");
    expect(() =>
      parseSkillFile(
        "empty.md",
        "---\nname: 빈것\ntitle: 빈 것\ndescription: 한 줄\n---\n",
      ),
    ).toThrow("empty.md");
  });

  test("지원사업 says it needs the 기업마당 tool, and every tool a skill names is one a deployment can offer", async () => {
    const skills = await readBuiltInSkills(PACKAGE);
    const support = skills.find((skill) => skill.slug === "지원사업");
    expect(support?.requires).toEqual(["search_support_programs"]);
    // Without the key the tool is not offered, and with it it is.
    expect(
      offeredTools({ deploymentKeyTools: [] }).has("search_support_programs"),
    ).toBe(false);
    expect(
      offeredTools({ deploymentKeyTools: PUBLIC_DATA_TOOL_NAMES }).has(
        "search_support_programs",
      ),
    ).toBe(true);
    // A misspelt name would withhold a skill on every deployment, with only a log line to say so.
    const everything = offeredTools({
      deploymentKeyTools: PUBLIC_DATA_TOOL_NAMES,
    });
    for (const skill of skills) {
      for (const name of skill.requires ?? [])
        expect(everything.has(name)).toBe(true);
    }
    // The rest need nothing but what every Bot has: the briefing asks about 지원사업 only where the
    // chip found the tool (`morning-briefing.ts`), so it is not withheld with it.
    expect(
      skills.filter((skill) => skill.requires).map((skill) => skill.slug),
    ).toEqual(["지원사업"]);
  });

  test("requires is one tool or a list of them, and anything else is refused by name", () => {
    const head = "---\nname: 가격\ntitle: 가격\ndescription: 한 줄\n";
    const body = "---\n본문이 있다.";
    expect(
      parseSkillFile("one.md", `${head}requires: now\n${body}`).requires,
    ).toEqual(["now"]);
    expect(
      parseSkillFile("two.md", `${head}requires: [now, skill_view]\n${body}`)
        .requires,
    ).toEqual(["now", "skill_view"]);
    expect(
      parseSkillFile("none.md", `${head}${body}`).requires,
    ).toBeUndefined();
    expect(() =>
      parseSkillFile("bad.md", `${head}requires: [1]\n${body}`),
    ).toThrow("bad.md");
  });

  test("a package with no skills directory ships none", async () => {
    expect(await readBuiltInSkills(join(PACKAGE, "nowhere"))).toEqual([]);
  });
});
