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
 */
import { log } from "../log";
import {
  BUILT_IN_ORIGIN,
  type BuiltInSkill,
  readBuiltInSkills,
} from "./built-in-skills";
import type { PluginStore } from "./store";

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
  /** For tests: the skills, instead of reading the package. */
  skills?: () => Promise<BuiltInSkill[]>;
}): BuiltInSkillsRuntime {
  const shipped = input.skills ?? (() => readBuiltInSkills(input.packageDir));
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
