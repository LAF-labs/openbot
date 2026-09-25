import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { AppVariables } from "../auth/guards";
import {
  mayDriveBot,
  requireAdminRoute,
  requireBotAccess,
} from "../auth/guards";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { BOT_ID_INVALID, BotIdRefusedError, isBotId } from "./bot-id";
import {
  COMPUTER_FAILED,
  type ComputerClient,
  ComputerUnavailableError,
  ControlHeldError,
  ElementNotFoundError,
  FILE_PATH_REFUSED,
  HUMAN_HAS_CONTROL,
  NAVIGATION_FAILED,
  NAVIGATION_REFUSED,
  NavigationRefusedError,
  PAGE_TIMEOUT,
  PageLoadFailedError,
  PageLoadTimeoutError,
  REQUEST_INVALID,
  STALE_REFS,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./client";
import type { DemonstrationRecorder } from "./demonstration";
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
  THREAD_HEADER,
  TOOL_CALL_HEADER,
} from "./gateway";
import { type PolicyStore, parseActionPolicy } from "./policy-store";
import { readFileInputOf } from "./schema";
import type { ScreenViewAudit } from "./screen-view";
import { snapshotForModel } from "./snapshot-lines";
import type { WriteUp } from "./write-up";

/**
 * The Bot computer's surface, behind the same session guard as every other API route.
 *
 * The computer has token authentication but no user/session identity. These server routes require a
 * session guard because `COMPUTER_TOKEN` proves the caller is an internal service, not which user is
 * asking to drive the browser.
 *
 * Read-only calls go to the client; acting calls go to the gateway. That split is the governance
 * boundary: every acting route in this file passes through a policy decision and audit row before it
 * reaches the computer.
 */
