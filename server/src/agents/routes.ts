import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { describeFailure, NOT_FOUND } from "../failure-text";
import { isCatalogueKey } from "../insights/catalogue-key";
import { log } from "../log";
import { testAgentConnection } from "./connection-test";
import { type CoworkerCall, CoworkerCallError } from "./coworker-call";
import { checkAgentEndpoint } from "./endpoint";
import {
  type AgentMemoryStore,
  looksLikeAnInstruction,
  looksLikeASecret,
  MAX_MEMORY_LENGTH,
  MemoryFullError,
} from "./memory-store";
import { canManageAgent } from "./profile-policy";
import { profileTextOf } from "./profile-text";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ProtectedAgentError,
  RosterFullError,
} from "./profile-store";
import {
  AGENT_EFFORTS,
  type AgentActor,
  type AgentEffort,
  type AgentPreferencePatch,
  type AgentProfile,
  type CreateAgentInput,
} from "./profile-types";

/**
 * Which refusal it is, as a code and never as a sentence.
 *
 * The parser carried an English sentence beside each of these until 2026-09-11, and the route
 * answered with it; the surface phrases the code in Korean (`AGENT_REFUSALS`), so the sentences
 * went, and a refusal that is only a code cannot leak one (audit A1-3).
 */
export type AgentInputRefusal =
  | "laf:agent_input_not_object"
  | "laf:agent_name_invalid"
  | "laf:agent_title_too_long"
  | "laf:agent_role_too_long"
  | "laf:agent_endpoint_refused"
  | "laf:agent_avatar_invalid"
  | "laf:agent_effort_invalid"
  | "laf:agent_auto_review_too_long"
  | "laf:agent_auth_header_invalid"
  | "laf:agent_preset_invalid";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; code: AgentInputRefusal };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  endpoint?: unknown;
  avatarSeed?: unknown;
  effort?: unknown;
  autoReview?: unknown;
  presetId?: unknown;
  auth?: unknown;
};

/**
 * Parse and validate what a user typed into the agent form.
 *
 * `allowPrivateHosts` is passed in rather than read from configuration here so this stays a pure
 * function: a developer's own agent lives on localhost, and a hosted deployment must refuse exactly
 * that, so the answer depends on the deployment and the test suite needs to exercise both.
 */
