import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { normalizeSkillName } from "../../../shared/tools/skills";
import {
  recordAuditEvent,
  SKILL_NOT_GRANTED,
  TOOL_NOT_GRANTED,
} from "../audit";
import type { Database } from "../db/client";
import { agentProfiles, mcpTools, pluginGrants, skills } from "../db/schema";
import type {
  GrantedPlugins,
  PluginContext,
  PluginDecision,
  PluginKind,
  SkillActor,
  SkillRecord,
} from "./store";
import { toolNameFor } from "./store";

/**
 * Who holds what: the skills this deployment has written down, and the grants that say which Bot may
 * use which of them.
 *
 * The grant is one of the two questions every call answers, and it is deliberately the cheap one —
 * a row exists or it does not. The other question, whether THIS call is permitted right now, is the
 * policy's, and lives on the call path. Keeping them in different modules is the same separation the
 * store's own header argues for: an operator who granted a Bot a server has not waived every rule
 * about it.
 */
/**
 * Every Bot this person owns, deleted ones excluded — the set a connect grants to.
 *
 * ONE DEFINITION, called by both connect paths. A partner connect and an OAuth callback have to
 * mean the same thing by "their Bots", and two expressions of it is how one of them quietly stops
 * including something. The partner runtime calls this rather than keeping its own copy.
 *
 * HIDDEN BOTS ARE INCLUDED, which is why this is not the profile store's `list()`: a Bot somebody
 * tidied off their home screen is still theirs, and leaving it out means the one Bot they hid is
 * the one that cannot use the account they just connected.
 */
export async function botsOwnedBy(
  database: Database,
  userId: string,
): Promise<string[]> {
  if (!userId) return [];
  const rows = await database
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.ownerUserId, userId),
        isNull(agentProfiles.deletedAt),
      ),
    );
  return rows.map((row) => row.agentId);
}

/**
 * Every live Bot on this deployment, whoever owns it.
 *
 * The set a deployment-wide capability is offered to (`public-data-rest.ts`): a key the fleet holds
 * is nobody's in particular, so unlike {@link botsOwnedBy} there is no person to scope it by. One VM
 * is one person and their staff (docs/laf/deployment-model.md), which is why this is not a leak.
 */
export async function allLiveBots(database: Database): Promise<string[]> {
  const rows = await database
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(isNull(agentProfiles.deletedAt));
  return rows.map((row) => row.agentId);
}