export function createComputerRoutes(
  client: ComputerClient,
  gateway: ComputerGateway,
  policyStore: PolicyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Where a demonstration is recorded, when somebody is teaching rather than fixing.
   *
   * Optional: without one, taking the wheel is what it always was and the two handlers below say
   * there is nothing to show. A deployment with no computer has no wheel to take either.
   */
  demonstrations?: DemonstrationRecorder,
  /**
   * Turns a finished recording into a procedure. Absent leaves the recording readable and nothing
   * more, which is what a deployment without a model can honestly offer.
   */
  writeUp?: WriteUp,
  /**
   * Where a change to the boundary itself is recorded.
   *
   * Last, and optional, like everything else here: without it the policy still saves and the trail
   * simply does not say who widened it or why. Every acting route already writes through the
   * gateway's own store — this one is for the edit to the rules, which no gateway call goes through.
   */
  auditStore?: AuditStore,
  /**
   * Where reading a recording back is written down. A recording is the pages a person's own
   * browser went to and the controls they pressed; reading it is looking at that screen after the
   * fact, and the trail records it the way it records the live one. See `screen-view.ts`.
   */
  screenViews?: ScreenViewAudit,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * THE BOT'S ID, BEFORE ANY HANDLER GETS IT.
   *
   * One middleware rather than a check per route, because the property has to survive the next route
   * somebody adds: every handler below takes `:botId` straight from the address and hands it to the
   * gateway, which puts it in a header that the computer turns into a directory name. Hono decodes
   * `%2F` before a handler sees the parameter, so `..%2F..%2Ftmp%2Fx` arrived as `../../tmp/x` and
   * escaped `/profiles` — a file written as root, anywhere in the container, by anyone with a
   * session. See bot-id.ts.
   *
   * Registered before every route so it runs first, and refusing rather than sanitising: an id that
   * has to be rewritten to be safe is not this deployment's id, and quietly repairing it is how a
   * call ends up on a browser belonging to nobody.
   *
   * WHOSE BOT IT IS is the other question, and it is asked in every route's own declaration below
   * (`requireBotAccess`, after `requireUser`) rather than here, because it needs the actor the
   * session guard resolves and this runs ahead of it. Measured 2026-09-10 (audit A8): with only the
   * shape checked, a signed-in colleague named the owner's Bot and got its screenshot, read its
   * page, took the wheel and read its workspace — every door the approval card guards, opened
   * without one. `computer-routes.test.ts` sweeps every route here on a Bot that is not the
   * caller's, so one added without the guard turns that sweep red.
   */
  routes.use("/:botId/*", async (context, next) => {
    const botId = context.req.param("botId");
    if (botId !== undefined && !isBotId(botId)) {
      return context.json({ error: BOT_ID_INVALID, code: BOT_ID_INVALID }, 400);
    }
    await next();
  });

  routes.get(
    "/:botId/status",
    requireUser,
    requireBotAccess(),
    async (context) =>
      context.json(await client.status(context.req.param("botId"))),
  );

  /*
   * THE TWO ROUTES A PANE READS, AND SO THE TWO WHOSE FAILURE A PERSON SEES.
   *
   * Measured 2026-09-06: the screen card printed `error` out of this body under a Korean heading —
   * "The assistant's computer did not respond in time.", and once a Playwright call log. The
   * server sends facts; `code` is the fact, and the surface owns the words for it. `error` beside
   * it is the same code, for the readers that take `error`: no route here answers a sentence.
   */
  routes.get(
    "/:botId/screenshot",
    requireUser,
    requireBotAccess(),
    async (context) => {
      try {
        // `?format=jpeg&width=…&quality=…`: the panel's thumbnail, a small JPEG rather than the PNG.
        const width = Number(context.req.query("width"));
        const quality = Number(context.req.query("quality"));
        const thumbnail =
          context.req.query("format") === "jpeg"
            ? {
                width: Number.isFinite(width) && width > 0 ? width : 480,
                quality: Number.isFinite(quality) && quality > 0 ? quality : 60,
              }
            : undefined;
        return context.json(
          await client.forBot(context.req.param("botId")).screenshot(thumbnail),
        );
      } catch (error) {
        return failed(context, error);
      }
    },
  );

  routes.get(
    "/:botId/read",
    requireUser,
    requireBotAccess(),
    async (context) => {
      try {
        return context.json(
          await gateway.read(context.req.param("botId"), {
            whole: context.req.query("whole") === "1",
            ...(context.req.query("from")
              ? { from: context.req.query("from") }
              : {}),
          }),
        );
      } catch (error) {
        return failed(context, error);
      }
    },
  );

  routes.post(
    "/:botId/navigate",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as {
        url?: unknown;
        approvalId?: unknown;
      } | null;
      if (typeof body?.url !== "string" || !body.url.trim()) {
        return context.json(ARGUMENTS_INVALID_BODY, 400);
      }

      try {
        return context.json(
          await gateway.navigate(
            // No `?? "default"`. It was the server's half of a pair of silent fallbacks — the computer
            // had `"shared"` at the other end — and between them an unnamed call landed on a browser
            // belonging to nobody and answered as though it had worked. This route declares `:botId`,
            // so the value is there; `act()` below refuses when it somehow is not.
            botIdOf(context),
            botIdOf(context),
            {
              id: context.var.actor.id,
              ...(context.var.actor.email === DEV_ACTOR.email
                ? {}
                : { userId: context.var.actor.id }),
            },
            body.url.trim(),
            asApprovalId(body),
            // The person's Stop, as the acting routes below pass it. Navigation was the one
            // acting call that went on waiting for a page after the person had stopped it.
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        if (error instanceof ActionNeedsApprovalError) {
          return awaitingApproval(context, error);
        }
        if (error instanceof ActionRefusedError) {
          return refused(context, error);
        }
        // A refusal by the floor is answered 403 too — see `statusFor` — and a page that did not
        // load is not a refusal, whatever else it is.
        return failed(context, error);
      }
    },
  );

  routes.post(
    "/:botId/snapshot",
    requireUser,
    requireBotAccess(),
    async (context) => {
      try {
        // Lines for the model, not objects (`snapshot-lines.ts`); the gateway kept the objects.
        return context.json(
          snapshotForModel(
            await gateway.snapshot(botIdOf(context), {
              botId: botIdOf(context),
              // Who looked, for the row a look that could not see into a frame leaves. The same
              // actor the navigate route above builds, for the same reason it builds it that way.
              actor: {
                id: context.var.actor.id,
                ...(context.var.actor.email === DEV_ACTOR.email
                  ? {}
                  : { userId: context.var.actor.id }),
              },
            }),
          ),
        );
      } catch (error) {
        return failed(context, error);
      }
    },
  );

  /**
   * The acting routes.
   *
   * Each one hands the gateway the computer id, the Bot, the actor and the input, and does no checking
   * of its own beyond the shape of the request. Where a decision gets made is a single place.
   *
   * Each also passes through whatever `approvalId` the body carried. The route does not look at it
   * or judge it: an approval means something only against the action the gateway is about to take,
   * and a route that decided anything about it would be a second place deciding.
   */
  routes.post("/:botId/click", requireUser, requireBotAccess(), (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return ARGUMENTS_INVALID_BODY;
      return gateway.click(
        botId,
        botId,
        actor,
        ref,
        signal,
        asApprovalId(body),
      );
    }),
  );

  routes.post("/:botId/type", requireUser, requireBotAccess(), (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return ARGUMENTS_INVALID_BODY;
      if (typeof body?.text !== "string") return ARGUMENTS_INVALID_BODY;
      return gateway.type(
        botId,
        botId,
        actor,
        {
          ...ref,
          text: body.text,
          submit: body?.submit === true,
        },
        signal,
        asApprovalId(body),
      );
    }),
  );

  routes.post("/:botId/key", requireUser, requireBotAccess(), (context) =>
    act(context, (botId, actor, body, signal) => {
      if (typeof body?.key !== "string" || !body.key) {
        return ARGUMENTS_INVALID_BODY;
      }
      const ref = asRef(body);
      return gateway.key(
        botId,
        botId,
        actor,
        {
          key: body.key,
          ...(ref ?? {}),
        },
        signal,
        asApprovalId(body),
      );
    }),
  );

  routes.post("/:botId/scroll", requireUser, requireBotAccess(), (context) =>
    act(context, (botId, actor, body) =>
      gateway.scroll(
        botId,
        botId,
        actor,
        {
          ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
        },
        asApprovalId(body),
      ),
    ),
  );

  /**
   * Move the Bot to another one of its open tabs.
   *
   * An acting route although it changes nothing on any site: it goes through the gateway so the trail
   * says which page the Bot was on when it pressed the next thing.
   */
  routes.post(
    "/:botId/tabs/switch",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) => {
        if (typeof body?.index !== "number" || !Number.isInteger(body.index)) {
          return ARGUMENTS_INVALID_BODY;
        }
        return gateway.switchTab(
          botId,
          botId,
          actor,
          { index: body.index },
          asApprovalId(body),
        );
      }),
  );

  /** Hand one of the Bot's own files to a file input on the page. */
  routes.post("/:botId/upload", requireUser, requireBotAccess(), (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return ARGUMENTS_INVALID_BODY;
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return ARGUMENTS_INVALID_BODY;
      }
      return gateway.uploadFile(
        botId,
        botId,
        actor,
        { ...ref, path: body.path.trim() },
        signal,
        asApprovalId(body),
      );
    }),
  );

  /**
   * Who has the wheel. Polled by the surface next to the screen, so the person sees the Bot ask for
   * help without reloading anything.
   */
  routes.get(
    "/:botId/control",
    requireUser,
    requireBotAccess(),
    async (context) => {
      try {
        return context.json(await gateway.control(context.req.param("botId")));
      } catch (error) {
        return failed(context, error);
      }
    },
  );

  routes.post(
    "/:botId/control/request",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) =>
        gateway.requestHelp(
          botId,
          botId,
          actor,
          typeof body?.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "The assistant needs a person to continue.",
        ),
      ),
  );

  /**
   * The computers, for the admin surface: `GET /api/computers`.
   *
   * AN ADDRESS THAT NAMES NO BOT, because the answer is not a Bot's. It was `/:botId/computers`, and
   * the Computers page filled the parameter with `"shared"` — an id no `agents` row has — which the
   * ownership guard answered 404 once `397213f` took its administrator exception away. The page
   * showed a load error whose retry could never work, and no rows, so its Reset button was never
   * drawn (audit R3-04, R5-02, 2026-09-16). The id was said to be there because the gateway wanted
   * somebody to attribute the call to; `computers()` never took one. A read, so no row is written,
   * and the container answers `/computers` without a Bot header.
   *
   * AN ADMINISTRATOR'S, in the declaration: it answers with every Bot's browser on the deployment,
   * not the asker's. The page is the only reader.
   *
   * `mayDrive` ON EVERY ROW, because stop and reset are pressed from a row and go through that row's
   * Bot and its ownership guard. The container lists Bots the asker cannot drive — somebody else's,
   * and every Bot deleted since (audit R3-09) — and measured in the page on 2026-09-16, such a row
   * drew both buttons and Reset on it was refused 404. The server says which rows can be acted on;
   * the page draws no control that could only be refused.
   */
  routes.get("/", requireUser, requireAdminRoute, async (context) => {
    try {
      const listed = await gateway.computers();
      return context.json({
        ...listed,
        computers: await Promise.all(
          listed.computers.map(async (computer) => ({
            ...computer,
            mayDrive: await mayDriveBot(context, computer.botId),
          })),
        ),
      });
    } catch (error) {
      return failed(context, error);
    }
  });

  /** Stop the browser, keep the logins. */
  routes.post(
    "/:botId/computers/stop",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor) => gateway.stopComputer(botId, botId, actor)),
  );

  /**
   * Delete the profile. Every login goes with it, which is the point and also the danger.
   *
   * ADMINISTRATORS ONLY, unlike stopping. Stopping a browser costs somebody the page they were on;
   * this destroys every login on the one computer all of this account's Bots share, with no undo,
   * and it sat behind the same guard as reading a screenshot. Nothing about it is a Bot's own
   * business, so it is not a Bot's own decision either.
   *
   * STILL ADDRESSED THROUGH A BOT, unlike the list above, and a real one: the Computers page presses
   * it from a row, with that row's Bot. The container refuses every call but `/health` and
   * `/computers` that does not say which Bot is asking, and drops that Bot's own state with the
   * profile, so there is no honest Bot-less form of this call. The trail names the person who
   * pressed it (`actor`) beside the Bot on the row — never an id invented to fill the parameter.
   */
  routes.post(
    "/:botId/computers/reset",
    requireUser,
    requireBotAccess(),
    requireAdminRoute,
    (context) =>
      act(context, (botId, actor) =>
        gateway.resetComputer(botId, botId, actor),
      ),
  );

  /**
   * Taking the wheel, and saying which of the two reasons it is.
   *
   * `teaching` is a separate door on purpose. Taking control to unstick a Bot and taking it to show
   * the Bot how something is done look identical from here and are not the same act: the first is
   * somebody's private business in their own browser, and `audit.ts` deliberately records it as a
   * period rather than as keystrokes precisely so it stays that way. Recording every handover would
   * quietly turn that decision over.
   *
   * So a demonstration is entered by pressing the button that says so, and by nothing else.
   */
  routes.post(
    "/:botId/control/take",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, async (botId, actor, body) => {
        const state = await gateway.takeControl(botId, botId, actor);
        if (body?.teaching === true) demonstrations?.start(botId, actor.id);
        return state;
      }),
  );

  routes.post(
    "/:botId/control/release",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, async (botId, actor) => {
        // Handing back ends the demonstration, always. A recording with its own stop button is a
        // second state to get wrong, and somebody who has finished showing has finished showing.
        demonstrations?.finish(botId);
        return await gateway.releaseControl(botId, botId, actor);
      }),
  );

  /**
   * What was recorded, for the person who recorded it to read.
   *
   * FOR THE PERSON WHO RECORDED IT, and that used to be a sentence in this comment rather than
   * something the code did: the recorder was asked for a Bot's recording and answered anybody. A
   * demonstration is somebody's own browser for the length of an afternoon — the bank page, the
   * payroll page, every control they pressed by name — so the asker goes in and a stranger is told
   * there is nothing, which for them is true.
   *
   * A read, but not an unrecorded one. What is in here never leaves this process and never
   * becomes a Bot's instruction until somebody says so — see the note at the top of
   * `demonstration.ts` about what it does and does not keep — but a FINISHED recording read back
   * is a person looking at a screen after the fact, and `computer.screen_viewed` says so, once per
   * recording (`screen-view.ts` holds the once). Not while it is still being made: the panel polls
   * this once a second then, and the person reading it is the person driving.
   */
  routes.get(
    "/:botId/demonstration",
    requireUser,
    requireBotAccess(),
    (context) => {
      const botId = context.req.param("botId") ?? "";
      const actor = context.var.actor;
      const recording = demonstrations?.read(botId, actor.id) ?? null;
      if (recording?.finished) {
        void screenViews?.replayed(
          botId,
          { id: actor.id, role: actor.role },
          recording,
        );
      }
      return context.json({ demonstration: recording });
    },
  );

  /**
   * Write the recording up as a procedure, for the person to read and edit.
   *
   * A POST because it costs a model call, not because it changes anything: nothing is stored and no
   * Bot is touched. What the person does with the draft — edit it, name it, save it as a skill — is
   * theirs, and it goes through the skills surface like any other skill somebody wrote.
   *
   * Not audited. Nothing happened to a Bot, and the recording it read never leaves this process.
   */
  routes.post(
    "/:botId/demonstration/write-up",
    requireUser,
    requireBotAccess(),
    async (context) => {
      // Theirs, like the read above: a recording nobody may look at is not one anybody may spend a
      // model call turning into a procedure either.
      const recording = demonstrations?.read(
        context.req.param("botId") ?? "",
        context.var.actor.id,
      );
      if (!recording || recording.steps.length === 0) {
        return context.json(
          { error: "laf:recording_empty", code: "laf:recording_empty" },
          409,
        );
      }
      if (!writeUp) {
        return context.json(
          {
            error: "laf:write_up_unavailable",
            code: "laf:write_up_unavailable",
          },
          501,
        );
      }
      const written = await writeUp(recording);
      if (written.ok) return context.json({ draft: written.draft });
      /*
       * The recording survives every one of these, so the offer is always to try again — but not
       * always straight away. A provider that refused in under a second is not going to do better
       * on the next press, and telling somebody to press it again is how a working feature comes to
       * look broken. 503 for that, 502 for a reply that arrived and could not be used.
       */
      return written.because === "busy"
        ? context.json(
            {
              error: "laf:write_up_busy",
              code: "laf:write_up_busy",
              retryLater: true,
            },
            503,
          )
        : context.json(
            {
              error: "laf:write_up_unreadable",
              code: "laf:write_up_unreadable",
            },
            502,
          );
    },
  );

  /**
   * Thrown away. What somebody decides not to keep should stop existing.
   *
   * Their own, and 204 either way. The answer says what is true for the caller — there is nothing
   * of theirs recorded on this Bot any more — and a 404 for somebody else's would answer the
   * question the read above declines to.
   */
  routes.delete(
    "/:botId/demonstration",
    requireUser,
    requireBotAccess(),
    (context) => {
      demonstrations?.discard(
        context.req.param("botId") ?? "",
        context.var.actor.id,
      );
      return context.body(null, 204);
    },
  );

  /** The Bot asking for a value it must not be told. */
  routes.post(
    "/:botId/control/secret",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) => {
        if (typeof body?.ref !== "string" || !body.ref) {
          return ARGUMENTS_INVALID_BODY;
        }
        if (typeof body?.snapshotId !== "number") {
          return ARGUMENTS_INVALID_BODY;
        }
        return gateway.requestSecret(botId, botId, actor, {
          label:
            typeof body?.label === "string" && body.label.trim()
              ? body.label.trim()
              : "the value this page is asking for",
          ref: body.ref,
          snapshotId: body.snapshotId,
        });
      }),
  );

  /**
   * A person supplying it.
   *
   * The value is read from the body, passed straight through, and referred to nowhere else. Its own
   * route rather than a `kind` on the input route below, so that grepping for where a secret can enter
   * this server returns exactly one place.
   */
  routes.post(
    "/:botId/human/secret",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) => {
        if (typeof body?.text !== "string" || !body.text) {
          return {
            error: "laf:secret_value_required",
            code: "laf:secret_value_required",
          };
        }
        return gateway.supplySecret(botId, botId, actor, body.text);
      }),
  );

  /**
   * A person's own mouse and keyboard.
   *
   * Not through the policy gateway, and not audited per keystroke, see the note on `humanInput` in
   * client.ts. The takeover is the audited event; what the person typed during it is deliberately
   * unrecorded, because the reason a takeover exists is to let them enter the thing nothing else
   * should keep.
   */
  routes.post(
    "/:botId/human/:kind",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const kind = context.req.param("kind");
      if (
        kind !== "click" &&
        kind !== "type" &&
        kind !== "key" &&
        kind !== "scroll"
      ) {
        return context.json(
          { error: "laf:input_unknown", code: "laf:input_unknown" },
          400,
        );
      }
      const body = (await context.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      try {
        return context.json(
          await gateway.humanInput(context.req.param("botId"), {
            // The body first and the validated `kind` LAST. Spread the other way round, a body
            // carrying `kind: "secret"` overwrote the one this route checked, and the person's own
            // input became a secret being supplied — down a path this route does not audit and whose
            // whole design is that there is exactly one door into it.
            ...(body ?? {}),
            kind,
          } as Parameters<typeof gateway.humanInput>[1]),
        );
      } catch (error) {
        return failed(context, error);
      }
    },
  );

  /** The Bot's files. Through the gateway, like every other acting call. */
  routes.post(
    "/:botId/files/list",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) =>
        gateway.listFiles(
          botId,
          botId,
          actor,
          {
            ...(typeof body?.path === "string" && body.path.trim()
              ? { path: body.path.trim() }
              : {}),
          },
          asApprovalId(body),
        ),
      ),
  );

  routes.post(
    "/:botId/files/read",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) => {
        const input = readFileInputOf(body);
        if (!input) return ARGUMENTS_INVALID_BODY;
        return gateway.readFile(botId, botId, actor, input, asApprovalId(body));
      }),
  );

  routes.post(
    "/:botId/files/write",
    requireUser,
    requireBotAccess(),
    (context) =>
      act(context, (botId, actor, body) => {
        if (typeof body?.path !== "string" || !body.path.trim()) {
          return ARGUMENTS_INVALID_BODY;
        }
        if (typeof body?.contents !== "string") return ARGUMENTS_INVALID_BODY;
        return gateway.writeFile(
          botId,
          botId,
          actor,
          {
            path: body.path.trim(),
            contents: body.contents,
            append: body.append === true,
          },
          asApprovalId(body),
        );
      }),
  );

  /**
   * The policy, readable and writable by an administrator.
   *
   * Here rather than in the admin routes file, because this directory owns the computer and `app.ts`
   * takes one appended line per mount. The storage underneath is durable, so administrator rules
   * remain active after a restart.
   */
  routes.get("/policy", requireUser, requireAdminRoute, (context) =>
    context.json({ policy: policyStore.get() }),
  );

  routes.put("/policy", requireUser, requireAdminRoute, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const parsed = parseActionPolicy(body);
    if (!parsed.ok) {
      return context.json(
        {
          error: parsed.code,
          code: parsed.code,
          ...(parsed.list ? { list: parsed.list } : {}),
        },
        400,
      );
    }
    /*
     * WHY, WHERE THE CHANGE IS ONE THAT STANDS THE BOUNDARY DOWN.
     *
     * `settleWithoutAsking` decides whether a question may be answered by an allowance or by a
     * model instead of by a person, so switching it is a decision about the deployment rather than
     * about one action, and it has to be arguable with afterwards. The reason travels beside the
     * policy, is never enforced on, and is required by the surface rather than here: a route that
     * refused a boundary change over a missing sentence would be a route that leaves a deployment
     * unable to tighten its own rules.
     */
    const before = policyStore.get();
    const reason =
      typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    try {
      await policyStore.set(parsed.policy, context.var.actor.email);
    } catch {
      /*
       * Saved, or said so. A boundary that is enforced now and gone after the next restart is worse
       * than one that was never set, so a policy that could not be written is reported as a failure
       * rather than quietly held in memory. Nothing changes: the previous policy is still in force.
       */
      return context.json(
        { error: POLICY_NOT_SAVED, code: POLICY_NOT_SAVED },
        503,
      );
    }
    /*
     * Written after the save, so the trail records boundaries that are actually in force. Its
     * failure is swallowed for the opposite reason to everywhere else in this area: the rule IS
     * saved by now, and throwing here would tell an administrator their change failed while it was
     * being enforced — the one lie worse than a missing row.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "computer.policy_changed",
        targetType: "computer",
        payload: {
          actor: context.var.actor.email,
          ...(reason ? { reason } : {}),
          settleWithoutAsking: parsed.policy.settleWithoutAsking ?? "allowed",
          // Named only when it moved. A row for every rule edit that said the switch was on would
          // bury the handful of rows where somebody actually changed it.
          ...((before.settleWithoutAsking ?? "allowed") !==
          (parsed.policy.settleWithoutAsking ?? "allowed")
            ? {
                settleWithoutAskingWas: before.settleWithoutAsking ?? "allowed",
              }
            : {}),
          deny: parsed.policy.deny.length,
          ask: parsed.policy.ask.length,
          allow: parsed.policy.allow.length,
        },
      }).catch((error) => {
        log.error("computer_policy_row_lost", { reason: error });
      });
    }
    // Echoed back so a caller can see exactly what is now in force rather than assuming its request
    // was stored verbatim.
    return context.json({ policy: policyStore.get() });
  });

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;

/** A request that was rejected before any decision was needed, because it was not a valid action. */
type BadRequest = { error: `laf:${string}`; code: `laf:${string}` };

/**
 * An acting request missing what its tool requires: a ref and its snapshotId, the text, the key.
 *
 * ONE FACT FOR ALL OF THEM, and the one the unattended runner answers the same mistake with, so a
 * Bot is told the same thing whether a person's tab or a routine made the call. They were a sentence
 * per field — "A ref and the snapshotId it came from are both required. Take a snapshot first." —
 * in English, into a Korean-speaking model's tool result; the tool's own definition says what its
 * arguments are, and a second author of that is how the two come to disagree.
 */
const ARGUMENTS_INVALID = "laf:tool_arguments_invalid";
const ARGUMENTS_INVALID_BODY: BadRequest = {
  error: ARGUMENTS_INVALID,
  code: ARGUMENTS_INVALID,
};

/**
 * The boundary could not be written down, so it was not changed. Its own fact because it is the one
 * refusal here that says something is still true — the previous boundary is in force — and a person
 * reading "could not be saved" alone would not know whether anything had been loosened.
 */
const POLICY_NOT_SAVED = "laf:policy_not_saved";

/**
 * Shared plumbing for acting routes that use this helper: resolve who is asking, run, and map
 * failures onto statuses.
 *
 * One place, so a new acting route cannot accidentally report a policy refusal as a server error, and
 * so the actor is derived the same way every time.
 */
async function act(
  context: ComputerContext,
  handler: (
    botId: string,
    actor: ActionActor,
    body: Record<string, unknown> | null,
    /**
     * The person's Stop, as an abort.
     *
     * The surface aborts its request when Stop is pressed; Bun exposes that here, and every acting
     * route passes it on so the abort reaches the Playwright call mid-click. Without it, Stop ended
     * the run in the transcript while the click carried on landing on a live page, harmless most of
     * the time, and not harmless on a Confirm button, which is exactly when Stop gets pressed.
     */
    signal: AbortSignal,
  ) => Promise<unknown> | BadRequest,
) {
  // Always present on these routes, which all declare `:botId`. It used to fall back to `"default"`
  // here — the server's half of a pair of fallbacks that put an unnamed call on a browser belonging
  // to nobody. There is no computer worth naming when nobody said which, so this refuses instead.
  const botId = context.req.param("botId");
  if (!botId) {
    return context.json(
      { error: "laf:bot_header_missing", code: "laf:bot_header_missing" },
      400,
    );
  }
  const record = context.var.actor;
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await handler(
      botId,
      {
        id: record.id,
        // Only a real users row may go in the audit table's foreign key column. The local development
        // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
        // it was is recorded in the payload regardless. See `write` in gateway/trail.ts.
        ...(record.email === DEV_ACTOR.email ? {} : { userId: record.id }),
        // Which conversation this is happening in, so an answer can be "for this conversation".
        // Absent is fine: the question is then asked in the standing terms alone.
        ...(threadOf(context) ? { threadId: threadOf(context) } : {}),
        // And which of the Bot's calls, so a question it raises can be drawn and carried on from
        // any window of the conversation (`ApprovalStep`).
        ...(toolCallOf(context) ? { toolCallId: toolCallOf(context) } : {}),
      },
      body,
      context.req.raw.signal,
    );
    if (isBadRequest(result)) {
      return context.json(result, 400);
    }
    return context.json(result as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ActionNeedsApprovalError) {
      return awaitingApproval(context, error);
    }
    if (error instanceof ActionRefusedError) {
      return refused(context, error);
    }
    return failed(context, error);
  }
}