export function parseAgentInput(
  input: unknown,
  allowPrivateHosts = false,
): AgentInputParseResult {
  if (!isAgentInputObject(input)) {
    return { ok: false, code: "laf:agent_input_not_object" };
  }

  const name = boundedText(input.name, 80, "laf:agent_name_invalid");
  if (typeof name !== "string") return name;

  /*
   * OPTIONAL, BOTH OF THEM. A bot starts with nothing set and can become anything; forcing a job
   * description out of somebody before they have met the bot is the shape we just removed from the
   * deployment package. A bot with no description opens by asking what it is for
   * (see `composePrompt`), which is the honest version of an empty field.
   */
  const title = optionalBoundedText(
    input.title,
    120,
    "laf:agent_title_too_long",
  );
  if (typeof title !== "string") return title;

  const roleDescription = optionalBoundedText(
    input.roleDescription,
    1000,
    "laf:agent_role_too_long",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  // The endpoint is optional and checked. Absent means the Bot in the box, which is what most people
  // want on their first go. Present means this server will POST to an address a person chose, so it
  // goes through the same target check as navigation before it is allowed anywhere near the database.
  let endpoint: string | undefined;
  if (input.endpoint !== undefined && input.endpoint !== "") {
    const verdict = checkAgentEndpoint(input.endpoint, { allowPrivateHosts });
    if (!verdict.allowed) {
      return { ok: false, code: "laf:agent_endpoint_refused" };
    }
    endpoint = verdict.url;
  }

  // Optional, and only ever a name from a set the client already has. Bounded and pattern-checked
  // rather than trusted, because it is written to a row and read back into every roster; a seed is
  // not a URL and must not be able to become one.
  let avatarSeed: string | undefined;
  if (input.avatarSeed !== undefined) {
    const supplied =
      typeof input.avatarSeed === "string" ? input.avatarSeed.trim() : "";
    if (
      !supplied ||
      supplied.length > 64 ||
      !/^[A-Za-z0-9._:-]+$/.test(supplied)
    ) {
      return { ok: false, code: "laf:agent_avatar_invalid" };
    }
    avatarSeed = supplied;
  }

  // Optional, and one of exactly three. Checked against the list rather than passed through, because
  // it reaches a Postgres enum: an unknown value is a failed transaction at write time rather than a
  // 400 here, which is the same outcome dressed as a server fault.
  let effort: AgentEffort | undefined;
  if (input.effort !== undefined) {
    const supplied =
      typeof input.effort === "string" ? input.effort.trim() : "";
    if (!AGENT_EFFORTS.includes(supplied as AgentEffort)) {
      return { ok: false, code: "laf:agent_effort_invalid" };
    }
    effort = supplied as AgentEffort;
  }

  /*
   * The standing instruction for waving actions through. Optional, and an empty string is a real
   * value: it is how somebody takes the instruction back.
   *
   * Bounded like the role description, and for a sharper reason. It is put in front of a model on
   * the path of every stopped action, so its length is latency a Bot waits through — and an
   * instruction nobody can hold in their head is one nobody can check either.
   */
  const autoReview = optionalBoundedText(
    input.autoReview,
    1000,
    "laf:agent_auto_review_too_long",
  );
  if (typeof autoReview !== "string") return autoReview;

  /*
   * Which preset a person picked, when the press that sent this was one. A catalogue key and never
   * the preset's words: those arrive as the title and the role, translated, and this is what stays
   * countable after the language changes (`agentProfiles.presetId`). Refused rather than dropped
   * when it is not key-shaped, because the only sender is our own intro card, and a card that sent
   * something else is a bug worth a 400 rather than a pick that silently goes uncounted.
   */
  let presetId: string | undefined;
  if (input.presetId !== undefined) {
    if (!isCatalogueKey(input.presetId)) {
      return { ok: false, code: "laf:agent_preset_invalid" };
    }
    presetId = input.presetId;
  }

  // The key is optional and write-only. An absent field leaves an existing key alone; sending one
  // replaces it. There is no way to read one back, here or anywhere.
  let auth: { header: string; value: string } | undefined;
  if (input.auth !== undefined && input.auth !== null) {
    const supplied = input.auth as { header?: unknown; value?: unknown };
    const value =
      typeof supplied.value === "string" ? supplied.value.trim() : "";
    if (value) {
      const header =
        typeof supplied.header === "string" && supplied.header.trim()
          ? supplied.header.trim()
          : "Authorization";
      if (!/^[A-Za-z0-9-]+$/.test(header)) {
        return { ok: false, code: "laf:agent_auth_header_invalid" };
      }
      auth = { header, value };
    }
  }

  return {
    ok: true,
    value: {
      name,
      title,
      roleDescription,
      endpoint,
      auth,
      ...(avatarSeed === undefined ? {} : { avatarSeed }),
      ...(effort === undefined ? {} : { effort }),
      // Sent whenever the field was present, empty string included, because clearing it is a thing
      // somebody does on purpose. `optionalBoundedText` answers "" for an absent field too, so the
      // presence check is on the input rather than on what came back.
      ...(input.autoReview === undefined ? {} : { autoReview }),
      ...(presetId === undefined ? {} : { presetId }),
    },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts = false,
  /** One Bot asking another. Absent when the deployment has no runtime to run the coworker on. */
  coworkerCall?: CoworkerCall,
  /**
   * Which of a person's Bots are mid-run. Absent answers "none", which is the right degraded
   * behaviour: a roster that cannot reach the ledger should look calm, not broken.
   */
  readWorking?: (userId: string) => Promise<
    Array<{
      agentId: string;
      origin: string;
      label: string | null;
      startedAt: string;
    }>
  >,
  /**
   * What each Bot has learned about the person talking to it.
   *
   * Absent leaves the endpoints off entirely rather than answering empty, so a deployment without
   * the store says "this Bot cannot remember" by 404 instead of by drawing an always-empty list —
   * a screen that shows nothing is indistinguishable from a Bot that has learned nothing.
   */
  memoryStore?: AgentMemoryStore,
  /**
   * What a Bot is handed the moment it exists. Last, like everything new here.
   *
   * The deployment-wide tools (`plugins/public-data-rest.ts`) are granted to every Bot at boot,
   * and a Bot made after boot would otherwise wait for the next restart to hear of them — a
   * capability the screen promises and the new Bot does not have. The owner travels with the id
   * because the other thing a new Bot is handed is scoped by person: the partner channels they
   * connected before it existed (`plugins/partners.ts`), which until 2026-09-06 reached only the
   * Bots of the day they connected. Never fails the create: the Bot exists by the time this runs,
   * and a grant that could not be written is repaired at the next boot or the next connect.
   */
  onCreated?: (agentId: string, ownerUserId: string) => Promise<void>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * `POST /:agentId/declined` used to be here, and is gone with `report_refusal`.
   *
   * It wrote a `bot.declined` audit row saying a Bot had turned something down. Nothing was
   * prevented by it and nothing read it but the trail; it existed because a tool description told
   * the model to call it, which cost about 150 tokens of schema on every single turn and only ever
   * recorded the refusals a model chose to announce. A Bot that declines and says nothing wrote
   * nothing, so the list was never the answer to "what is this Bot being asked to do" either.
   *
   * The `bot.declined` event type and its label stay: rows written before this exist in deployed
   * trails, and a row nothing can name reads as a bug.
   */

  routes.get("/", requireUser, async (context) => {
    try {
      const hidden = context.req.query("hidden") === "true";
      const agents = await store.list(context.var.actor, hidden);
      return context.json({
        agents: agents.map((agent) => agentDto(context.var.actor, agent)),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * BEFORE `/:agentId`, or "working" is read as an agent id — which is exactly what happened:
   * the route answered 404 "Agent not found." for a request that never named an agent.
   *
   * A list rather than a flag per Bot: the answer is usually empty, and a roster of forty Bots
   * should not pay forty fields to be told nothing is happening.
   */
  routes.get("/working", requireUser, async (context) => {
    if (!readWorking) return context.json({ working: [] });
    try {
      return context.json({
        working: await readWorking(context.var.actor.id),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:agentId", requireUser, async (context) => {
    try {
      const agent = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!agent) {
        return context.json(
          { error: "laf:agent_not_found", code: "laf:agent_not_found" },
          404,
        );
      }
      return context.json({ agent: agentDto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Try an endpoint before saving it.
   *
   * Deliberately not part of create: a person needs to know whether their agent answers before they
   * commit to it, and they need to be able to try again without creating dead
   * Bots on the way. It runs the same target check as saving, so it cannot probe addresses that
   * registration would refuse.
   */
  routes.post("/test-connection", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      endpoint?: unknown;
      headers?: unknown;
    } | null;
    const headers =
      body?.headers && typeof body.headers === "object"
        ? (body.headers as Record<string, string>)
        : undefined;
    const result = await testAgentConnection(body?.endpoint, {
      headers,
      allowPrivateHosts,
    });
    // 200 either way: the request succeeded, and the verdict is the payload. A failed connection test
    // is an answer, not an error, and a 4xx here would have the surface render it as a broken button.
    return context.json(result);
  });

  routes.post("/", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
    );
    if (!parsed.ok)
      return context.json({ error: parsed.code, code: parsed.code }, 400);

    try {
      const agent = await store.create(context.var.actor, parsed.value);
      if (onCreated) {
        // The Bot exists whatever happens here; a grant that did not land is repaired at boot.
        await onCreated(
          agent.id,
          agent.ownerUserId ?? context.var.actor.id,
        ).catch((error: unknown) => {
          log.error("agent_created_hook_failed", {
            agent: agent.id,
            reason: describeFailure(error),
          });
        });
      }
      return context.json({ agent: agentDto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:agentId", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
    );
    if (!parsed.ok)
      return context.json({ error: parsed.code, code: parsed.code }, 400);

    try {
      const agent = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        parsed.value,
      );
      return context.json({ agent: agentDto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * One Bot asks another, and waits for the answer.
   *
   * `from` names the calling Bot for the trail and the self-call check; it is not authorisation —
   * the person driving the caller is the actor, and requireUser already named them. The coworker
   * runs server-side with no tools, so this cannot chain (see coworker-call.ts).
   */
  routes.post("/:agentId/ask", requireUser, async (context) => {
    if (!coworkerCall) {
      return context.json(
        {
          error: "laf:coworker_unavailable",
          code: "laf:coworker_unavailable",
        },
        501,
      );
    }
    const body = (await context.req.json().catch(() => null)) as {
      message?: unknown;
      from?: unknown;
      depth?: unknown;
    } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const from = typeof body?.from === "string" ? body.from : "";
    if (!from) {
      return context.json(
        {
          error: "laf:coworker_from_required",
          code: "laf:coworker_from_required",
        },
        400,
      );
    }
    /*
     * How deep the asker already is. The browser's tool never says, and is depth 0: a Bot a
     * person is driving. A caller that is itself a delegated run says so and is refused — a
     * claim of depth can only ever refuse the claimant, so it is not a thing worth lying about.
     */
    const depth =
      typeof body?.depth === "number" && Number.isFinite(body.depth)
        ? Math.max(0, Math.floor(body.depth))
        : 0;
    try {
      const answer = await coworkerCall.ask(
        context.var.actor,
        from,
        context.req.param("agentId"),
        message,
        { depth },
      );
      return context.json({ answer });
    } catch (error) {
      if (error instanceof CoworkerCallError) {
        /*
         * The code and its numbers, never the sentence. The sentence was written for the asking
         * MODEL, and the browser's tool builds the model's text and the person's line from these
         * (`app/src/lib/copilot/coworker-tools.tsx`); a 502's sentence was the provider's own.
         */
        return context.json(
          { ...error.facts, error: error.code, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /**
   * A Bot rewriting its own profile.
   *
   * The product model is that a Bot is a name, a description and a face, and that what it becomes
   * is settled by talking to it rather than by filling a form once. That only works if the Bot can
   * write the answer down: told "from now on you handle the invoices", it says so here and still
   * knows it next week, in every conversation, without the person opening a settings screen.
   *
   * A PATCH of only what changed, unlike `PATCH /:agentId`, which is the edit form and replaces the
   * whole record. A Bot asked to change its name must not silently clear its own description.
   *
   * Authorisation is unchanged: the request carries the person's session and the store still
   * refuses anybody who may not manage this Bot. A Bot cannot edit a colleague this way — the id in
   * the path is the Bot the tool call came from, and the tool passes its own.
   */
  routes.post("/:agentId/profile", requireUser, async (context) => {
    const patch = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    /*
     * FACT CODES, because the caller is a Bot's own tool.
     *
     * The `update_profile` handler used to invent its own English sentences for these — server
     * prose written in the browser, which no Korean reader and no other caller of this endpoint
     * could use. The sentence stays for operators; the code is what the surface and the Bot both
     * read.
     */
    if (!patch || typeof patch !== "object") {
      return context.json(
        {
          error: "laf:profile_invalid",
          code: "laf:profile_invalid",
        },
        400,
      );
    }
    if (Object.keys(patch).length === 0) {
      return context.json(
        { error: "laf:profile_no_fields", code: "laf:profile_no_fields" },
        400,
      );
    }

    try {
      const current = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!current) {
        return context.json(
          { error: "laf:profile_not_found", code: "laf:profile_not_found" },
          404,
        );
      }

      /*
       * ONE LINE EACH, AND NOT A PROMPT. These three become part of every later system message
       * (`shared/prompt/index.ts`), and this endpoint is the one a page reaches by telling the Bot
       * to call `update_profile`. See profile-text.ts.
       */
      const name = profileTextOf(patch.name);
      const title = profileTextOf(patch.title);
      const roleDescription = profileTextOf(patch.roleDescription);
      if (!name.ok || !title.ok || !roleDescription.ok) {
        // The code and not the text: echoing what was refused would deliver it after all.
        return context.json(
          {
            error: "laf:profile_looks_like_prompt",
            code: "laf:profile_looks_like_prompt",
          },
          400,
        );
      }

      // Merged before validation, so the same rules that guard the edit form guard this too.
      const merged = parseAgentInput(
        {
          name: name.value ?? current.name,
          title: title.value ?? current.title,
          roleDescription: roleDescription.value ?? current.roleDescription,
          ...(patch.avatarSeed === undefined
            ? {}
            : { avatarSeed: patch.avatarSeed }),
          // Absent leaves it alone, like the face. A Bot writing its own description must not reset
          // how hard it thinks as a side effect of doing so.
          ...(patch.effort === undefined ? {} : { effort: patch.effort }),
          /*
           * `autoReview` IS DELIBERATELY NOT HERE, and this is the security line of the whole
           * feature. This endpoint is what a Bot's own `update_profile` tool calls. A Bot that could
           * write the instruction deciding whether it gets asked about would have no boundary at
           * all, and the shortest path from a helpful Bot to that is a page telling it to be
           * helpful. It is edited on the profile screen by a person, through PATCH, and nowhere
           * else. Sending it here changes nothing rather than failing, because a Bot being told
           * "no" is a Bot that tries again in another shape.
           *
           * NOR IS `presetId`. It is the record of what a person picked the Bot to be, and a Bot
           * rewriting its own job must not rewrite that record on the way — the count it feeds is
           * what people chose, not what their Bots became.
           */
        },
        allowPrivateHosts,
      );
      if (!merged.ok) {
        return context.json(
          { error: "laf:profile_invalid", code: "laf:profile_invalid" },
          400,
        );
      }

      const agent = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        merged.value,
      );
      return context.json({ agent: agentDto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * WHAT THIS BOT REMEMBERS, AND HOW TO MAKE IT STOP.
   *
   * The competing product stores this and cannot show it — its own documentation says you cannot
   * inspect, correct, export, or delete individual memories. That is the whole reason these three
   * endpoints exist and the reason memories are rows: a Bot that quietly learned something wrong
   * about somebody's business is the ordinary case, not the edge one, and it has to be fixable in
   * the time it takes to read the sentence.
   *
   * Every one is scoped to the person asking, which on a one-person deployment is every row there
   * is. It is written that way because sign-in is not yet restricted to one person, and because an
   * endpoint that reads by Bot alone is the shape that quietly becomes wrong the day one is.
   */
  /*
   * A BOT THIS PERSON CANNOT SEE HAS NO MEMORIES TO SPEAK OF.
   *
   * All three memory routes went "through the store" and then ignored what it said: `get` answers
   * null for a Bot outside the person's view rather than throwing, so the await was a lookup with
   * no consequence. Measured 2026-09-10 (audit A8, and again in the authorization matrix): a
   * colleague naming the owner's private Bot got 200 and an empty list — nothing of the owner's,
   * since memories are per person, but a 200 that says "this Bot exists" to somebody it is hidden
   * from. The same 404 `GET /:agentId` gives, from the same answer.
   */
  const visibleOr404 = async (
    context: Context<{ Variables: AppVariables }>,
  ): Promise<Response | null> =>
    (await store.get(context.var.actor, context.req.param("agentId") ?? ""))
      ? null
      : context.json(
          { error: "laf:agent_not_found", code: "laf:agent_not_found" },
          404,
        );

  /*
   * A deployment without the memory store answers the way an unmounted route does: `laf:not_found`,
   * the boundary's own code, rather than one of its own that would need words nobody ever reads.
   */
  const noMemoryStore = (context: Context<{ Variables: AppVariables }>) =>
    context.json({ error: NOT_FOUND, code: NOT_FOUND }, 404);

  routes.get("/:agentId/memories", requireUser, async (context) => {
    if (!memoryStore) return noMemoryStore(context);
    try {
      const hidden = await visibleOr404(context);
      if (hidden) return hidden;
      const memories = await memoryStore.list(
        context.req.param("agentId"),
        context.var.actor.id,
      );
      return context.json({ memories });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * The Bot appends one thing it learned.
   *
   * `autoReview` IS NOT REACHABLE FROM HERE, and the reason is the same one that keeps it off the
   * profile endpoint: a Bot that could write the rule deciding whether it gets asked about has no
   * boundary at all. This writes prose the Bot reads back to itself; nothing here is consulted by
   * the gateway, and "remember that payments under fifty are fine to send" changes no decision.
   *
   * NOR IS A SECRET. A memory is reread at the top of every single turn, so a password written
   * here is read by every later conversation, every room and every routine — and it is a row in a
   * table a person can list. The tool's description says not to; a description is not a boundary,
   * and this is (see `looksLikeASecret`).
   */
  routes.post("/:agentId/memories", requireUser, async (context) => {
    if (!memoryStore) return noMemoryStore(context);
    const body = (await context.req.json().catch(() => null)) as {
      content?: unknown;
    } | null;
    const content = typeof body?.content === "string" ? body.content : "";
    if (looksLikeASecret(content)) {
      /*
       * The refused text is NOT echoed back, not in the error and not in the log. Refusing to
       * store a password and then printing it in a 400 body would put it in the browser's network
       * panel, the server's access log and the transcript — three more places than it started in.
       */
      return context.json(
        {
          error: "laf:memory_looks_like_a_secret",
          code: "laf:memory_looks_like_a_secret",
        },
        400,
      );
    }
    /*
     * NOR AN INSTRUCTION. The memory list is read as prompt on every later turn, so a sentence
     * that tells the Bot what to do — rather than what is true about the person — is a rule that
     * survives every session, written by whatever the Bot happened to be reading. Refused by shape
     * (see `looksLikeAnInstruction`); the Bot is told to write the fact instead.
     */
    if (looksLikeAnInstruction(content)) {
      return context.json(
        {
          error: "laf:memory_looks_like_instruction",
          code: "laf:memory_looks_like_instruction",
        },
        400,
      );
    }
    try {
      const hidden = await visibleOr404(context);
      if (hidden) return hidden;
      const memory = await memoryStore.remember(
        context.req.param("agentId"),
        context.var.actor.id,
        content,
      );
      return memory
        ? context.json({ memory }, 201)
        : context.json(
            {
              error:
                content.trim().length > MAX_MEMORY_LENGTH
                  ? "laf:memory_too_long"
                  : "laf:memory_empty",
              code:
                content.trim().length > MAX_MEMORY_LENGTH
                  ? "laf:memory_too_long"
                  : "laf:memory_empty",
            },
            400,
          );
    } catch (error) {
      if (error instanceof MemoryFullError) {
        // 409 like a full roster: the request was well-formed, the memory is simply full. The
        // numbers travel so the surface can say how full; the sentence is the surface's.
        return context.json(
          {
            error: "laf:memory_full",
            code: "laf:memory_full",
            used: error.used,
            cap: error.cap,
          },
          409,
        );
      }
      return mapStoreError(context, error);
    }
  });

  routes.delete(
    "/:agentId/memories/:memoryId",
    requireUser,
    async (context) => {
      if (!memoryStore) return noMemoryStore(context);
      try {
        const hidden = await visibleOr404(context);
        if (hidden) return hidden;
        const forgotten = await memoryStore.forget(
          context.req.param("memoryId"),
          context.var.actor.id,
        );
        // 404 rather than 204 for an id that was never theirs: "done" would tell somebody probing
        // ids which of them exist.
        return forgotten
          ? context.body(null, 204)
          : context.json(
              { error: "laf:memory_not_found", code: "laf:memory_not_found" },
              404,
            );
      } catch (error) {
        return mapStoreError(context, error);
      }
    },
  );

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
      );
      return context.json({ agent: agentDto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/hide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unhide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * ONE ROUTE FOR EVERY PER-PERSON PREFERENCE, not one verb per flag.
   *
   * `/hide` and `/unhide` stay because they are already in the wire and under test, but a pair of
   * verb endpoints per flag does not scale past the first one — the pin and the notification
   * toggle would have been four more. This takes a patch: the keys present are the ones changed.
   *
   * Deliberately NOT gated on `canManage`. A preference is about the reader, not about the Bot:
   * somebody who can only see a shared Bot must still be able to pin it or mute it, and that
   * changes nothing for anybody else.
   */
  routes.post("/:agentId/preferences", requireUser, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const patch = parsePreferencePatch(body);
    if (!patch.ok) {
      return context.json({ error: patch.code, code: patch.code }, 400);
    }

    try {
      await store.setPreferences(
        context.var.actor,
        context.req.param("agentId"),
        patch.value,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:agentId", requireUser, async (context) => {
    try {
      await store.softDelete(context.var.actor, context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function boundedText(
  value: unknown,
  maximumLength: number,
  code: AgentInputRefusal,
): string | { ok: false; code: AgentInputRefusal } {
  if (typeof value !== "string") return { ok: false, code };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, code };
}

/** The same, for a field a person may leave blank. Absent and empty both mean empty. */
function optionalBoundedText(
  value: unknown,
  maximumLength: number,
  code: AgentInputRefusal,
): string | { ok: false; code: AgentInputRefusal } {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { ok: false, code };
  const trimmed = value.trim();
  return trimmed.length <= maximumLength ? trimmed : { ok: false, code };
}

/**
 * A preference patch: only the three known keys, each strictly boolean.
 *
 * An empty patch is rejected rather than treated as a no-op, because the only way to send one is a
 * caller that meant to change something and named it wrong — answering 204 would report success
 * for a request that did nothing.
 */
function parsePreferencePatch(
  body: unknown,
):
  | { ok: true; value: AgentPreferencePatch }
  | { ok: false; code: "laf:preference_invalid" } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, code: "laf:preference_invalid" };
  }
  const object = body as Record<string, unknown>;
  const value: AgentPreferencePatch = {};
  for (const key of ["hidden", "pinned", "notify"] as const) {
    const raw = object[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") {
      return { ok: false, code: "laf:preference_invalid" };
    }
    value[key] = raw;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, code: "laf:preference_invalid" };
  }
  return { ok: true, value };
}

function agentDto(actor: AgentActor, agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.roleDescription,
    avatarSeed: agent.avatarSeed,
    effort: agent.effort,
    autoReview: agent.autoReview,
    hidden: agent.hidden,
    // ISO, not a boolean: the roster sorts pinned Bots among themselves by when they were pinned.
    pinnedAt: agent.pinnedAt?.toISOString() ?? null,
    notify: agent.notify,
    systemOwned: agent.systemOwned,
    // Published so the edit form can show it. Safe to expose: it is an address the person supplied,
    // and any credential for it lives in the vault, never in this row.
    endpoint: agent.endpoint,
    hasAuth: agent.hasAuth,
    canManage: canManageAgent(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
  };
}

/**
 * A code and no sentence, whichever class refused — each class now carries its own code and
 * status (`profile-store.ts`). Anything else is rethrown to the boundary in `app.ts`, which
 * answers `laf:internal` and logs the route without the parameters.
 */
function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof RosterFullError) {
    // The seat count travels beside the code so the surface can say how full; the words are its.
    return context.json(
      { error: error.code, code: error.code, seats: error.seats },
      error.status,
    );
  }
  if (
    error instanceof AgentNotFoundError ||
    error instanceof AgentNotManageableError ||
    error instanceof ProtectedAgentError
  ) {
    return context.json({ error: error.code, code: error.code }, error.status);
  }
  throw error;
}
