/**
 * Industry packs: what choosing a kind of business pre-installs, read from
 * `<package>/profiles/<kind>/profile.yaml` and `<package>/profiles/<kind>/skills/*.md`.
 *
 * A PACK PRE-INSTALLS; IT NEVER NARROWS. Every feature stays open whatever the kind (`shared/persona.ts`,
 * "a hint, never a gate"). A pack adds its own skills, names the package skills that suit the kind,
 * and puts the routine suggestions that suit it first — every other suggestion still follows, in the
 * catalogue's order.
 *
 * NOTHING NEW TO LEARN. The kinds are `shared/shop/catalogue.ts`'s eight, a pack's skills are files in
 * the format the package's skills already use (`built-in-skills.ts`), and a suggestion is named by its
 * catalogue key (`routines/suggestion-catalog.ts`). The places a kind works in are NOT repeated here:
 * the shop catalogue holds them once, for the surface and the prompt both, and a second copy would
 * disagree the first time a place was added.
 *
 * WHAT A PACK TELLS THE BOT IS A SKILL. The kind's working notes are the body of the pack's own skill:
 * one line in the context layer's skills index, the body only when the Bot opens it (`skill_view`'s
 * result). Nothing a pack holds reaches the static layer or the tool list, so the head of the prompt
 * every conversation shares is the same bytes whatever kind anybody chose.
 *
 * A BROKEN PACK FAILS ITS TESTS (`industry-packs.test.ts` reads every pack with the checks below). At
 * boot the server logs it and carries no pack, the way a broken skill file is never fatal.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, isNotNull, isNull } from "drizzle-orm";
import { parse } from "yaml";
import {
  BUSINESS_KINDS,
  type BusinessKind,
  type BusinessKindId,
} from "../../../shared/shop/catalogue";
import type { ShopStore } from "../account/shop";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import type { RoutineSuggestionEntry } from "../routines/suggestion-catalog";
import {
  type BuiltInSkill,
  parseSkillFile,
  readBuiltInSkills,
} from "./built-in-skills";

export type IndustryPack = {
  kind: BusinessKindId;
  /**
   * What the hub records as `shipped_version` on each skill this pack installs. The file's own
   * `version` and a fingerprint of everything the pack ships: a pack whose text changed and whose
   * number nobody raised is still a new version, so a team's copy is never left behind by a bump
   * somebody forgot (the reason `shared/prompt/harness.ts` computes its version too).
   */
  version: string;
  /** The places this kind works in, from the shop catalogue — the one copy. */
  places: readonly string[];
  /** Every skill the pack carries, in the order its file lists them: its own and the package's. */
  skills: readonly string[];
  /** The pack's own skills (`skills/*.md` beside its `profile.yaml`). */
  own: readonly BuiltInSkill[];
  /** Suggestion keys this kind is offered first, in order. */
  routineSuggestions: readonly string[];
};

/** The keys a `profile.yaml` may hold. Anything else is a typo that would be silently ignored. */
const PROFILE_KEYS = new Set(["version", "skills", "routine_suggestions"]);
/** The hub keeps `shipped_version` to forty characters; the fingerprint takes thirteen of them. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;
/**
 * What the hub accepts for one skill (`PUT /hub/v1/skills/:slug`, `HUB_SKILL_LIMITS` on the hub's
 * side). Held here so a pack the hub would refuse fails a test, not a team's install.
 */
export const HUB_SKILL_LIMITS = {
  title: 120,
  summary: 500,
  instructions: 20_000,
} as const;
/** The hub's rule for a pack's profile name. Every kind id fits it; a test says so. */
export const HUB_PACK_PROFILE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const KINDS = new Map<string, BusinessKind>(
  BUSINESS_KINDS.map((kind) => [kind.id, kind]),
);

function listOf(file: string, key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error(`${file}: ${key} is a list of names`);
  }
  const names = value.map((item) => String(item).trim());
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new Error(`${file}: ${key} names ${twice} twice`);
  return names;
}