/**
 * A policy refusal is the product working. 403 with the rule that refused it, so the surface can
 * tell the person which boundary they met rather than reporting a malfunction.
 */
function refused(context: ComputerContext, error: ActionRefusedError) {
  return context.json(
    {
      // The code twice, deliberately: `error` is what every caller of these routes already reads,
      // and `code` is where a refusal's fact has been since the surface started owning the words.
      // Neither is a sentence any more. See ActionRefusedError.
      error: error.code,
      rule: error.rule,
      code: error.code,
    },
    403,
  );
}

/**
 * A failure, answered as its fact and the status that fact deserves.
 *
 * `error` and `code` are the same code. `error` used to be what the failure said, bounded to a line
 * by `describeFailure` — a Playwright call log, the container's English, the client's own — and the
 * surface, the model and a routine all read it as the reason. What it said is still worth something
 * when it is a failure nobody here named, the 500: that line goes to the operator's log, where
 * `describeFailure` has always kept a query's SQL and parameters out of it, and not to the wire.
 */
function failed(context: ComputerContext, error: unknown) {
  const code = codeFor(error);
  const status = statusFor(error);
  if (status === 500) {
    log.error("computer_route_failed", {
      route: context.req.routePath,
      reason: describeFailure(error),
    });
  }
  return context.json({ error: code, code }, status);
}

