import { and, asc, eq, inArray } from "drizzle-orm";
import type { PromptSkill } from "../../../shared/prompt/skill-index";
import type { LoadAgentsForActor } from "../copilot";
import type { Database } from "../db/client";
import { pluginGrants, skills } from "../db/schema";

/**
 * The skills each Bot holds, carried on its profile so the prompt can list them.
 *
 * WHY A WRAPPER. The loader in `runtime-agents.ts` reads what a Bot IS; what it may use is the
 * plugin store's question, answered from `plugin_grants` — the same table `listForAgent` reads
 * before every unattended run. Read here, once per request for every Bot in the roster, rather
 * than inside the prompt middleware: that middleware is synchronous AG-UI, and a query per run
 * per Bot would be latency a person pays before the first word.
 *
 * NAME AND ONE LINE ONLY. The body is what `skill_view` fetches on demand, and the prompt's index
 * is capped (`shared/prompt/skill-index.ts`), so a Bot with forty skills is told the first page of
 * them and how to reach the rest. A Bot with none carries nothing and reads no index at all.
 */
export function withGrantedSkills(
  loadAgents: LoadAgentsForActor,
  database: Database,
): LoadAgentsForActor {
  return async (actor) => {
    const registered = await loadAgents(actor);
    const remote = registered.filter((agent) => agent.type === "remote_ag_ui");
    if (remote.length === 0) return registered;

    const rows = await database
      .select({
        agentId: pluginGrants.agentId,
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
      })
      .from(pluginGrants)
      .innerJoin(skills, eq(skills.slug, pluginGrants.ref))
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          inArray(
            pluginGrants.agentId,
            remote.map((agent) => agent.id),
          ),
        ),
      )
      // The order the Plugins page lists them in, so the prompt and the screen agree.
      .orderBy(asc(skills.title), asc(skills.slug));

    const byAgent = new Map<string, PromptSkill[]>();
    for (const row of rows) {
      const held = byAgent.get(row.agentId) ?? [];
      // A skill saved without a summary is still a skill; its title is the one line it has.
      held.push({ slug: row.slug, summary: row.summary || row.title });
      byAgent.set(row.agentId, held);
    }
    for (const agent of remote) {
      const held = byAgent.get(agent.id);
      if (held?.length) agent.profile.skills = held;
    }
    return registered;
  };
}
