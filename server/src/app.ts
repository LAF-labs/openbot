import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { CoworkerCall } from "./agents/coworker-call";
import type { AgentMemoryStore } from "./agents/memory-store";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import { type AuditReader, type AuditStore, auditQueryFromUrl } from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import type { OnboardingStore } from "./auth/onboarding";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import { createApprovalRoutes } from "./computer/approval-routes";
import type { ApprovalRegistry } from "./computer/approvals";
import type { ComputerClient } from "./computer/client";
import type { DemonstrationRecorder } from "./computer/demonstration";
import type { ComputerGateway } from "./computer/gateway";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import type { StandingApprovalStore } from "./computer/standing-approvals";
import type { WriteUp } from "./computer/write-up";
import type { DeploymentConfig } from "./config";
import type { CredentialAdminService, CredentialInput } from "./credentials";
import { type ConnectConfig, createPluginRoutes } from "./plugins/routes";
import type { PluginStore } from "./plugins/store";
import { createRoutineRoutes } from "./routines/routes";
import type { RoutineService } from "./routines/service";
import type { PackageStatusReader } from "./tenant-package";

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  /** Whether this person has made their first Bot yet. Absent means nobody is ever asked to. */
  onboarding?: OnboardingStore,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** Absent when no computer is configured, and the routes are then not mounted at all. */
  computerClient?: ComputerClient,
  /** The only path to an acting call: policy decision, then audit row, then the action. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Where the questions an `ask` rule raised wait for a person.
   *
   * Deliberately not tied to the computer being configured. The same policy judges a Bot's calls to
   * somebody else's servers, so a deployment with plugins and no browser can still stop and ask, and
   * a question nobody can be shown is worse than a rule that never fired: the Bot waits out the full
   * ten minutes and then reports that nobody answered.
   */
  approvals?: ApprovalRegistry,
  /** One Bot asking another. Absent means the ask route answers 501 and everything else stands. */
  coworkerCall?: CoworkerCall,
  /** Instructions on a clock. Absent leaves the routine surface unmounted. */
  routineService?: RoutineService,
  /**
   * When each message in a thread was first seen and which Bot said it: the date separators, and
   * the name above a reply in a room where more than one Bot can answer.
   *
   * A reader rather than the database, because this module takes services and never a connection.
   * Absent serves empty maps, and the transcript then draws no separators and no names — which is
   * the right degraded behaviour: a conversation with neither is still a readable conversation.
   */
  messageTimeReader?: (threadId: string) => Promise<{
    times: Record<string, string>;
    speakers: Record<string, string>;
  }>,
  /** Which of a person's Bots are mid-run, for the roster. Absent answers "none". */
  readWorking?: (userId: string) => Promise<
    Array<{
      agentId: string;
      origin: string;
      label: string | null;
      startedAt: string;
    }>
  >,
  /**
   * Runs a room's turn on the server. Absent leaves the room routes unmounted, which is what a
   * deployment without a model runtime should look like: rooms simply cannot answer.
   */
  roomService?: {
    post: (input: {
      actor: { id: string; role: "admin" | "user" };
      actorLabel: string;
      channelId: string;
      threadId: string;
      text: string;
      messageId?: string;
      addressedAgentIds?: string[];
      personName: string;
    }) => Promise<{ turnId: string; messageId: string; epoch: number }>;
    stop: (actor: { id: string }, channelId: string) => Promise<void>;
  },
  /** A room's transcript, straight out of the snapshot column. */
  readThreadMessages?: (threadId: string) => Promise<unknown[]>,
  /**
   * The questions a person has decided not to be asked again.
   *
   * LAST, and new parameters belong here too. Everything above is positional, so a parameter
   * inserted anywhere else shifts every argument after it — which has already broken composition
   * tests that reach a late slot through a run of `undefined`, silently, because the types line up.
   *
   * Absent leaves the answering handler ignoring `always` and the two `/standing` handlers reporting
   * nothing, which is the honest degraded behaviour: a deployment with nowhere to record a widening
   * should keep asking rather than accept one it cannot show anybody.
   */
  standingApprovals?: StandingApprovalStore,
  /**
   * Whether this deployment's model takes an effort setting, for the surface to draw or not draw.
   *
   * The same fact `RuntimeModel.supportsEffort` decides with, read from the same package, so the
   * control appears exactly where the parameter is actually sent. Absent reads as yes, matching the
   * package's own default.
   */
  deploymentEffort?: boolean,
  /**
   * Where a demonstration is recorded while somebody teaches a Bot. Last, like everything new here.
   *
   * Absent leaves taking the wheel exactly as it was — see the `teaching` note on `control/take`.
   */
  demonstrations?: DemonstrationRecorder,
  /** Turns a finished recording into a procedure. Absent leaves it readable and nothing more. */
  writeUp?: WriteUp,
  /**
   * What each Bot has learned about each person. Last, like everything new here.
   *
   * Absent leaves the three memory endpoints unmounted, so a deployment without the store answers
   * 404 rather than drawing a list that is empty for a reason nobody can see.
   */
  agentMemoryStore?: AgentMemoryStore,
  /**
   * What the OAuth connect flow needs: the deployment's public URL, and whether the person a
   * consent was started for still has access when the callback lands. Last, like everything new
   * here.
   *
   * Absent leaves the connect and callback routes answering that the deployment cannot complete a
   * consent flow, which is the honest degraded behaviour for a deployment with no public URL.
   */
  pluginConnect?: ConnectConfig,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (context) => context.json({ status: "ok" }));
  /*
   * What this deployment can do, for anybody who asks — and it is anybody: this endpoint has no
   * session guard, so every field added here is published. It once reported a runtime `mode` and an
   * always-true `durableHistory`, both left from a hosted-runtime choice that no longer exists, and
   * a projection of nothing is still a projection: add fields explicitly, never the config object.
   *
   * Kept rather than removed because the deployment's own smoke test uses it to decide whether
   * anything is answering at all before it starts asking real questions of it.
   */
  app.get("/api/capabilities", (context) => context.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    if (!auth) {
      return context.json({ error: "Authentication is not configured." }, 503);
    }

    return auth.handler(context.req.raw);
  });

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "Authentication is not configured." }, 503);
  // Local development can stand in a fixed administrator so the product is reachable before the
  // authentication slice is built. It is checked first so a machine with the flag set does not also
  // need Google credentials configured just to boot.
  const requireUser = config.devNoAuth
    ? createDevRequireUser()
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository)
      : authenticationUnavailable;

  app.get("/api/me", requireUser, async (context) => {
    const actor = context.var.actor;
    /*
     * `onboarded: true` when nothing tracks it, so a deployment without the store never traps
     * anybody in a flow it cannot record the end of.
     */
    const onboarded = onboarding
      ? await onboarding.isOnboarded(actor.id).catch(() => true)
      : true;
    /*
     * What this deployment can do, beside who is asking.
     *
     * Here rather than on its own endpoint because it is one boolean and this is the call the app
     * already makes before it draws anything. Today it says whether the model takes an effort
     * setting: a deployment whose model does not reason must not offer a control that silently does
     * nothing, and the surface cannot work that out for itself — the model is never sent to it, and
     * it should not have to know model names to draw a form.
     */
    return context.json({
      user: { ...actor, onboarded },
      deployment: { effort: deploymentEffort !== false },
    });
  });

  /**
   * They finished onboarding. Written by the flow itself once the first Bot exists.
   *
   * Its own call rather than a side effect of creating an agent: a Bot made later from the Agents
   * page is the same creation and must not silently mean "and they have been onboarded", which is
   * the kind of coupling that makes the flow impossible to change afterwards.
   */
  app.post("/api/me/onboarded", requireUser, async (context) => {
    if (onboarding) await onboarding.markOnboarded(context.var.actor.id);
    return context.body(null, 204);
  });
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    return context.json(
      await auditReader.list(auditQueryFromUrl(new URL(context.req.url))),
    );
  });
  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      return context.json({
        credential: await credentialService.rotate({
          ...input,
          previousCredentialId: context.req.param("credentialId"),
        }),
      });
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      return context.json({
        credential: await credentialService.revoke(
          context.req.param("credentialId"),
          context.var.actor.id,
        ),
      });
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow a LAF Agent route declared above.
  if (copilotHandler) {
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The client
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so all
  // three arrive together or the routes are not mounted: a computer whose actions were ungoverned is
  // not a reduced feature, it is the one shape of this feature that must not exist.
  if (computerClient && computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerClient,
        computerGateway,
        computerPolicy,
        requireUser,
        demonstrations,
        writeUp,
      ),
    );
  }

  // Answering is its own surface because asking is not only the computer's. See approval-routes.ts.
  if (approvals && auditStore) {
    app.route(
      "/api/approvals",
      createApprovalRoutes(
        approvals,
        auditStore,
        requireUser,
        standingApprovals,
      ),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        coworkerCall,
        // What the roster shows as busy, read from the one ledger every run path writes.
        readWorking,
        // What each Bot has learned, and the three endpoints that let a person read and undo it.
        agentMemoryStore,
      ),
    );
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(
        channelStore,
        requireUser,
        channelEvents,
        messageTimeReader,
        roomService,
        readThreadMessages,
      ),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(pluginStore, requireUser, pluginConnect),
    );
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route("/api/threads", createThreadRoutes(threadIdentity, requireUser));

    if (routineService) {
      app.route(
        "/api/routines",
        createRoutineRoutes(routineService, requireUser),
      );
    }
  }

  return app;
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * `mcp_oauth_client` and `mcp_user_token` are deliberately NOT accepted here. Both are minted by
   * the code that owns their acts — the client by registration, the token by a person's consent —
   * and a hand-typed one would be a secret whose provenance nothing can vouch for, attached to a
   * flow that treats provenance as the security property.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    typeof body.keyId !== "string" ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider,
    keyId: body.keyId,
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