function isBadRequest(value: unknown): value is BadRequest {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    !("action" in value)
  );
}

/**
 * A boundary that wants a person, reported as 409 rather than 403.
 *
 * 403 already means one thing to everything downstream of here: a boundary refused you and that is
 * final. The surface renders it as Blocked and the model is told to stop and say so. This is the
 * opposite condition, nothing has been refused and somebody is being asked, so reusing 403 would
 * make every ask rule read to a Bot as a deny rule and produce exactly the outcome the ask list
 * exists to avoid: a turn thrown away on an action the deployment was willing to permit.
 *
 * 409 because the existing 409s on these routes already mean "not now, and here is what to do about
 * it", which a stale snapshot and a person holding the wheel both are. `awaitingApproval` is what
 * separates this from those, and the surface checks for it before it reads a 409 as anything else.
 */
function awaitingApproval(
  context: ComputerContext,
  error: ActionNeedsApprovalError,
) {
  return context.json(
    {
      // A code, not a sentence. The card is Korean and the model reads Korean; neither of them is
      // owed this server's English. See ActionRefusedError.
      error: error.code,
      code: error.code,
      awaitingApproval: true,
      approvalId: error.approvalId,
      // What is being asked about, in facts. `app/src/lib/approvals.ts` turns it into a sentence.
      subject: error.subject,
      rule: error.rule,
      // Undefined drops out of the JSON, so a question with no derivable scope simply arrives
      // without one and the card offers "this once" alone.
      scope: error.scope,
      // Present when "for this conversation" is on offer. The card draws its third button off this
      // and nothing else, so a question raised from outside a conversation offers two.
      threadId: error.threadId,
      // So the card can show how long is left. Without it the question simply disappeared after ten
      // minutes with nothing having said it would.
      expiresAt: error.expiresAt,
    },
    409,
  );
}

