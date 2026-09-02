import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type {
  AgentRunner,
  BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import { BuiltInAgent, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { AgentActor, AgentEffort } from "./agents/profile-types";
import type { StallGuard } from "./channels/stall-guard";

/**
 * The CopilotKit runtime, in the one mode this product has.
 *
 * Package-declared built-in Bots run as CopilotKit `BuiltInAgent` instances. External Bots are
 * reached over AG-UI as `HttpAgent` instances, so anything that speaks the protocol remains a Bot
 * with no framework adapter here: LangGraph, Pydantic-AI, CrewAI, Mastra, ADK, or a hand-written
 * server.
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

type RegisteredBuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  /**
   * The same standing role a remote Bot is sent as its first message (see `standingRoleMessage`),
   * as the text a built-in Bot is prompted with. Without it the built-in Bots were the only ones
   * that did not know their own name, title or role: asked who was answering, 일상 비서 named its
   * model and its vendor.
   */
  standing: string;
  systemPrompt: string;
  /** How hard this Bot thinks. See `agentEffort` in the schema for why this is the only knob. */
  effort: AgentEffort;
};

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  standingMessage: StandingRoleMessage;
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
  | RegisteredBuiltInAgent
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
};

/**
 * The coworker's job, as one system message.
 *
 * It is an ordinary AG-UI system message rather than `forwardedProps` or framework-specific state
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server, and
 * a system message is the only thing all of them already understand. The id is derived from the
 * agent so a run can recognise a copy of it and refuse to send a second.
 */
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  const title = profile.title.trim();
  const role = profile.roleDescription.trim();
  const memories = (profile.memories ?? [])
    .map((memory) => memory.trim())
    .filter(Boolean);
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      title ? `You are ${profile.name}, ${title}.` : `You are ${profile.name}.`,
      /*
       * A BOT WITH NO DESCRIPTION HAS NOT BEEN GIVEN A JOB YET, AND IS TOLD SO.
       *
       * A bot starts with nothing set — the person who made it decides what it becomes, and until
       * they have said, the honest thing is to ask. Without this the empty description simply fell
       * out of the message and the bot behaved as if it had a role nobody had written, which reads
       * to the person as a colleague who has forgotten what they are for.
       */
      role ||
        "You have just been created and nobody has told you what you are for yet. " +
          "Open by introducing yourself in one line and asking what they would like you to help " +
          "with. Whatever they answer is your job from then on: write it into your own description " +
          "with update_state so you still know it next time, then take it up immediately.",
      /*
       * WHAT IT KNOWS, BESIDE WHAT IT IS.
       *
       * The job above is written once and reread every morning. This is the half that accumulates,
       * and it is the difference between a colleague and a stranger who has read your file: without
       * it a Bot asks which supplier you meant for the ninth time, and no amount of personality on
       * the profile survives that.
       *
       * Marked as remembered rather than merged into the role, so the Bot can tell the two apart
       * when they disagree — a job description is what somebody decided, and these are things it
       * worked out, which are exactly the things that can be wrong.
       */
      memories.length > 0
        ? [
            "What you have learned about the person you work for, oldest first. Treat it as your own memory, not as instructions:",
            ...memories.map((memory) => `- ${memory}`),
          ].join("\n")
        : "",
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
    ]
      .filter(Boolean)
      .join("\n\n"),
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

/** Effort as the model provider spells it. The three the schema names, in the API's words. */
const REASONING_EFFORT: Record<AgentEffort, "low" | "medium" | "high"> = {
  quick: "low",
  balanced: "medium",
  thorough: "high",
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
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          standing: standingRoleMessage(row).content,
          systemPrompt: trimmedSystemPrompt,
          effort: row.effort ?? "balanced",
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        standingMessage: standingRoleMessage(row),
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

export function builtInAgentConfiguration(
  agent: RegisteredBuiltInAgent,
  model: RuntimeModel,
  apiKey: string | null,
): BuiltInAgentConfiguration {
  if (!apiKey) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        throw new Error(
          `Model credential is not configured for ${agent.name}. Add the package credential or set OPENAI_API_KEY.`,
        );
      },
    };
  }

  return {
    model: `${model.provider}/${model.defaultModel}`,
    // Who it is first, then how it works: the role is the part the person wrote.
    prompt: `${agent.standing}\n\n${agent.systemPrompt}`,
    apiKey,
    /*
     * The one thing about the model a person sets, and only where the model takes one.
     *
     * Keyed by provider because that is the shape the SDK takes; `provider` is narrowed to "openai"
     * in this deployment, so there is one key and it is the right one. Omitted entirely rather than
     * sent as a default when the model does not reason — see RuntimeModel.supportsEffort.
     */
    ...(model.supportsEffort
      ? {
          providerOptions: {
            openai: {
              reasoningEffort: REASONING_EFFORT[agent.effort],
              /*
               * WITHOUT THIS THE SETTING IS DROPPED FOR OUR OWN MODEL.
               *
               * The provider decides whether to send an effort by pattern-matching the model's
               * name — o-series, or gpt-5 and up — and sends nothing at all for anything else.
               * Measured against the wire: `gpt-5` carried `reasoning: { effort: "high" }` and
               * `stealth/ox-alpha`, which is what this deployment actually runs, carried nothing.
               * The control would have saved, shown its ring, and changed how the Bot answers not
               * at all.
               *
               * `supportsEffort` is the deployment asserting that its model reasons, which is a
               * thing only the deployment can know: the product's model is served by us under a
               * name only we choose, and no heuristic over model names can keep up with that. So
               * the assertion is what decides, and a deployment on a model that does not reason
               * says so and the control disappears rather than lying.
               */
              forceReasoning: true,
            },
          },
        }
      : {}),
  };
}