const fingerprint = (parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

/**
 * One pack, or an error naming its file and what is wrong.
 *
 * `packageSkills` is what the package ships (`tenant/<package>/skills`), `suggestions` the routine
 * catalogue. A pack may name a package skill, but not one that needs a tool (`requires:`): a team's
 * hub cannot say what a skill needs, so a member whose VM lacks the tool would be shown a skill that
 * can only fail.
 */
export function parseIndustryPack(input: {
  kind: string;
  file: string;
  text: string;
  own: readonly BuiltInSkill[];
  packageSkills: readonly BuiltInSkill[];
  suggestions: readonly Pick<RoutineSuggestionEntry, "key">[];
}): IndustryPack {
  const { file } = input;
  const catalogued = KINDS.get(input.kind);
  if (!catalogued) throw new Error(`${file}: ${input.kind} is not a kind`);
  let head: unknown;
  try {
    head = parse(input.text);
  } catch (error) {
    throw new Error(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!head || typeof head !== "object" || Array.isArray(head)) {
    throw new Error(`${file}: not a map`);
  }
  const fields = head as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !PROFILE_KEYS.has(key));
  if (unknown) throw new Error(`${file}: ${unknown} is not a pack field`);
  // A string, quoted: unquoted, YAML reads 1.10 as the number 1.1.
  if (typeof fields.version !== "string" || !VERSION.test(fields.version)) {
    throw new Error(`${file}: version is a quoted string like "1"`);
  }

  const skills = listOf(file, "skills", fields.skills);
  const packaged = new Map(input.packageSkills.map((one) => [one.slug, one]));
  const own = new Map(input.own.map((one) => [one.slug, one]));
  for (const skill of input.own) {
    if (packaged.has(skill.slug)) {
      throw new Error(`${file}: its own ${skill.slug} takes a package name`);
    }
    if (skill.requires) {
      throw new Error(`${file}: its own ${skill.slug} may not need a tool`);
    }
    if (!skills.includes(skill.slug)) {
      throw new Error(`${file}: skills leaves out its own ${skill.slug}`);
    }
  }
  for (const slug of skills) {
    const shipped = own.get(slug) ?? packaged.get(slug);
    if (!shipped) throw new Error(`${file}: no skill is named ${slug}`);
    if (shipped.requires) {
      throw new Error(`${file}: ${slug} needs a tool, so no pack may carry it`);
    }
    if (
      shipped.title.length > HUB_SKILL_LIMITS.title ||
      shipped.summary.length > HUB_SKILL_LIMITS.summary ||
      shipped.instructions.length > HUB_SKILL_LIMITS.instructions
    ) {
      throw new Error(`${file}: ${slug} is longer than a team skill may be`);
    }
  }

  const routineSuggestions = listOf(
    file,
    "routine_suggestions",
    fields.routine_suggestions,
  );
  const keys = new Set(input.suggestions.map((entry) => entry.key));
  const stray = routineSuggestions.find((key) => !keys.has(key));
  if (stray)
    throw new Error(`${file}: no routine suggestion is keyed ${stray}`);

  const carried = skills.map((slug) => {
    const skill = (own.get(slug) ?? packaged.get(slug)) as BuiltInSkill;
    return [skill.slug, skill.title, skill.summary, skill.instructions];
  });
  const print = fingerprint([
    fields.version,
    ...carried.flat(),
    ...routineSuggestions,
  ]);
  return {
    kind: catalogued.id,
    version: `${fields.version}+${print.slice(0, 12)}`,
    places: catalogued.places,
    skills,
    own: input.own,
    routineSuggestions,
  };
}

/**
 * Every pack the package ships, one per kind, or an error naming the first thing wrong.
 *
 * Every kind has a pack — 그 밖에 too, empty — so a kind added to the catalogue without one fails
 * here. A pack's own skill name may appear in only one pack: the hub records which profile shipped
 * a skill, and the VM removes a pack's skills when the kind changes, which needs one owner per name.
 */
export async function readIndustryPacks(
  packageDir: string,
  options: {
    packageSkills?: readonly BuiltInSkill[];
    suggestions: readonly Pick<RoutineSuggestionEntry, "key">[];
  },
): Promise<IndustryPack[]> {
  const root = join(packageDir, "profiles");
  const packageSkills =
    options.packageSkills ?? (await readBuiltInSkills(packageDir));
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const stray = dirs.find((name) => !KINDS.has(name));
  if (stray) throw new Error(`profiles/${stray}: ${stray} is not a kind`);
  const packs: IndustryPack[] = [];
  const ownedBy = new Map<string, string>();
  for (const kind of BUSINESS_KINDS) {
    const dir = join(root, kind.id);
    const file = `profiles/${kind.id}/profile.yaml`;
    const text = await readFile(join(dir, "profile.yaml"), "utf8").catch(() => {
      throw new Error(`${file}: missing`);
    });
    const names = (await readdir(join(dir, "skills")).catch(() => []))
      .filter((name) => name.endsWith(".md"))
      .sort();
    const own = await Promise.all(
      names.map(async (name) =>
        parseSkillFile(
          `profiles/${kind.id}/skills/${name}`,
          await readFile(join(dir, "skills", name), "utf8"),
        ),
      ),
    );
    for (const skill of own) {
      const first = ownedBy.get(skill.slug);
      if (first) {
        throw new Error(`${file}: ${skill.slug} is already ${first}'s`);
      }
      ownedBy.set(skill.slug, kind.id);
    }
    packs.push(
      parseIndustryPack({
        kind: kind.id,
        file,
        text,
        own,
        packageSkills,
        suggestions: options.suggestions,
      }),
    );
  }
  return packs;
}

/** The pack for a kind. None for no answer, and none for a kind with no pack. */
export function packFor(
  packs: readonly IndustryPack[],
  kind: BusinessKindId | null,
): IndustryPack | null {
  if (!kind) return null;
  return packs.find((pack) => pack.kind === kind) ?? null;
}

/**
 * The suggestions in the order this kind is offered them: the pack's first, in its order, then every
 * other in the catalogue's. A reordering, never a filter — the same entries, each once.
 */
export function orderedByPack<T extends Pick<RoutineSuggestionEntry, "key">>(
  catalogue: readonly T[],
  leading: readonly string[],
): T[] {
  if (leading.length === 0) return [...catalogue];
  const rank = new Map(leading.map((key, index) => [key, index]));
  const first = catalogue
    .filter((entry) => rank.has(entry.key))
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  return [...first, ...catalogue.filter((entry) => !rank.has(entry.key))];
}

/**
 * Whose business kind this deployment installs a pack for: the one person who owns its live Bots.
 * One account per deployment, so one person; anything else — nobody yet, or two people's Bots from
 * before the rule — installs no pack rather than guessing whose. The kind itself is read through
 * the shop store, the one reader of those columns (`shop-boundary.test.ts`).
 */
export async function readDeploymentOwner(
  database: Database,
): Promise<string | null> {
  const rows = await database
    .selectDistinct({ id: agentProfiles.ownerUserId })
    .from(agentProfiles)
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        isNotNull(agentProfiles.ownerUserId),
      ),
    );
  return deploymentOwnerOf(rows.map((row) => row.id));
}