/** The conversation the surface says it is in, off the request. Undefined when it said nothing. */
function threadOf(context: ComputerContext): string | undefined {
  const named = context.req.header(THREAD_HEADER)?.trim();
  return named ? named : undefined;
}

/** The Bot's tool call the surface says this request carries out. Undefined when it said nothing. */
function toolCallOf(context: ComputerContext): string | undefined {
  const named = context.req.header(TOOL_CALL_HEADER)?.trim();
  return named ? named : undefined;
}

/** An answer being presented, if the caller carried one. Its meaning is decided at the gateway. */
function asApprovalId(
  body: Record<string, unknown> | null,
): string | undefined {
  return typeof body?.approvalId === "string" && body.approvalId
    ? body.approvalId
    : undefined;
}

/**
 * Which Bot this call is about.
 *
 * Every route here declares `:botId`, so the parameter is always there and this is a formality —
 * which is precisely why it must not be `?? "default"`. That fallback, and the computer's matching
 * `"shared"`, are how a call that named no Bot used to be answered by a browser belonging to nobody.
 * An empty string reaches the gateway as a Bot with no name, is refused there, and is visible.
 */
function botIdOf(context: ComputerContext): string {
  return context.req.param("botId") ?? "";
}

function asRef(
  body: Record<string, unknown> | null,
): { ref: string; snapshotId: number } | undefined {
  if (typeof body?.ref !== "string" || !body.ref) return undefined;
  if (typeof body?.snapshotId !== "number") return undefined;
  return { ref: body.ref, snapshotId: body.snapshotId };
}