export function createSkillsAndGrants(context: PluginContext) {
  const { database, auditStore } = context;

  async function grantsFor(kind: PluginKind, refs: string[]) {
    if (refs.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.kind, kind), inArray(pluginGrants.ref, refs)));
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /**
   * Every MCP grant belonging to these servers, whether or not the tool is still advertised.
   *
   * {@link grantsFor} asks about refs somebody already has, which is the wrong question when the
   * point is to find the ones nothing else knows about: called with the advertised refs it can only
   * ever return a subset of them, so a grant on a withdrawn tool is invisible by construction.
   *
   * Matched on the server half in the query rather than by reading every grant and splitting here.
   * `split_part` rather than a `LIKE` prefix, because a server id is text a person can choose for a
   * custom server and `%` in one would silently widen the match.
   */
  async function mcpGrantsForServers(serverIds: string[]) {
    if (serverIds.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          inArray(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverIds),
        ),
      );
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /**
   * Whose a Bot is, or `undefined` if there is no such Bot.
   *
   * Read here rather than through the coworker store because the only question this file asks is
   * "may this person put their skill on that Bot", and a whole profile is more than that needs.
   *
   * A named function rather than only a method, because {@link actorMayDriveBot} calls it: a method
   * reached through `this` breaks the moment somebody destructures this object, which is exactly how
   * the store hands these out.
   */
  async function agentOwner(
    agentId: string,
  ): Promise<string | null | undefined> {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId))
      .limit(1);
    return row ? row.ownerUserId : undefined;
  }

  /**
   * May this person act THROUGH this Bot — call its tools, read what it holds?
   *
   * WHAT WENT WRONG WITHOUT IT. `POST /call` took the Bot from the request body and asked only
   * whether that Bot held a grant on the tool. A Bot id is not a secret — `GET /` hands out
   * `grantedTo` and `GET /for/:agentId` answers about any id at all — so on a deployment an owner
   * shares with their staff, a staff member could name the owner's Bot and spend the owner's tools:
   * the deployment's own credential on a custom MCP server, the owner's shop on a partner one.
   * The grant said yes because the grant is about the BOT, and nothing was asking about the person.
   *
   * AN OWNERLESS BOT IS EVERYBODY'S, AND THAT IS DELIBERATE. Null owner means a Bot this deployment
   * published rather than one somebody made, which is a Bot every signed-in person is shown and
   * meant to talk to; the only way it holds an MCP tool at all is an administrator granting one to
   * it, which is that administrator saying "for everybody here". Refusing those would take the
   * tools off the shared Bots without anybody deciding to.
   *
   * VISIBILITY DOES NOT WIDEN THIS. A Bot somebody made and marked `public` is still theirs, and
   * being able to SEE a Bot is not being able to spend what it holds. The two questions were never
   * the same one, and this is the one that reaches a credential.
   *
   * A BOT WITH NO PROFILE ROW IS TREATED THE SAME WAY AS AN OWNERLESS ONE. Every Bot a person
   * makes gets its profile in the same transaction as its `agents` row (`profile-store.ts`), so
   * a row without one was not made by anybody on this deployment — and the rule here is "not
   * somebody ELSE'S", which such a Bot cannot be. Refusing it instead was measured to take the
   * tools off six suites' worth of fixture Bots, and would do the same to any Bot an upstream
   * path minted without a profile; the grant check behind this still refuses a tool the Bot was
   * never given, exactly as it did before.
   */
  async function actorMayDriveBot(
    agentId: string,
    actor: SkillActor,
  ): Promise<boolean> {
    if (actor.isAdmin) return true;
    const owner = await agentOwner(agentId);
    return owner === undefined || owner === null || owner === actor.id;
  }

  return {
    grantsFor,
    mcpGrantsForServers,
    agentOwner,
    actorMayDriveBot,

    /**
     * The skills this person may see: the deployment's, plus their own.
     *
     * An administrator sees every skill in the deployment, including other people's, because
     * governing what Bots are told is the job of the surface they are looking at.
     */
    async listSkills(actor?: SkillActor): Promise<SkillRecord[]> {
      const visible =
        !actor || actor.isAdmin
          ? undefined
          : or(isNull(skills.ownerUserId), eq(skills.ownerUserId, actor.id));
      const rows = await database
        .select()
        .from(skills)
        .where(visible)
        .orderBy(asc(skills.title));
      const grants = await grantsFor(
        "skill",
        rows.map((row) => row.slug),
      );
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        ownerUserId: row.ownerUserId,
        title: row.title,
        summary: row.summary,
        instructions: row.instructions,
        origin: row.origin,
        installedBy: row.installedBy,
        grantedTo: grants.get(row.slug) ?? [],
      }));
    },

    /** Whose a skill is, or `undefined` if there is no such skill. Null owner means the deployment's. */
    async skillOwner(slug: string): Promise<string | null | undefined> {
      const [row] = await database
        .select({ ownerUserId: skills.ownerUserId })
        .from(skills)
        .where(eq(skills.slug, slug))
        .limit(1);
      return row ? row.ownerUserId : undefined;
    },

    async installSkill(input: {
      slug: string;
      title: string;
      summary: string;
      instructions: string;
      origin?: string;
      /** Whose it is. Null writes a skill for the whole deployment, which is an admin's to make. */
      ownerUserId: string | null;
      by: string;
    }): Promise<void> {
      await database
        .insert(skills)
        .values({
          id: input.slug,
          slug: input.slug,
          ownerUserId: input.ownerUserId,
          title: input.title,
          summary: input.summary,
          instructions: input.instructions,
          origin: input.origin ?? "yours",
          installedBy: input.by,
        })
        // Editing keeps the owner it already had. Whose a skill is, is not something a re-save
        // should quietly change, and the route has already checked this person may edit it.
        .onConflictDoUpdate({
          target: skills.slug,
          set: {
            title: input.title,
            summary: input.summary,
            instructions: input.instructions,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: input.slug,
        payload: {
          actor: input.by,
          change: "skill_installed",
          skill: input.slug,
        },
      });
    },

    async uninstallSkill(slug: string, by: string): Promise<void> {
      await database.delete(skills).where(eq(skills.slug, slug));
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: slug,
        payload: { actor: by, change: "skill_uninstalled", skill: slug },
      });
    },

    async grant(
      kind: PluginKind,
      ref: string,
      agentId: string,
      by: string,
    ): Promise<void> {
      await database
        .insert(pluginGrants)
        .values({ kind, ref, agentId, grantedBy: by })
        .onConflictDoUpdate({
          target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
          set: { grantedBy: by, updatedAt: new Date() },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: kind === "mcp" ? "mcp_tool" : "skill",
        targetId: ref,
        payload: {
          actor: by,
          change: "plugin_granted",
          kind,
          ref,
          bot: agentId,
        },
      });
    },

    async revoke(
      kind: PluginKind,
      ref: string,
      agentId: string,
      by: string,
    ): Promise<void> {
      await database
        .delete(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, kind),
            eq(pluginGrants.ref, ref),
            eq(pluginGrants.agentId, agentId),
          ),
        );

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: kind === "mcp" ? "mcp_tool" : "skill",
        targetId: ref,
        payload: {
          actor: by,
          change: "plugin_revoked",
          kind,
          ref,
          bot: agentId,
        },
      });
    },

    /** Everything one Bot may use. The runtime asks this and offers exactly what comes back. */
    async listForAgent(agentId: string): Promise<GrantedPlugins> {
      const held = await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId));
      if (held.length === 0) return { tools: [], skills: [] };

      const toolRefs = held
        .filter((row) => row.kind === "mcp")
        .map((row) => row.ref);
      const skillSlugs = held
        .filter((row) => row.kind === "skill")
        .map((row) => row.ref);

      const toolRows =
        toolRefs.length === 0
          ? []
          : await database.select().from(mcpTools).orderBy(asc(mcpTools.name));
      const grantedTools = toolRows
        .filter((row) => toolRefs.includes(`${row.serverId}/${row.name}`))
        .map((row) => {
          const ref = `${row.serverId}/${row.name}`;
          return {
            ref,
            toolName: toolNameFor(ref),
            description: row.description,
            inputSchema: row.inputSchema as Record<string, unknown>,
          };
        });

      const skillRows =
        skillSlugs.length === 0
          ? []
          : await database
              .select()
              .from(skills)
              .where(inArray(skills.slug, skillSlugs));

      return {
        tools: grantedTools,
        skills: skillRows.map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          instructions: row.instructions,
        })),
      };
    },

    /**
     * A Bot reading the body of a skill it holds, and the row that says it did.
     *
     * The prompt shows a Bot its skills by name and one line; this is the on-demand half. The
     * grant is the only guard — a skill is an instruction, not a capability, and every tool it
     * goes on to ask for is decided on its own — so a Bot without the grant is refused with the
     * code the runtime already knows, and a Bot with it gets the text and leaves a `skill.viewed`
     * row: the one trace of a skill chosen by the Bot rather than typed with `/`.
     *
     * A name nothing is installed under is the same refusal. The Bot was told which skills it
     * holds, so a name outside that list was not given to it, whichever of the two it is.
     */
    async viewSkill(input: {
      slug: string;
      agentId: string;
      /** Who the run is for. In the payload, not the actor column: a routine's local actor is no row. */
      actorId?: string;
    }): Promise<
      | {
          allowed: true;
          skill: {
            slug: string;
            title: string;
            summary: string;
            instructions: string;
          };
        }
      | { allowed: false; reason: string }
    > {
      const slug = normalizeSkillName(input.slug);
      const [row] = slug
        ? await database
            .select()
            .from(skills)
            .where(sql`lower(${skills.slug}) = ${slug}`)
            .limit(1)
        : [];
      if (!row) return { allowed: false, reason: SKILL_NOT_GRANTED };
      const [held] = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "skill"),
            eq(pluginGrants.ref, row.slug),
            eq(pluginGrants.agentId, input.agentId),
          ),
        )
        .limit(1);
      if (!held) return { allowed: false, reason: SKILL_NOT_GRANTED };

      await recordAuditEvent(auditStore, {
        eventType: "skill.viewed",
        targetType: "skill",
        targetId: row.slug,
        // Which skill and which Bot — never the body. The trail says what was read, not what it says.
        payload: {
          bot: input.agentId,
          skill: row.slug,
          ...(input.actorId ? { actor: input.actorId } : {}),
        },
      });
      return {
        allowed: true,
        skill: {
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          instructions: row.instructions,
        },
      };
    },

    /**
     * May this Bot use this plugin?
     *
     * The single question every caller asks, so there is one place the answer is decided and one
     * place to audit it. A missing row is a refusal, not an oversight.
     */
    async decide(
      kind: PluginKind,
      ref: string,
      agentId: string,
    ): Promise<PluginDecision> {
      const [row] = await database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, kind),
            eq(pluginGrants.ref, ref),
            eq(pluginGrants.agentId, agentId),
          ),
        )
        .limit(1);

      /*
       * A code, not a sentence. This one was English in three places at once: the
       * `mcp.call_rejected` row's `reason`, the refusal the model reads, and the line a person sees
       * where a tool's answer would have been. The ref it used to spell out is the row's own target
       * id and the model's own argument, so nothing is lost by leaving it out of the words.
       */
      if (!row) {
        return {
          allowed: false,
          reason: kind === "mcp" ? TOOL_NOT_GRANTED : SKILL_NOT_GRANTED,
        };
      }
      return { allowed: true };
    },
  };
}

export type SkillsAndGrants = ReturnType<typeof createSkillsAndGrants>;
