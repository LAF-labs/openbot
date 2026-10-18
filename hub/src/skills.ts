import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_SKILL_LIMITS,
  type HubSkill,
  type HubSkillEntry,
  type HubSkillList,
} from "../../shared/hub/protocol";
import {
  looksLikePromptStructure,
  looksLikeASecret,
} from "../../shared/memory-guards";
import { SKILL_SLUG_PATTERN, skillSlugOf } from "../../shared/tools/skills";
import { recordAudit } from "./audit";
import type { MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubSkills } from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import type { Answer } from "./idempotency";
import { invalid, isAdmin, jsonBody, memberWrite, runOf } from "./member-write";
import { bumpVersion, readVersions, readWithVersions } from "./versions";

/**
 * Skill writes, one at a time. Arbitrary, fixed, used for nothing else, and taken before the
 * version row and the event lock, in that order, by every skill write.
 */
const SKILL_WRITE_LOCK = 7_200_002;

const PACK_PROFILE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

type SkillRow = typeof hubSkills.$inferSelect;

function entryOf(row: SkillRow): HubSkillEntry {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    at: row.updatedAt.toISOString(),
    profile: row.profile,
    shippedVersion: row.shippedVersion,
    edited:
      row.shippedHash !== null && sha256(row.instructions) !== row.shippedHash,
  };
}

/** The slug as the VM stores and calls it, or null when it is not one. */
function slugOf(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const slug = skillSlugOf(decoded);
  return SKILL_SLUG_PATTERN.test(slug) ? slug : null;
}

type SkillInput = {
  title: string;
  summary: string;
  instructions: string;
  pack: { profile: string; version: string } | null;
};

/** The body, or the answer refusing it. */
function parseSkill(body: Record<string, unknown> | null): SkillInput | Answer {
  if (!body) return invalid("body");
  const { title, summary, instructions, pack } = body;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > HUB_SKILL_LIMITS.title
  )
    return invalid("title");
  if (
    summary !== undefined &&
    (typeof summary !== "string" || summary.length > HUB_SKILL_LIMITS.summary)
  )
    return invalid("summary");
  if (
    typeof instructions !== "string" ||
    !instructions.trim() ||
    instructions.length > HUB_SKILL_LIMITS.instructions
  )
    return invalid("instructions");
  let parsedPack: SkillInput["pack"] = null;
  if (pack !== undefined && pack !== null) {
    const value = pack as Record<string, unknown>;
    if (
      typeof pack !== "object" ||
      typeof value.profile !== "string" ||
      !PACK_PROFILE.test(value.profile) ||
      typeof value.version !== "string" ||
      !value.version.trim() ||
      value.version.length > 40
    )
      return invalid("pack");
    parsedPack = { profile: value.profile, version: value.version.trim() };
  }
  return {
    title: title.trim(),
    summary: typeof summary === "string" ? summary.trim() : "",
    instructions: instructions.trim(),
    pack: parsedPack,
  };
}

/**
 * The title and the summary are the two fields every member's Bot carries in its prompt, as a line
 * of the skills index; the instructions are read only when a Bot opens the skill, as a tool's
 * result. So the first two are held to the floor a Bot's job is held to (`agents/profile-text.ts`:
 * no prompt structure) plus the secret check, and the instructions — which ARE instructions, and
 * which name passwords and codes in ordinary how-to prose — to neither.
 */
function refusedText(input: SkillInput): string | null {
  for (const text of [input.title, input.summary]) {
    if (looksLikeASecret(text)) return HUB_FACTS.skillLooksLikeASecret;
    if (looksLikePromptStructure(text)) return HUB_FACTS.skillLooksLikePrompt;
  }
  return null;
}

/** Control characters, and the two line separators Unicode has besides them. */
const CONTROL = /[\p{Cc}\u2028\u2029]+/gu;

/**
 * The title and the summary as they are kept: one line, as `flattenProfileText` keeps a Bot's job.
 * Judged by {@link refusedText} BEFORE this, because a line break is what makes `system:` a role
 * marker; kept AFTER, because a second paragraph that is an order rather than a role marker passes
 * that judgement and would otherwise sit as a paragraph of its own in every member's prompt.
 */
function asIndexLines(input: SkillInput): SkillInput {
  const flat = (text: string) =>
    text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return { ...input, title: flat(input.title), summary: flat(input.summary) };
}

export type SkillRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  /** `requireMember`: every route here is a member's. */
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
};

/**
 * `/hub/v1/skills`: the company's taught skills.
 *
 * Any member may teach the team a new skill — a skill is an instruction, not a capability; every
 * call it leads a Bot to is still decided on that member's VM. Changing or removing one is its
 * author's or an admin's, as on a person's VM (`server/src/plugins/routes.ts`): without that,
 * saving over somebody else's slug would silently take it. A skill an industry pack shipped has no
 * author and is an admin's.
 */