/** The owners of the live Bots: the one, or none. */
export function deploymentOwnerOf(
  owners: readonly (string | null)[],
): string | null {
  const [only, ...more] = owners;
  return only && more.length === 0 ? only : null;
}

/**
 * The shop store, with the pack following the kind: when a save changes the business kind, `onChange`
 * runs (the built-in reconcile) before the answer goes back, so the next run already holds the new
 * pack's skills. A save that keeps the kind — places only — changes no skill and costs nothing.
 */
export function withPackOnKindChange(
  store: ShopStore,
  onChange: () => Promise<void>,
): ShopStore {
  return {
    ...store,
    save: async (userId, shop) => {
      const before = (await store.read(userId)).kind;
      const saved = await store.save(userId, shop);
      if (saved.kind !== before) await onChange();
      return saved;
    },
  };
}

/**
 * A team skill as `GET /hub/v1/skills` lists it — the fields deciding an install reads. Structurally
 * the hub's `HubSkillEntry` (pull request 252), repeated rather than imported until that lands.
 */
export type HubSkillIndexEntry = {
  slug: string;
  /** The pack that shipped it, or null for one the team wrote. */
  profile: string | null;
  shippedVersion: string | null;
  /** The team changed it since it shipped. */
  edited: boolean;
};

/** `PUT /hub/v1/skills/:slug`, an admin's call (only an admin may send `pack`). */
export type HubSkillWrite = {
  slug: string;
  method: "PUT";
  path: string;
  body: {
    title: string;
    summary: string;
    instructions: string;
    pack: { profile: string; version: string };
  };
};

/**
 * Why a pack's skill is not written. `team`: the team wrote a skill by that name, and the team's
 * wins. `other-pack`: another of the company's packs installed it first. `edited`: the team changed
 * the pack's copy — never overwritten; `newer` says whether this pack has a newer one to offer
 * ("새 판 있음", the hub's to draw). `current`: the hub already holds this version.
 */
export type HubSkillKept = {
  slug: string;
  reason: "team" | "other-pack" | "edited" | "current";
  newer: boolean;
};

/**
 * What installing a pack into a company's hub writes, against the hub's index as it stands. Pure:
 * the call itself is the hub client's (it needs an admin's pass).
 *
 * A skill the team edited is never written over, whatever version is newer. One the team did not
 * edit is brought to this version. One the team wrote under the same name is the team's.
 */
export function hubSkillWrites(
  pack: IndustryPack,
  skills: readonly BuiltInSkill[],
  index: readonly HubSkillIndexEntry[],
): { writes: HubSkillWrite[]; kept: HubSkillKept[] } {
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  const hub = new Map(index.map((entry) => [entry.slug, entry]));
  const writes: HubSkillWrite[] = [];
  const kept: HubSkillKept[] = [];
  for (const slug of pack.skills) {
    const skill = bySlug.get(slug);
    if (!skill) throw new Error(`${pack.kind}: no text for ${slug}`);
    const there = hub.get(slug);
    const newer = there?.shippedVersion !== pack.version;
    if (there && there.profile === null) {
      kept.push({ slug, reason: "team", newer: false });
      continue;
    }
    if (there && there.profile !== pack.kind) {
      kept.push({ slug, reason: "other-pack", newer: false });
      continue;
    }
    if (there?.edited) {
      kept.push({ slug, reason: "edited", newer });
      continue;
    }
    if (there && !newer) {
      kept.push({ slug, reason: "current", newer: false });
      continue;
    }
    writes.push({
      slug,
      method: "PUT",
      path: `/hub/v1/skills/${encodeURIComponent(slug)}`,
      body: {
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
        pack: { profile: pack.kind, version: pack.version },
      },
    });
  }
  return { writes, kept };
}