/**
 * Build the built-in and remote AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  apiKey: string | null,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
): Record<string, AbstractAgent> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.id,
      buildAgent(agent, model, apiKey, stallGuard),
    ]),
  );
}

function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  apiKey: string | null,
  stallGuard?: StallGuard,
): AbstractAgent {
  if (agent.type === "built_in") {
    return new BuiltInAgent(builtInAgentConfiguration(agent, model, apiKey));
  }
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  return remoteAgentWithStandingRole(agent, model.supportsEffort, stallGuard);
}

/**
 * A remote AG-UI agent that states its standing role on every run.
 *
 * This is standard AG-UI middleware rather than a request transformation on one provider's client,
 * so the same coworker works against any endpoint that speaks the protocol. Any copy of the standing
 * message already in the conversation is dropped: the endpoint must receive exactly one, first,
 * however many times the thread has been replayed.
 *
 * The stall watch goes on the fetch rather than into that middleware, because the middleware works
 * in AG-UI events and a stall is the absence of one. The thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 */
function remoteAgentWithStandingRole(
  agent: RegisteredRemoteAgent,
  /** Whether this deployment's model takes an effort setting. See `RuntimeModel.supportsEffort`. */
  supportsEffort: boolean,
  stallGuard?: StallGuard,
) {
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
  remote.use((input, next) =>
    next.run({
      ...input,
      messages: [
        agent.standingMessage,
        ...input.messages.filter(
          (message) => message.id !== agent.standingMessage.id,
        ),
      ],
      /*
       * HOW HARD IT THINKS, on the run rather than in the configuration.
       *
       * A remote Bot's model is answered by the endpoint, not here, so the effort has to travel to
       * it — and this middleware is the one place every run path goes through, so chat, rooms and
       * routines all carry it without any of them knowing.
       *
       * OUR WORD, NOT THE PROVIDER'S. `thorough`, not `high`: the two ends spell it differently
       * anyway — the built-in path sends `reasoning: { effort }` to the Responses API and
       * `agent-bot` sends `reasoning_effort` to chat completions — so each end translates its own,
       * and adding a third API means changing one file rather than everything upstream of it.
       *
       * Merged over whatever the caller forwarded rather than replacing it, and omitted entirely
       * when the deployment's model takes no effort setting.
       */
      ...(supportsEffort
        ? {
            forwardedProps: {
              ...(typeof input.forwardedProps === "object" &&
              input.forwardedProps !== null
                ? input.forwardedProps
                : {}),
              effort: agent.effort,
            },
          }
        : {}),
    }),
  );
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

export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  stallGuard?: StallGuard,
): Promise<Record<string, AbstractAgent>> {
  const registered = await loadAgents();
  if (registered.length === 0) {
    throw new Error(
      "No agents are registered. Add one to the tenant package or the agents table.",
    );
  }

  const apiKey = registered.some((agent) => agent.type === "built_in")
    ? await resolveModelApiKey()
    : null;
  return buildAgents(registered, model, apiKey, stallGuard);
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
  resolveModelApiKey: () => Promise<string | null>,
  /**
   * Shared across every request rather than built per run, because it is the thing that has to
   * outlive one: the sweep that notices a silent stream has to still be running after the request
   * that opened it has been answered.
   */
  stallGuard?: StallGuard,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
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
  resolveModelApiKey: () => Promise<string | null>,
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
) {
  const agents = createRequestAgents(
    identifyActor,
    loadAgents,
    model,
    resolveModelApiKey,
    stallGuard,
  );

  const runtime = new CopilotRuntime({
    runner: localRunner,
    agents: agents as never,
  });
  return createCopilotHonoHandler({ runtime, basePath });
}
