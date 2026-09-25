import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { skillIndexText } from "../../shared/prompt/skill-index";
import { SKILL_SLUG_PATTERN } from "../../shared/tools/skills";
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
    // size of one tool's description.
    expect(index.length).toBeLessThan(500);
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

  test("a package with no skills directory ships none", async () => {
    expect(await readBuiltInSkills(join(PACKAGE, "nowhere"))).toEqual([]);
  });
});
