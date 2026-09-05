import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { AgentRunner } from "@copilotkit/runtime/v2";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { textOf } from "../../shared/message-content";
import {
  composePrompt,
  type PromptMode,
  promptModeOf,
  type PromptSkill,
  resolveTimeZone,
} from "../../shared/prompt";
import type { AgentActor, AgentEffort } from "./agents/profile-types";
import type { StallGuard } from "./channels/stall-guard";
import type { ResultSpill } from "./computer/spillover";

/**
 * The CopilotKit runtime, in the one mode this product has.
 *
 * Every Bot is reached over AG-UI as an `HttpAgent`, so anything that speaks the protocol is a Bot
 * with no framework adapter here: LangGraph, Pydantic-AI, CrewAI, Mastra, ADK, or a hand-written
 * server. This deployment's own `agent-bot` is one of those endpoints and nothing more.
 *
 * THE SECOND BRANCH IS GONE. CopilotKit's `BuiltInAgent` — the Responses API, a package's own
 * system prompt, `forceReasoning` — was unreachable: the package ships `agents: []`, and after
 * migration 0024 released the packaged Bots there is no `built_in` row anywhere to construct one
 * from. It carried a whole second way for a Bot's prompt and effort to reach a model, which is the
 * shape that hides a setting going nowhere. Git has it.
 *
 * Upstream had no SSE branch: Intelligence owned durable threads, and a deployment without it
 * silently forgot every conversation. This fork runs the SSE branch on a runner that does not
 * forget — LafPostgresRunner keeps every thread in our own Postgres — and there is no second
 * branch to choose between.
 */

/** Resolve the signed-in person for a request. Threads and memory are scoped to whoever this returns. */
export type IdentifyUser = (
  request: Request,
) => Promise<{ id: string; name: string }>;

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  /**
   * Who this Bot is, as the prompt composer needs it.
   *
   * The finished system message is built per RUN rather than held here, because one of the things
   * it says is what time it is. Built once at load, a long-lived deployment would tell every Bot
   * the moment its process started, for as long as that process lived.
   */
  profile: AgentStandingProfile;
  /**
   * How hard it thinks, sent to the endpoint on every run.
   *
   * REMOTE IS NOT THE EXOTIC CASE, IT IS EVERY CASE. Only the Bots a package shipped are
   * `built_in`; every Bot anybody creates is `remote_ag_ui`, pointed at this deployment's own
   * `agent-bot`. A setting wired into the built-in configuration alone therefore reaches nothing
   * anybody will ever make — which is what shipped, and was mistaken for working because the Bot it
   * was tried on answered perfectly well with the setting going nowhere at all.
   */
  effort: AgentEffort;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. It is registered so the runtime can restore that thread and the person can read
 * what was said; every run is refused here, without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  | RegisteredRemoteAgent
  | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;

/** The durable part of a coworker: who it is and what its standing job is. */
export type AgentStandingProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  /**
   * What this Bot has learned about the person it is answering, oldest first.
   *
   * On the profile rather than in `forwardedProps` for the same reason the job is: the endpoint on
   * the other side may be LangGraph, Mastra or a hand-written server, and a system message is the
   * only thing all of them already understand.
   */
  memories?: readonly string[];
  /**
   * The skills this Bot holds, by name and one line, so the prompt can list them.
   *
   * Attached by `agents/granted-skills.ts` on the way out of the loader, not read here: the
   * middleware below is synchronous, and a Bot's grants are the plugin store's question.
   */
  skills?: readonly PromptSkill[];
};

/**
 * The wall clock a Bot is told about, from the environment, defaulting to Seoul.
 *
 * `BOT_TIME_ZONE` rather than the host's own zone: the VM may be anywhere and the person is in
 * Korea. An unusable name falls back rather than throwing — a typo in a deployment's environment
 * should not stop every Bot answering, it should stop being believed.
 */
export function botTimeZone(
  environment: Record<string, string | undefined> = process.env,
): string {
  return resolveTimeZone(environment.BOT_TIME_ZONE);
}