/**
 * Which HTTP status a failure deserves.
 *
 * Three genuinely different conditions that read identically if they all become 500: the computer is
 * not running (an operator fixes it), the refs are stale (the model fixes it by snapshotting again),
 * and everything else. Navigation established this; the acting routes follow it.
 *
 * By class, and the class by the code: the client turns each code the computer answers with into one
 * of these through one table (`COMPUTER_ANSWERS` in client.ts). Nothing here reads a message — a
 * person at the wheel used to be found by matching `control` in one.
 */
function statusFor(error: unknown): 400 | 403 | 409 | 500 | 502 | 503 | 504 {
  // A caller that named something no filesystem should be asked about. The request is wrong, so it
  // is a 400 — never a 500, which would send an operator looking at a container that is behaving.
  if (error instanceof BotIdRefusedError) return 400;
  if (error instanceof StaleSnapshotError) return 409;
  // The same answer as a stale snapshot, because it is the same instruction: the element is not what
  // the call assumed, look again. Not 503, which says the computer is unavailable and sends an
  // operator hunting a container that is running perfectly.
  if (error instanceof ElementNotFoundError) return 409;
  // Nothing is broken; the caller has to wait or take control first, and 409 is how both of those
  // are already reported.
  if (error instanceof ControlHeldError) return 409;
  // The page did not load in time. Not 409 — a fresh snapshot would not help — and not 503, which
  // sends an operator after a container that is running: the site, not the computer, is the problem.
  if (error instanceof PageLoadTimeoutError) return 504;
  // The page did not open at all — a name that does not resolve, a connection refused. The site's
  // or the network's, like the timeout, and said with the gateway's own status for it.
  if (error instanceof PageLoadFailedError) return 502;
  if (error instanceof ComputerUnavailableError) return 503;
  // A refusal by the floor is the rules working, not a fault. Collapsing it into the same 5xx as an
  // unreachable computer would send somebody looking for an outage that is not happening.
  if (error instanceof NavigationRefusedError) return 403;
  // The computer refused the path itself, which is a different thing from the policy refusing this
  // Bot. Same status, no rule attached, because there is no rule to go and edit.
  if (error instanceof WorkspaceRefusedError) return 403;
  // A 400, deliberately, NOT a 403. The surface treats 403 as "a boundary refused you" and renders
  // it as Blocked, so returning it for "there is no file at notes.md" told both the person and the
  // model that a policy had intervened when none had.
  if (error instanceof WorkspaceRequestError) return 400;
  return 500;
}

