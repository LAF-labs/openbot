/**
 * The skills a package ships, read from `<package>/skills/*.md`.
 *
 * The file format is the published Agent Skills one (Claude Code's `SKILL.md`): YAML front matter
 * naming the skill and saying in one line when it applies, then the body. Only the name and that
 * line ride in every prompt (`shared/prompt/skill-index.ts`); the body is read on demand with
 * `skill_view` — the index-in-context, body-on-demand pattern, so ten site notes cost a Bot ten
 * lines until it needs one.
 *
 * Files, not rows in a migration: a skill is text a person at the company edits and reviews in a
 * diff, and the package is where a deployment's shipped content already lives (`model.yaml`,
 * `brand.yaml`). The server writes them into `skills` at boot (`built-in-skill-sync.ts`).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SKILL_SLUG_PATTERN, skillSlugOf } from "../../../shared/tools/skills";

export type BuiltInSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

/** What `origin` says on a row this module wrote. Nobody else writes it. */
export const BUILT_IN_ORIGIN = "built_in";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** One file, or an error naming what is wrong with it: a package that ships a broken skill fails its tests. */
export function parseSkillFile(file: string, text: string): BuiltInSkill {
  const match = FRONT_MATTER.exec(text);
  if (!match) throw new Error(`${file}: no front matter`);
  const head = parse(match[1] ?? "") as Record<string, unknown> | null;
  const slug = skillSlugOf(String(head?.name ?? ""));
  const title = String(head?.title ?? "").trim();
  const summary = String(head?.description ?? "").trim();
  const instructions = (match[2] ?? "").trim();
  if (!SKILL_SLUG_PATTERN.test(slug)) throw new Error(`${file}: bad name`);
  if (!title || !summary || !instructions) {
    throw new Error(`${file}: title, description and a body are required`);
  }
  return { slug, title, summary, instructions };
}

/** Every skill a package ships, in file-name order. A package with no `skills/` ships none. */
export async function readBuiltInSkills(
  packageDir: string,
): Promise<BuiltInSkill[]> {
  const dir = join(packageDir, "skills");
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = names.filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (name) =>
      parseSkillFile(name, await readFile(join(dir, name), "utf8")),
    ),
  );
}