/** The message id every composed prompt carries, so a replayed thread cannot accumulate copies. */
export function promptMessageId(agentId: string): string {
  return `laf-prompt:${agentId}`;
}

/**
 * Threads written before the prompt moved here still hold the old English standing-role message.
 *
 * Filtered out by id on the way past rather than migrated: a snapshot is a record of what was said,
 * and rewriting history to make today's prompt look like it was always there is a worse lie than
 * one stale system message the model never sees.
 */
function isSupersededPrompt(id: unknown, agentId: string): boolean {
  return id === promptMessageId(agentId) || id === `standing-role:${agentId}`;
}

/**
 * Everything the Bot reads before the first word of the conversation, as one system message.
 *
 * An ordinary AG-UI system message rather than `forwardedProps` or framework-specific state,
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server
 * and a system message is the only thing all of them already understand.
 *
 * IT IS THE WHOLE PROMPT. `agent-bot` used to prepend a system prompt of its own — upstream's
 * English original — and this message was the second one after it. Two authors for one prompt is
 * how a rule gets contradicted by a rule nobody remembered writing, so the service now sends
 * nothing of its own and this is all there is.
 */
export function botPromptMessage(
  profile: AgentStandingProfile,
  options: { mode: PromptMode; now: Date; timeZone: string },
): StandingRoleMessage {
  return {
    id: promptMessageId(profile.id),
    role: "system",
    content: composePrompt({
      mode: options.mode,
      now: options.now,
      timeZone: options.timeZone,
      bot: { id: profile.id, name: profile.name, title: profile.title },
      standingRole: profile.roleDescription,
      ...(profile.memories ? { memories: profile.memories } : {}),
      ...(profile.skills ? { skills: profile.skills } : {}),
    }),
  };
}

export type RuntimeModel = {
  provider: "openai";
  defaultModel: string;
  /**
   * Whether this deployment's model takes an effort setting.
   *
   * False sends nothing, whatever a Bot's own setting says. A model that does not reason answers a
   * request carrying the parameter with a 400 on some providers and silence on others, and the one
   * thing this must not do is turn a Bot that works into a Bot that errors because somebody moved a
   * slider. The surface reads the same flag and hides the control, so nobody is offered a choice
   * that does nothing.
   */
  supportsEffort: boolean;
};

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui";
  configuration: unknown;
  title: string;
  roleDescription: string;
  /** Absent on a row read by something that does not select it; `balanced` is the column's default. */
  effort?: AgentEffort;
  /**
   * What this Bot has learned about the person the row was read for.
   *
   * Absent on a row read outside a person's request — a registry listing has no "the person" to
   * scope memories to, and a Bot carrying somebody else's is the one failure this must not have.
   */
  memories?: readonly string[];
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  /*
   * A `built_in` row resolves to nothing.
   *
   * The enum value stays — old audit rows and old snapshots name it — but nothing constructs one:
   * migration 0024 released the packaged Bots as ordinary remote ones and the package ships
   * `agents: []`. Answering null rather than throwing keeps one stray row from taking a person's
   * whole roster down with it; `resolveRuntimeAgents` still refuses a roster that resolves to
   * nothing at all, which is the case worth failing on.
   */
  if (row.type === "built_in") return null;

  const endpoint = row.configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        profile: {
          id: row.id,
          name: row.name,
          title: row.title,
          roleDescription: row.roleDescription,
          ...(row.memories ? { memories: row.memories } : {}),
        },
        effort: row.effort ?? "balanced",
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build the AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
  /** The clock a Bot is told about. Read from the environment once, at the top of the app. */
  timeZone: string = botTimeZone(),
  /** Files long tool results on the Bot's computer. Absent — no computer — forwards them whole. */
  spill?: ResultSpill,
): Record<string, AbstractAgent> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.id,
      buildAgent(agent, model, stallGuard, timeZone, spill),
    ]),
  );
}

