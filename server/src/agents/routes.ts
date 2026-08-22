import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { testAgentConnection } from "./connection-test";
import { type CoworkerCall, CoworkerCallError } from "./coworker-call";
import { checkAgentEndpoint } from "./endpoint";
import { canManageAgent } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ProtectedAgentError,
  RosterFullError,
} from "./profile-store";
import type {
  AgentActor,
  AgentPreferencePatch,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; error: string };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  visibility?: unknown;
  endpoint?: unknown;
  avatarSeed?: unknown;
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
    return { ok: false, error: "Agent input must be a JSON object." };
  }

  const name = boundedText(
    input.name,
    80,
    "Name must be text between 1 and 80 characters.",
  );
  if (typeof name !== "string") return name;

  /*
   * OPTIONAL, BOTH OF THEM. A bot starts with nothing set and can become anything; forcing a job
   * description out of somebody before they have met the bot is the shape we just removed from the
   * deployment package. A bot with no description opens by asking what it is for
   * (`standingRoleMessage`), which is the honest version of an empty field.
   */
  const title = optionalBoundedText(
    input.title,
    120,
    "Title must be text of at most 120 characters.",
  );
  if (typeof title !== "string") return title;

  const roleDescription = optionalBoundedText(
    input.roleDescription,
    1000,
    "Role description must be text of at most 1000 characters.",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  if (typeof input.visibility !== "string") {
    return { ok: false, error: "Visibility must be public or private." };
  }
  const visibility = input.visibility.trim();
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, error: "Visibility must be public or private." };
  }

  // The endpoint is optional and checked. Absent means the Bot in the box, which is what most people
  // want on their first go. Present means this server will POST to an address a person chose, so it
  // goes through the same target check as navigation before it is allowed anywhere near the database.
  let endpoint: string | undefined;
  if (input.endpoint !== undefined && input.endpoint !== "") {
    const verdict = checkAgentEndpoint(input.endpoint, { allowPrivateHosts });
    if (!verdict.allowed) return { ok: false, error: verdict.reason };
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
      return { ok: false, error: "That is not a valid avatar." };
    }
    avatarSeed = supplied;
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
        return { ok: false, error: "That is not a valid header name." };
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
      visibility,
      endpoint,
      auth,
      ...(avatarSeed === undefined ? {} : { avatarSeed }),
    },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts = false,
  /** Where a Bot's own refusal is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
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
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The Bot declined something, and says so.
   *
   * The audit trail records what a Bot did, decided by the gateway on the way to an action. A model
   * that refuses before calling any tool takes no action, so this records the attempted request.
   *
   * Self-reported, and said so in the row. The Bot calls this because its tool description tells it
   * to, so a model that declines without a tool call still writes nothing. This is evidence, not enforcement:
   * nothing is prevented by it, and a reader must not mistake an empty list for an untroubled Bot.
   */
  routes.post("/:agentId/declined", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await context.req.json().catch(() => null)) as {
      reason?: unknown;
      request?: unknown;
    } | null;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return context.json({ error: "A reason is required." }, 400);
    }

    if (auditStore) {
      const actor = context.var.actor;
      await recordAuditEvent(auditStore, {
        eventType: "bot.declined",
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId,
          actor: actor?.email ?? "unknown",
          reason: reason.slice(0, 500),
          // What it was asked, in the Bot's own words and only if it offered them. Truncated for the
          // same reason every other payload here is: a trail is not a transcript.
          ...(typeof body?.request === "string" && body.request.trim()
            ? { request: body.request.trim().slice(0, 500) }
            : {}),
          reportedBy: "the Bot itself",
        },
      });
    }

    return context.json({ recorded: true });
  });

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
        return context.json({ error: "Agent not found." }, 404);
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
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const agent = await store.create(context.var.actor, parsed.value);
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
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

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
        { error: "This deployment cannot run coworkers server-side." },
        501,
      );
    }
    const body = (await context.req.json().catch(() => null)) as {
      message?: unknown;
      from?: unknown;
    } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const from = typeof body?.from === "string" ? body.from : "";
    if (!from) {
      return context.json({ error: "Say which Bot is asking." }, 400);
    }
    try {
      const answer = await coworkerCall.ask(
        context.var.actor,
        from,
        context.req.param("agentId"),
        message,
      );
      return context.json({ answer });
    } catch (error) {
      if (error instanceof CoworkerCallError) {
        return context.json({ error: error.message }, error.status);
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
    if (!patch || typeof patch !== "object") {
      return context.json(
        { error: "Profile input must be a JSON object." },
        400,
      );
    }

    try {
      const current = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!current) return context.json({ error: "Agent not found." }, 404);

      // Merged before validation, so the same rules that guard the edit form guard this too.
      const merged = parseAgentInput(
        {
          name: patch.name ?? current.name,
          title: patch.title ?? current.title,
          roleDescription: patch.roleDescription ?? current.roleDescription,
          visibility: current.visibility,
          ...(patch.avatarSeed === undefined
            ? {}
            : { avatarSeed: patch.avatarSeed }),
        },
        allowPrivateHosts,
      );
      if (!merged.ok) return context.json({ error: merged.error }, 400);

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
    if (!patch.ok) return context.json({ error: patch.error }, 400);

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
  error: string,
): string | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, error };
}

/** The same, for a field a person may leave blank. Absent and empty both mean empty. */
function optionalBoundedText(
  value: unknown,
  maximumLength: number,
  error: string,
): string | { ok: false; error: string } {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length <= maximumLength ? trimmed : { ok: false, error };
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
): { ok: true; value: AgentPreferencePatch } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "A preference patch is required." };
  }
  const object = body as Record<string, unknown>;
  const value: AgentPreferencePatch = {};
  for (const key of ["hidden", "pinned", "notify"] as const) {
    const raw = object[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") {
      return { ok: false, error: `\`${key}\` must be true or false.` };
    }
    value[key] = raw;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "No known preference was named." };
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
    visibility: agent.visibility,
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

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json(
      { error: "You do not have permission to manage this agent." },
      403,
    );
  }
  if (error instanceof ProtectedAgentError) {
    return context.json({ error: "System-owned agents are protected." }, 403);
  }
  if (error instanceof RosterFullError) {
    // 409 rather than 400: the request was well-formed, the account is simply full.
    return context.json({ error: error.message }, 409);
  }
  throw error;
}