export function skillRoutes(options: SkillRouteOptions) {
  const { database } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use("*", options.member);

  route.get("/", async (context) => {
    const { value: rows, versions } = await readWithVersions(database, (tx) =>
      tx.select().from(hubSkills).orderBy(asc(hubSkills.slug)),
    );
    const body: HubSkillList = {
      ok: true,
      skills: rows.map(entryOf),
      version: versions.skills,
    };
    return context.json(body);
  });

  route.get("/:slug", async (context) => {
    const slug = slugOf(context.req.param("slug"));
    const [row] = slug
      ? await database.select().from(hubSkills).where(eq(hubSkills.slug, slug))
      : [];
    if (!row) {
      return context.json({ ok: false, code: HUB_FACTS.notFound }, 404);
    }
    const body: HubSkill = {
      ok: true,
      skill: { ...entryOf(row), instructions: row.instructions },
    };
    return context.json(body);
  });

  const limit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (context) =>
      context.json({ ok: false, code: "laf:request_invalid" }, 413),
  });

  const lockedRow = async (tx: HubTransaction, slug: string) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SKILL_WRITE_LOCK})`);
    const [row] = await tx
      .select()
      .from(hubSkills)
      .where(eq(hubSkills.slug, slug));
    return row;
  };

  route.put("/:slug", limit, async (context) => {
    const member = context.get("member");
    const slug = slugOf(context.req.param("slug"));
    const input = parseSkill(await jsonBody(context));
    const runId = runOf(context);
    return memberWrite(context, options, async (tx, effects) => {
      if (!slug) return invalid("slug");
      if ("status" in input) return input;
      if (input.pack && !isAdmin(member)) {
        return { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } };
      }
      const refused = refusedText(input);
      const parsed = asIndexLines(input);
      // A title of control characters alone is not empty until it is flattened.
      if (!parsed.title) return invalid("title");
      const existing = await lockedRow(tx, slug);
      if (refused) {
        await recordAudit(tx, {
          action: "skill.refused",
          member: member.id,
          vmOrigin: member.vmOrigin,
          target: slug,
          runId,
          outcome: refused,
        });
        return { status: 400, body: { ok: false, code: refused } };
      }
      if (existing && existing.createdBy !== member.id && !isAdmin(member)) {
        return { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } };
      }
      const unchanged =
        existing &&
        !parsed.pack &&
        existing.title === parsed.title &&
        existing.summary === parsed.summary &&
        existing.instructions === parsed.instructions;
      if (unchanged) {
        return {
          status: 200,
          body: {
            ok: true,
            slug,
            skillVersion: existing.version,
            version: (await readVersions(tx)).skills,
          },
        };
      }
      const now = new Date();
      const pack = parsed.pack
        ? {
            profile: parsed.pack.profile,
            shippedVersion: parsed.pack.version,
            shippedHash: sha256(parsed.instructions),
          }
        : {};
      const skillVersion = existing ? existing.version + 1 : 1;
      if (existing) {
        await tx
          .update(hubSkills)
          .set({
            title: parsed.title,
            summary: parsed.summary,
            instructions: parsed.instructions,
            version: skillVersion,
            updatedBy: member.id,
            updatedAt: now,
            ...pack,
          })
          .where(eq(hubSkills.slug, slug));
      } else {
        await tx.insert(hubSkills).values({
          slug,
          title: parsed.title,
          summary: parsed.summary,
          instructions: parsed.instructions,
          version: 1,
          // A pack's skill is nobody's: it is an admin's to change, whoever installed it.
          createdBy: parsed.pack ? null : member.id,
          updatedBy: member.id,
          createdAt: now,
          updatedAt: now,
          ...pack,
        });
      }
      const version = await bumpVersion(tx, "skills");
      await emitEvent(tx, {
        type: "skill.changed",
        refId: slug,
        actor: member.id,
        version,
      });
      await recordAudit(tx, {
        action: "skill.put",
        member: member.id,
        vmOrigin: member.vmOrigin,
        target: slug,
        runId,
        outcome: "ok",
        payload: {
          skillVersion,
          ...(parsed.pack ? { pack: parsed.pack } : {}),
        },
      });
      effects.emitted = true;
      return {
        status: 200,
        body: { ok: true, slug, skillVersion, version },
      };
    });
  });

  route.delete("/:slug", async (context) => {
    const member = context.get("member");
    const slug = slugOf(context.req.param("slug"));
    const runId = runOf(context);
    return memberWrite(context, options, async (tx, effects) => {
      const existing = slug ? await lockedRow(tx, slug) : undefined;
      if (!slug || !existing) {
        return { status: 404, body: { ok: false, code: HUB_FACTS.notFound } };
      }
      if (existing.createdBy !== member.id && !isAdmin(member)) {
        return { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } };
      }
      await tx.delete(hubSkills).where(eq(hubSkills.slug, slug));
      const version = await bumpVersion(tx, "skills");
      await emitEvent(tx, {
        type: "skill.changed",
        refId: slug,
        actor: member.id,
        version,
      });
      await recordAudit(tx, {
        action: "skill.deleted",
        member: member.id,
        vmOrigin: member.vmOrigin,
        target: slug,
        runId,
        outcome: "ok",
      });
      effects.emitted = true;
      return { status: 200, body: { ok: true, version } };
    });
  });

  return route;
}