function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  stallGuard: StallGuard | undefined,
  timeZone: string,
  spill: ResultSpill | undefined,
): AbstractAgent {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  return remoteAgentWithPrompt(agent, model.supportsEffort, {
    timeZone,
    ...(stallGuard ? { stallGuard } : {}),
    ...(spill ? { spill } : {}),
  });
}

type ToolResultMessage = Extract<AgentMessage, { role: "tool" }>;

/**
 * A tool result as the endpoint is shown it: whole, or the head of it and where the whole is.
 *
 * Here, in the one middleware every run path goes through, rather than in `agent-bot`: the server
 * is the process that has the computer, the Bot's id and no credential to mint, and a room turn
 * or a routine step resends its results through exactly this seam. See computer/spillover.ts for
 * why the run that received a result still gets all of it.
 */
function filedToolResult(
  message: ToolResultMessage,
  botId: string,
  spill: ResultSpill,
): ToolResultMessage {
  const text = textOf(message.content);
  const shown = spill.forModel(botId, message.toolCallId, text);
  return shown === text ? message : { ...message, content: shown };
}

/**
 * A remote AG-UI agent that composes its whole prompt on every run.
 *
 * THIS IS THE ONE SEAM. Chat, rooms, routines and one Bot asking another all resolve their agents
 * through here, so this middleware is the only place that has to know what a Bot is told — and the
 * only place that has to be changed when that changes. Standard AG-UI middleware rather than a
 * request transformation on one provider's client, so the same Bot works against any endpoint that
 * speaks the protocol.
 *
 * Composed per run rather than per load, because it says what time it is. Any copy already in the
 * conversation — this run's id, or the old `standing-role:` message a thread was saved with before
 * the prompt moved — is dropped: the endpoint receives exactly one, first, however many times the
 * thread has been replayed.
 *
 * The stall watch goes on the fetch rather than into this middleware, because the middleware works
 * in AG-UI events and a stall is the absence of one. The thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 */
function remoteAgentWithPrompt(
  agent: RegisteredRemoteAgent,
  /** Whether this deployment's model takes an effort setting. See `RuntimeModel.supportsEffort`. */
  supportsEffort: boolean,
  options: { timeZone: string; stallGuard?: StallGuard; spill?: ResultSpill },
) {
  const { timeZone, stallGuard, spill } = options;
  const remote = new HttpAgent({
    url: agent.endpoint,
    agentId: agent.id,
    // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
    // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
    ...(agent.headers ? { headers: agent.headers } : {}),
    ...(stallGuard
      ? { fetch: stallGuard.watch({ id: agent.id, name: agent.name }) }
      : {}),
  });
  remote.use((input, next) => {
    const forwarded =
      typeof input.forwardedProps === "object" && input.forwardedProps !== null
        ? (input.forwardedProps as Record<string, unknown>)
        : {};
    const prompt = botPromptMessage(agent.profile, {
      // What the run says it is. Chat says nothing, and silence is a chat.
      mode: promptModeOf(forwarded),
      now: new Date(),
      timeZone,
    });
    return next.run({
      ...input,
      messages: [
        prompt,
        ...input.messages
          .filter((message) => !isSupersededPrompt(message.id, agent.id))
          .map((message) =>
            spill && message.role === "tool"
              ? filedToolResult(message, agent.id, spill)
              : message,
          ),
      ],
      /*
       * WHAT THE ENDPOINT IS TOLD ABOUT THIS RUN, beside the conversation.
       *
       * `botId` because `agent-bot` had no way to know which Bot it was answering — the Bot's whole
       * identity arrived as a system message, which a log line cannot be written from. Every other
       * service in this deployment names the Bot in its logs and that one could not.
       *
       * `effort` on the run rather than in a configuration: a remote Bot's model is answered by the
       * endpoint, not here, so the setting has to travel — and this middleware is the one place
       * every run path goes through, so chat, rooms and routines all carry it without any of them
       * knowing. OUR WORD, NOT THE PROVIDER'S: `thorough`, not `high`, because each end translates
       * its own spelling and adding a third API is then one file. Omitted entirely, not defaulted,
       * where the deployment's model takes no effort setting.
       *
       * Merged over whatever the caller forwarded rather than replacing it.
       */
      forwardedProps: {
        ...forwarded,
        botId: agent.id,
        ...(supportsEffort ? { effort: agent.effort } : {}),
      },
    });
  });
  return remote;
}