/**
 * Which fact a failure is, for a surface that has to say it in the person's language.
 *
 * The failure's own code first — which, for anything the computer answered, is the container's code
 * as it came. The class alone cannot tell the facts that share one apart: a renamed control and a
 * stale ref are both a 409, a missing file and a closed tab both a 400, and each is a different next
 * move. The class decides only what a failure that carries no code is — the same branches as
 * `statusFor`, so the status and the code never describe two different failures — and always with
 * one of the container's own names (`agent-computer/src/codes.ts`), never a second spelling of it.
 * The pane shows the words for the code (`app/src/lib/computer/screen-problems.ts`), the model its
 * own (`shared/prompt/tool-results.ko.ts`).
 */
function codeFor(error: unknown): string {
  if (error instanceof BotIdRefusedError) return BOT_ID_INVALID;
  if (
    error instanceof StaleSnapshotError ||
    error instanceof ElementNotFoundError
  ) {
    return carriedBy(error) ?? STALE_REFS;
  }
  if (error instanceof ControlHeldError) {
    return carriedBy(error) ?? HUMAN_HAS_CONTROL;
  }
  if (error instanceof PageLoadTimeoutError) return PAGE_TIMEOUT;
  if (error instanceof PageLoadFailedError) {
    return carriedBy(error) ?? NAVIGATION_FAILED;
  }
  if (error instanceof ComputerUnavailableError) {
    return carriedBy(error) ?? COMPUTER_FAILED;
  }
  if (error instanceof NavigationRefusedError) {
    return carriedBy(error) ?? NAVIGATION_REFUSED;
  }
  if (error instanceof WorkspaceRefusedError) {
    return carriedBy(error) ?? FILE_PATH_REFUSED;
  }
  if (error instanceof WorkspaceRequestError) {
    return carriedBy(error) ?? REQUEST_INVALID;
  }
  // Anything else is not the computer's: an audit insert that failed, a bug. Its message is not a
  // fact whatever it starts with, and `failed` logs what it said.
  return COMPUTER_FAILED;
}

/** The code a computer failure carries as its message, if it carries one. */
function carriedBy(error: Error): string | undefined {
  return error.message.startsWith("laf:") ? error.message : undefined;
}
