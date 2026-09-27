/**
 * The package's skills, written into this deployment and handed to its Bots.
 *
 * WHAT IS SHIPPED IS KEPT AS SHIPPED. A built-in skill is the package's text: at boot the row is
 * written when it is missing and rewritten when the package changed it, and the plugin routes refuse
 * to edit or delete one (`laf:skill_built_in`) — an edit that the next upgrade quietly undid would be
 * a control that saves and does nothing. A slug somebody here already took keeps its owner: the
 * package's skill of that name is left out and the log says so.
 *
 * WHAT A PERSON TAKES OFF STAYS OFF. A Bot is handed a built-in skill once — when the skill first
 * arrives on this deployment, or when the Bot is made — and never again. A person who took it off a
 * Bot finds it still off after the next boot; the grant is theirs, the text is the package's.
 *
 * Shaped like the public-data entry (`public-data-rest.ts`): reconciled once at boot with the other
 * background work, offered to a Bot the moment it is made, never fatal.
 *
 * WHAT THIS DEPLOYMENT CANNOT DO, IT DOES NOT CARRY. A skill whose `requires:` names a tool this
 * deployment does not offer is treated as not shipped: no row, so it is on no Skills page, no
 * profile, no prompt's index and nothing `skill_view` will read — and a row an earlier boot wrote
 * goes. The Bot is never told about a skill it cannot use. When the tool arrives (the key is
 * planted and the server restarts), the skill arrives with it as a new one, and every Bot is
 * handed it then; a person who had taken it off before it went finds it on again, which is the one
 * place "what a person takes off stays off" gives way, because the grant went with the row.
 */
import { COMPUTER_TOOLS } from "../../../shared/tools/computer";
import { NOW_TOOL_NAME } from "../../../shared/tools/now";
import { FEED_POST } from "../../../shared/tools/feed-post";
import { ROUTINE_NOTE } from "../../../shared/tools/routine-note";
import { SELF_TOOLS } from "../../../shared/tools/self";
import { SKILL_TOOLS } from "../../../shared/tools/skills";
import { log } from "../log";
import {
  BUILT_IN_ORIGIN,
  type BuiltInSkill,
  readBuiltInSkills,
} from "./built-in-skills";
import { PUBLIC_DATA_TOOLS } from "./public-data-rest";
import type { PluginStore } from "./store";

/**
 * The tools a deployment offers, by name: every Bot's own (its computer, itself, its skills, the
 * clock, a routine's notepad, 소식's posts) and the deployment-key tools where the key is. What `requires:` is
 * held to; `built-in-skills.test.ts` holds every name the package writes there to this list, so a
 * misspelt one fails a test rather than hiding a skill on every deployment.
 */
export function offeredTools(options: { publicData: boolean }): Set<string> {
  return new Set([
    ...COMPUTER_TOOLS.map((tool) => tool.name),
    ...SELF_TOOLS.map((tool) => tool.name),
    ...SKILL_TOOLS.map((tool) => tool.name),
    NOW_TOOL_NAME,
    ROUTINE_NOTE.name,
    FEED_POST.name,
    ...(options.publicData ? PUBLIC_DATA_TOOLS.map((tool) => tool.name) : []),
  ]);
}

export type BuiltInSkillStore = Pick<
  PluginStore,
  "listSkills" | "installSkill" | "uninstallSkill" | "grant"
>;

export type BuiltInSkillsRuntime = {
  /** Rows written, rows removed, and every Bot handed the skills that are new here. Never throws. */
  reconcile: (store: BuiltInSkillStore, by: string) => Promise<void>;
  /** A Bot that has just been made holds every built-in skill. Never throws. */
  offerTo: (
    store: BuiltInSkillStore,
    botId: string,
    by: string,
  ) => Promise<void>;
};

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createBuiltInSkills(input: {
  /** The package directory; its `skills/` holds the files. */
  packageDir: string;
  /** Every live Bot on this deployment: the set a new skill is handed to. */
  listBots: () => Promise<string[]>;
  /**
   * Whether this deployment offers a tool, by name: what a skill's `requires:` is checked against.
   * `main.ts` answers it from the core tools and the deployment-key tools that are configured.
   */
  hasTool: (name: string) => boolean;
  /** For tests: the skills, instead of reading the package. */
  skills?: () => Promise<BuiltInSkill[]>;
}): BuiltInSkillsRuntime {
  const read = input.skills ?? (() => readBuiltInSkills(input.packageDir));
  /** What the package ships that this deployment can use; the rest is logged once per boot. */
  const shipped = async () => {
    const skills = await read();
    const usable: BuiltInSkill[] = [];
    for (const skill of skills) {
      const missing = (skill.requires ?? []).filter(
        (name) => !input.hasTool(name),
      );
      if (missing.length === 0) usable.push(skill);
      else log.info("built_in_skill_withheld", { skill: skill.slug, missing });
    }
    return usable;
  };
  /** The slugs this deployment actually carries as built-in, after the last reconcile. */
  let ours: string[] | null = null;

  async function reconcile(store: BuiltInSkillStore, by: string) {
    try {
      const skills = await shipped();
      const rows = new Map(
        (await store.listSkills()).map((row) => [row.slug, row]),
      );
      const fresh: string[] = [];
      const kept: string[] = [];
      for (const skill of skills) {
        const row = rows.get(skill.slug);
        if (row && row.origin !== BUILT_IN_ORIGIN) {
          log.warn("built_in_skill_slug_taken", { skill: skill.slug });
          continue;
        }
        kept.push(skill.slug);
        if (!row) fresh.push(skill.slug);
        const same =
          row &&
          row.title === skill.title &&
          row.summary === skill.summary &&
          row.instructions === skill.instructions;
        if (same) continue;
        await store.installSkill({
          ...skill,
          origin: BUILT_IN_ORIGIN,
          ownerUserId: null,
          by,
        });
      }
      // A skill a newer package no longer ships goes with it; its grants name nothing after that.
      const shippedSlugs = new Set(skills.map((skill) => skill.slug));
      for (const row of rows.values()) {
        if (row.origin === BUILT_IN_ORIGIN && !shippedSlugs.has(row.slug)) {
          await store.uninstallSkill(row.slug, by);
        }
      }
      ours = kept;
      if (fresh.length === 0) return;
      for (const botId of await input.listBots()) {
        for (const slug of fresh) await store.grant("skill", slug, botId, by);
      }
    } catch (error) {
      log.error("built_in_skills_not_reconciled", { reason: describe(error) });
    }
  }

  async function offerTo(store: BuiltInSkillStore, botId: string, by: string) {
    try {
      // Before the first reconcile: the rows this deployment already marks as the package's.
      const slugs =
        ours ??
        (await store.listSkills())
          .filter((row) => row.origin === BUILT_IN_ORIGIN)
          .map((row) => row.slug);
      for (const slug of slugs) await store.grant("skill", slug, botId, by);
    } catch (error) {
      log.error("built_in_skills_not_offered", {
        bot: botId,
        reason: describe(error),
      });
    }
  }

  return { reconcile, offerTo };
}