class UnavailableAgent extends AbstractAgent {
  private readonly reason: string;

  constructor(agent: RegisteredUnavailableAgent) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

/**
 * No model credential is resolved here any more.
 *
 * It was only ever needed by the built-in branch, which held the key itself and called the provider
 * from this process. Every Bot is an AG-UI endpoint now and the key lives where the call is made —
 * `agent-bot`'s own environment, and `askModel` for auto-review and write-ups, which still resolve
 * it from the vault.
 */
export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  stallGuard?: StallGuard,
  timeZone: string = botTimeZone(),
  spill?: ResultSpill,
): Promise<Record<string, AbstractAgent>> {
  const registered = await loadAgents();
  /*
   * AN EMPTY ROSTER IS A CORRECT STATE. This used to throw "No agents are registered", which was
   * true when every deployment shipped built-in Bots and an empty roster meant a broken package.
   * Deployments ship none now: every account is legitimately empty for its first minute, and again
   * the moment somebody deletes their last Bot — and the throw turned the first screen of the
   * product into a 500 on `/info` plus a 404 on the chat endpoint (measured on a cold first run).
   * A run against a Bot that does not exist still fails where it always did, by name.
   */
  if (registered.length === 0) return {};
  return buildAgents(registered, model, stallGuard, timeZone, spill);
}

/** Who is asking. Agent visibility is decided per person, so a run has to know this first. */
export type IdentifyActor = (request: Request) => Promise<AgentActor>;

/** Loads exactly the agents one person may see, already carrying their standing roles. */
export type LoadAgentsForActor = (
  actor: AgentActor,
) => Promise<RegisteredAgent[]>;

/**
 * Build the runtime's per-request agent factory.
 *
 * Resolution is per request, not per boot, because who may run a coworker is a property of the
 * person asking: a private coworker must be absent for everybody else, and a role edited a moment
 * ago must apply to the next run without a restart. Both fall out of rebuilding the map here.
 */
export function createRequestAgents(
  identifyActor: IdentifyActor,
  loadAgents: LoadAgentsForActor,
  model: RuntimeModel,
  /**
   * Shared across every request rather than built per run, because it is the thing that has to
   * outlive one: the sweep that notices a silent stream has to still be running after the request
   * that opened it has been answered.
   */
  stallGuard?: StallGuard,
  timeZone: string = botTimeZone(),
  spill?: ResultSpill,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      stallGuard,
      timeZone,
      spill,
    );
  };
}

/**
 * Mount the CopilotKit endpoint onto the host Hono app.
 *
 * `agents` is a factory rather than a fixed map so a Bot registered while the server is running is
 * reachable on the next request. Resolving once at boot would mean every new Bot needed a restart,
 * which is not a property you can explain to somebody who just created one.
 */
export function mountCopilotRuntime(
  model: RuntimeModel,
  loadAgents: LoadAgentsForActor,
  identifyActor: IdentifyActor,
  /**
   * The watch on Bot streams. Not optional, unlike the parameter it forwards to: a guard built from
   * a timeout of zero already watches nothing, so an unconfigured deployment has one to hand and
   * there is no reason for a caller to have to say `undefined` here to reach `basePath`.
   */
  stallGuard: StallGuard,
  /** The durable runner every turn goes through. */
  localRunner: AgentRunner,
  basePath = "/api/copilotkit",
  /** Files long tool results on the Bot's computer. See computer/spillover.ts. */
  spill?: ResultSpill,
) {
  const agents = createRequestAgents(
    identifyActor,
    loadAgents,
    model,
    stallGuard,
    botTimeZone(),
    spill,
  );

  const runtime = new CopilotRuntime({
    runner: localRunner,
    agents: agents as never,
  });
  return createCopilotHonoHandler({ runtime, basePath });
}
