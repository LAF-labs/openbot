import { BotIdRefusedError, isBotId } from "./bot-id";
import type {
  ActionResult,
  ClickInput,
  ComputerProfile,
  ComputerStatus,
  ControlState,
  HumanInput,
  HumanInputResult,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateResult,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SnapshotResult,
  SwitchTabInput,
  SwitchTabResult,
  TypeInput,
  UploadFileInput,
  UploadFileResult,
  WriteFileInput,
  WriteFileResult,
} from "./schema";
import { checkNavigationTarget } from "./target";

/**
 * How the server talks to a Bot's computer.
 *
 * The computer has no authentication of its own and trusts whatever reaches it, so this module is
 * the boundary: it decides whether a navigation is permitted before the request leaves, and it is
 * the only place that knows the computer's address. Nothing downstream of here should be handed a
 * raw URL from a model.
 */

export type ComputerClientOptions = {
  /**
   * The secret this deployment's computers require. Absent means every call is refused by them, which
   * is the correct failure: a computer that answers an unauthenticated caller is the bug.
   */
  token?: string;
  /** Base URL of the Bot's computer, e.g. http://agent-computer:4100 */
  baseUrl: string;
  /** True on a laptop, where browsing the deployment's own services is the point. */
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/*
 * THE FACTS THIS CLIENT RAISES. EVERY ERROR BELOW CARRIES ONE AS ITS MESSAGE, AND NO SENTENCE.
 *
 * They carried English until 2026-09-14 — this file's own ("The assistant's computer is not
 * running.") or whatever the computer container put in `error`, a Playwright call log among them —
 * and the routes answered with it: onto a Korean screen, into a model's tool result, into a
 * routine's. The message is the code now.
 *
 * ONE VOCABULARY. What happened inside the browser is the container's to name
 * (`agent-computer/src/codes.ts`), and its code passes through as it came, through the one table
 * below. The names this file adds are only for what no answer from the computer could say: that
 * nothing answered, that it answered too late or without a code, that the caller had already
 * stopped, or that the floor refused the address before anything was sent. The model's words for
 * all of them are in `shared/prompt/tool-results.ko.ts`, the person's in the app's tables, and
 * `app/tests/computer-codes.test.ts` holds both to the container's list and to this file.
 */

/** The caller stopped first: a person's Stop, or a routine's deadline. The container says it too. */
export const STOPPED = "laf:stopped";
/** Nothing answered the connection. The container is not running, or not where it was configured. */
export const COMPUTER_UNREACHABLE = "laf:computer_unreachable";
/**
 * It took the connection and did not answer within this client's deadline. Its own fact because the
 * cure is not the same: audit A3 (S3) found a slow page reported as a broken computer.
 */
export const COMPUTER_TIMED_OUT = "laf:computer_timed_out";
/** It answered with a failure that carried no code — an older image, or not the computer at all. */
export const COMPUTER_FAILED = "laf:computer_failed";
/** What the Bot asked to open is not a web address at all. Only the floor here says this. */
export const URL_INVALID = "laf:url_invalid";

/** The facts this client says itself, where the computer's answer could not. */
export const CLIENT_FACTS = [
  STOPPED,
  COMPUTER_UNREACHABLE,
  COMPUTER_TIMED_OUT,
  COMPUTER_FAILED,
  URL_INVALID,
] as const;

/*
 * The container's names this server also has to say itself — a floor that refuses before the call, a
 * check the gateway makes on its own snapshot, the fallback for an error that reached a route without
 * a code. The same strings as `codes.ts`, never a second spelling of one.
 */
/** The refs a call carried are not the page's any more. A fresh snapshot is the whole fix. */
export const STALE_REFS = "laf:stale_refs";
/** A person holds the wheel. */
export const HUMAN_HAS_CONTROL = "laf:human_has_control";
/** An address the floor will not open, or a hop or a landing that went inside this deployment. */
export const NAVIGATION_REFUSED = "laf:navigation_refused";
/** The page never finished loading by the computer's deadline. */
export const PAGE_TIMEOUT = "laf:page_timeout";
/** A page that did not open for a reason other than the deadline: a name that does not resolve. */
export const NAVIGATION_FAILED = "laf:navigation_failed";
/** A path the workspace never lets a Bot name: absolute, `..`, outside it. */
export const FILE_PATH_REFUSED = "laf:file_path_refused";
/** A request the computer could not use as it was sent. */
export const REQUEST_INVALID = "laf:request_invalid";

/**
 * The fact a failure from this client carries, for a caller that has to answer with one.
 *
 * Every error this file raises has its code as its message; anything else that reaches a caller —
 * a bug, a thrown string — is a failure nobody named, and says so rather than what it said.
 */
export function factOfError(error: unknown): string {
  return error instanceof Error && error.message.startsWith("laf:")
    ? error.message
    : COMPUTER_FAILED;
}

/**
 * The computer could not do it: nothing answered, the browser or the disk failed, its door refused
 * this server, or the caller stopped. 503 at the routes — an operator's problem, not a rewording.
 */
export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * The Bot acted on an element that would not take the action: hidden, covered, disabled, not a field.
 *
 * Its own error because it is its own condition, and the one the Bot can fix by looking again. Until
 * 2026-09-14 it was recognised by Playwright's call log in the answer — `waiting for locator(…)` —
 * and a call log was also what a failed `fill` put the typed value in; the container names it
 * `laf:element_not_actionable` now, and that is all this reads.
 */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/**
 * The page never finished loading.
 *
 * Playwright reports this as a timeout too, so until 2026-09-06 it fell into the locator branch
 * and a Bot facing a site its browser could not reach was told an ELEMENT had gone and to snapshot
 * again — measured against 기업마당: four navigations, two snapshots, six minutes, and nothing
 * anybody could act on. The message is the fact code, so the surface and the runner say it in
 * Korean and the audit row holds a fact rather than a sentence.
 */
export class PageLoadTimeoutError extends Error {
  constructor() {
    super(PAGE_TIMEOUT);
    this.name = "PageLoadTimeoutError";
  }
}

/**
 * The page did not open for a reason that is the site's or the network's: a name that does not
 * resolve, a connection refused. 502 at the routes, beside the timeout's 504 — the site, not the
 * computer, which is what a 503 would have said about an address with a typo in it.
 */
export class PageLoadFailedError extends Error {
  constructor(reason: string = NAVIGATION_FAILED) {
    super(reason);
    this.name = "PageLoadFailedError";
  }
}

export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/**
 * The file request itself was refused by the computer: a path outside the workspace.
 *
 * Distinct from a policy refusal, which happens in the gateway before the request is ever made. Both
 * reach the browser as a 403 but they mean different things: this one says the path is not a thing a
 * Bot may name at all, the other says this Bot may not touch an otherwise perfectly valid path. Only
 * the second has a rule an administrator can go and edit.
 */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/**
 * The request asked for something that is not there, or not usable as sent: no such file, a folder
 * where a file was wanted, a write that is too big, a tab that is not open, a part left out.
 *
 * Not a refusal. Nothing declined to let the Bot do this; the thing it named does not fit the request.
 * Kept separate from {@link WorkspaceRefusedError} because a Bot's next move differs completely: here
 * it should look at what IS there and try again, whereas a refusal is final and should be reported.
 */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/**
 * What the call was made against has moved on: refs from an older snapshot, a control renamed under
 * its ref, a secret request that closed before its value arrived.
 *
 * Its own type because it is the failure the model can fix without a person: take a new snapshot and
 * try again. Collapsed into a generic failure, the Bot apologises to the person instead.
 */
export class StaleSnapshotError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

/**
 * A person holds the wheel, or drove before taking it. Nothing is broken, and nothing to look again
 * at: the Bot waits. A 409 like a stale ref, and its own type because routes.ts used to find it by
 * matching `control` in the message.
 */
export class ControlHeldError extends Error {
  constructor(reason: string = HUMAN_HAS_CONTROL) {
    super(reason);
    this.name = "ControlHeldError";
  }
}

/**
 * WHAT THIS SERVER MAKES OF EACH FACT THE COMPUTER ANSWERS WITH. THE ONE TABLE, READ BY `code`.
 *
 * The container decides what happened and says so in `code` (`agent-computer/src/codes.ts`); the code
 * travels on as the message of the error this throws, unchanged. What the table adds is the one thing
 * the container cannot know — which of this server's failures it is, and so the status its routes
 * answer (`statusFor` in routes.ts) and the next move a Bot is told to make.
 *
 * UNTIL 2026-09-14 THIS WAS READ OFF EVERYTHING BUT THE CODE: the status (a 409 was a stale snapshot,
 * a 403 the workspace, a 400 a missing file), the door (`/human/secret` was a gone box), and for a
 * timeout, Playwright's first line, which the container kept in `error` for this file's regular
 * expression. Two vocabularies grew out of it — `laf:page_failed` beside the container's
 * `laf:navigation_failed`, `laf:workspace_file_unusable` for three facts the container already told
 * apart — and each surface had words for one of them.
 */
export const COMPUTER_ANSWERS = {
  // Look again: the page, the control or the request has moved on from what the call carried.
  "laf:stale_refs": StaleSnapshotError,
  "laf:label_changed": StaleSnapshotError,
  "laf:secret_not_pending": StaleSnapshotError,
  "laf:element_not_actionable": ElementNotFoundError,
  // Wait: a person has the wheel, or has not taken it.
  "laf:human_has_control": ControlHeldError,
  "laf:take_control_first": ControlHeldError,
  // The site, not the computer.
  "laf:page_timeout": PageLoadTimeoutError,
  "laf:navigation_failed": PageLoadFailedError,
  // Never: the floor, and the workspace's walls.
  "laf:navigation_refused": NavigationRefusedError,
  "laf:file_path_refused": WorkspaceRefusedError,
  // Send something different.
  "laf:file_not_found": WorkspaceRequestError,
  "laf:file_wrong_kind": WorkspaceRequestError,
  "laf:file_too_large": WorkspaceRequestError,
  "laf:tab_missing": WorkspaceRequestError,
  "laf:request_invalid": WorkspaceRequestError,
  "laf:bot_id_invalid": BotIdRefusedError,
  // The computer could not: its browser, its disk, a caller that left, its door refusing this server.
  "laf:browser_failed": ComputerUnavailableError,
  "laf:navigation_guard_unavailable": ComputerUnavailableError,
  "laf:file_failed": ComputerUnavailableError,
  "laf:stopped": ComputerUnavailableError,
  "laf:computer_token_refused": ComputerUnavailableError,
  "laf:computer_route_unknown": ComputerUnavailableError,
  "laf:bot_header_missing": ComputerUnavailableError,
  "laf:stream_upgrade_required": ComputerUnavailableError,
} as const satisfies Record<`laf:${string}`, new (code: string) => Error>;

/** The shape a code has. Anything else in `code` is not one, whatever it starts with. */
const CODE_SHAPE = /^laf:[a-z0-9_]{1,64}$/;

/**
 * The failure an unsuccessful answer from the computer is: its code, as the error the table names.
 *
 * A code the table does not know still passes through — a newer container than this server, for the
 * length of a rollout — as the computer not managing it, because a fact is a fact and swallowing it
 * would put `laf:computer_failed` in the trail where the real one was. An answer with no code is the
 * one this file names itself.
 */
function failureOf(body: Record<string, unknown> | null): Error {
  const code = body?.code;
  if (typeof code !== "string" || !CODE_SHAPE.test(code)) {
    return new ComputerUnavailableError(COMPUTER_FAILED);
  }
  const Failure = Object.hasOwn(COMPUTER_ANSWERS, code)
    ? COMPUTER_ANSWERS[code as keyof typeof COMPUTER_ANSWERS]
    : ComputerUnavailableError;
  return new Failure(code);
}

export function createComputerClient(options: ComputerClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  /*
   * The secret the computer demands. Without it this process is just another caller, which is the
   * point: a computer that answers without this token bypasses the policy gateway, audit trail, and
   * sign-in boundary.
   */
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const base = options.baseUrl.replace(/\/$/, "");

  /**
   * A view of the computer as one Bot.
   *
   * Which Bot is asking has to reach the computer, or nothing on the far side can be per-Bot: its
   * profile, its logins, the proxy its traffic leaves through and who holds its wheel all key off this
   * one string. If the id is omitted, every Bot resolves the same fixed default and per-Bot settings
   * such as `EGRESS_PROXY_<BOT>` cannot apply.
   *
   * A bound view rather than a parameter on twenty methods: the gateway already knows the Bot at the
   * point it acts, and threading it through every signature would put the same argument in every call
   * site for a value that never changes within a request.
   */
  function build(botId?: string) {
    async function call(
      path: string,
      init?: RequestInit,
      caller?: AbortSignal,
    ): Promise<unknown> {
      // Already stopped before this left: do not dispatch at all. Relying on fetch to reject an
      // aborted signal makes "did the click happen" depend on how quickly the runtime notices, and
      // the answer to "the person pressed Stop first" should never be a race.
      if (caller?.aborted) {
        throw new ComputerUnavailableError(STOPPED);
      }

      /*
       * THE HEADER IS A DIRECTORY NAME ON THE FAR SIDE, so this is the last place that can stop a
       * `../..` from becoming one. The routes check the id before they call the gateway; this is
       * here for the caller that is not a route — the runner's toolkit, an account deletion, the
       * next thing somebody wires up — because the header is invented in this file and nowhere else,
       * which makes it the only check that cannot be skipped by forgetting about it. See bot-id.ts.
       */
      if (botId !== undefined && !isBotId(botId)) {
        throw new BotIdRefusedError();
      }

      let response: Response;
      try {
        response = await doFetch(`${base}${path}`, {
          ...init,
          // The Bot's identity, as a header rather than in the path, so the computer's published routes
          // are unchanged and a caller that does not know which Bot it is still works.
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...(botId ? { "x-openbot-bot-id": botId } : {}),
            ...(token ? { "x-openbot-computer-token": token } : {}),
          },
          /*
           * Both reasons to give up. The timeout protects the server from a computer that
           * has stopped answering; `caller` is the person pressing Stop, and it has to reach the
           * browser or the click they were stopping still lands. Combined rather than chosen between:
           * whichever fires first ends the request.
           */
          signal: caller
            ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
          /*
           * A CONNECTION OF ITS OWN FOR EVERY CALL, NEVER ONE FROM THE POOL.
           *
           * Replacing the container under a running server — what `laf upgrade` does when only this
           * image changed — hung the next four calls for 45 s each (W2-g, 2026-09-14), with `lsof`
           * showing the server's socket to the port and Docker's forwarder's end of it both still
           * ESTABLISHED. fetch keeps the sockets of finished calls; a request written into one whose
           * container is gone is answered by nobody, fetch waits out the whole deadline, lets that
           * socket go, and the next call takes the next one — four calls at once had left four.
           * Nothing on this side can tell that silence from a slow page until the deadline says so.
           *
           * Measured through this server and a real container behind a forwarder that keeps a
           * connection's host side open (Docker Desktop 4.76 closed them on `docker rm -f` in six
           * tries here; W2-g's did not): four calls 45.0 s each and then 0.8 s, before; the first call
           * 0.39 s, after. A call made while the new container is still starting is refused in
           * 0.01 s as `laf:computer_unreachable`, and the one after it is answered.
           *
           * What it costs is the handshake: 200 `/health` calls through the forwarder took 1.0–1.1 ms
           * at the median against 0.35–0.41 ms pooled — not what a click or a screen's poll waits on.
           * Bun's `keepalive: false` is what keeps a call out of the pool; a `Connection: close`
           * header is not, because the request carrying it takes a pooled socket first (measured).
           */
          keepalive: false,
        });
      } catch (error) {
        // Distinguished from a failed page load on purpose: this one means the computer itself is not
        // there, which is an operator problem, not something the person asking can fix by rephrasing.
        // A caller that stopped mid-request is neither, and says so.
        throw new ComputerUnavailableError(
          caller?.aborted
            ? STOPPED
            : error instanceof Error && error.name === "TimeoutError"
              ? COMPUTER_TIMED_OUT
              : COMPUTER_UNREACHABLE,
        );
      }

      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      // The code, and nothing else about the answer: not its status, not the door it came out of,
      // and never `error`, which is where Playwright's words used to ride. See COMPUTER_ANSWERS.
      if (!response.ok) throw failureOf(body);
      return body;
    }

    async function post(
      path: string,
      payload: unknown,
      caller?: AbortSignal,
    ): Promise<unknown> {
      return call(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        caller,
      );
    }

    // Named, so a method can reach a sibling without `this` — which a caller that detaches a
    // method (`const { navigate } = client`) would leave pointing at nothing.
    const computer = {
      async status(botId: string): Promise<ComputerStatus> {
        try {
          await call("/health");
          return { botId, state: "ready" };
        } catch (error) {
          return {
            botId,
            state: "unreachable",
            // The fact, never what the failure said: this reason is rendered on a status card, and
            // the failure behind it did not necessarily start in this file. See failure-text.ts.
            reason: factOfError(error),
          };
        }
      },

      /**
       * Open a page. Refuses before the request leaves if the target is not permitted.
       *
       * `holdAtNewHost` asks the computer to stop, rather than follow, the first hop that reaches a
       * host other than this one — before that host is contacted — and to hand it back as
       * `redirect`. The gateway uses it so a redirect is judged by the policy like the address that
       * started it; a caller that does not pass it gets redirects followed under the floor alone.
       * After `caller`, so the callers that pass only a signal are untouched.
       */
      async navigate(
        url: string,
        caller?: AbortSignal,
        navigation: NavigateOptions = {},
      ): Promise<NavigateResult> {
        const verdict = checkNavigationTarget(url, {
          allowPrivateHosts: options.allowPrivateHosts,
        });
        if (!verdict.allowed) {
          throw new NavigationRefusedError(floorRefusalOf(url));
        }

        const result = (await call(
          "/navigate",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: verdict.url,
              ...(navigation.holdAtNewHost ? { holdAtNewHost: true } : {}),
              ...(navigation.referer ? { referer: navigation.referer } : {}),
            }),
          },
          caller,
        )) as NavigateResult;

        /*
         * WHERE IT LANDED, judged as well as where it was asked to go.
         *
         * The check above is on the address the Bot named, before the request. Measured 2026-09-10
         * (audit A3): a public redirector that 302s to 127.0.0.1 passed it, and the browser followed
         * the redirect and handed back the page. The computer now stops every such hop before the
         * host is contacted (agent-computer/src/navigation-guard.ts), so this is the net under an
         * OLDER computer image, the one a deployment runs until it pulls: it cannot stop the request,
         * but it keeps the answer out of the model's context, and it closes the browser so the page
         * is not there for the next `computer_read` to fetch. Only web addresses are judged:
         * `about:blank` after a refusal is not a host that was reached.
         */
        if (/^https?:/i.test(result.url)) {
          const landed = checkNavigationTarget(result.url, {
            allowPrivateHosts: options.allowPrivateHosts,
          });
          if (!landed.allowed) {
            await computer.stopComputer().catch(() => undefined);
            throw new NavigationRefusedError(NAVIGATION_REFUSED);
          }
        }
        return result;
      },

      async screenshot(): Promise<ScreenshotResult> {
        return (await call("/screenshot")) as ScreenshotResult;
      },

      /** The current page as text. No navigation, so no target check applies. */
      async read(): Promise<ReadResult> {
        return (await call("/read")) as ReadResult;
      },

      async snapshot(): Promise<SnapshotResult> {
        return (await call("/snapshot", { method: "POST" })) as SnapshotResult;
      },

      /**
       * The acting calls.
       *
       * Deliberately unguarded here. Unlike `navigate`, which checks its target in this module, these
       * carry no policy of their own: the gateway in front of them is the only thing that knows which
       * Bot is asking and what the deployment allows, and putting a second half-check here would create
       * two places to keep in agreement. Never call these directly from a route.
       */
      async click(
        input: ClickInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/click", input, caller)) as ActionResult;
      },

      async type(
        input: TypeInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/type", input, caller)) as ActionResult;
      },

      async key(input: KeyInput, caller?: AbortSignal): Promise<ActionResult> {
        return (await post("/key", input, caller)) as ActionResult;
      },

      async scroll(
        input: ScrollInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/scroll", input, caller)) as ActionResult;
      },

      /**
       * Move to another tab.
       *
       * Nothing on any website changes because somebody looked at a different page of it, which is
       * why the gateway governs this as a read. What it does change is where the next action lands,
       * so the computer retires the refs from the last snapshot when it happens.
       */
      async switchTab(
        input: SwitchTabInput,
        caller?: AbortSignal,
      ): Promise<SwitchTabResult> {
        return (await post("/tabs/switch", input, caller)) as SwitchTabResult;
      },

      /** Hand a file from the Bot's workspace to a file input on the page. */
      async uploadFile(
        input: UploadFileInput,
        caller?: AbortSignal,
      ): Promise<UploadFileResult> {
        return (await post("/upload", input, caller)) as UploadFileResult;
      },

      /**
       * The workspace files. Also unguarded here: the computer confines the path to the workspace, and
       * the gateway decides whether this Bot may touch it. Two questions, neither answered in this file.
       */
      async readFile(input: ReadFileInput): Promise<ReadFileResult> {
        return (await post("/files/read", input)) as ReadFileResult;
      },

      async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
        return (await post("/files/write", input)) as WriteFileResult;
      },

      async listFiles(input: ListFilesInput): Promise<ListFilesResult> {
        return (await post("/files/list", input)) as ListFilesResult;
      },

      /** Who has the wheel, and whether the Bot is waiting for a person. */
      async control(): Promise<ControlState> {
        return (await call("/control")) as ControlState;
      },

      async requestControl(reason: string): Promise<ControlState> {
        return (await post("/control/request", { reason })) as ControlState;
      },

      async takeControl(): Promise<ControlState> {
        return (await post("/control/take", {})) as ControlState;
      },

      async releaseControl(): Promise<ControlState> {
        return (await post("/control/release", {})) as ControlState;
      },

      /**
       * A person's own mouse and keyboard, straight through.
       *
       * Deliberately NOT governed by the policy gateway. The policy exists to constrain what a BOT may
       * do; a person taking the wheel is the escape hatch that makes a governed Bot usable at all, and
       * a rule that could lock somebody out of their own browser mid-login would be a worse failure
       * than anything it prevented. The takeover itself is audited as an event; the keystrokes are not.
       */
      /** Ask for a secret. Carries the label and the field, never a value. */
      async requestSecret(input: SecretRequest): Promise<ControlState> {
        return (await post("/control/secret", input)) as ControlState;
      },

      /**
       * Supply one. The value passes through this call and is kept nowhere: not returned upward, not
       * logged here, and not written to the audit trail by the gateway.
       */
      /** The computers this process holds, running or not. */
      async computers(): Promise<{ computers: ComputerProfile[] }> {
        return (await call("/computers")) as { computers: ComputerProfile[] };
      },

      /** Stop the browser and keep what it knows. */
      async stopComputer(): Promise<{ stopped: boolean; wasRunning: boolean }> {
        return (await post("/computers/stop", {})) as {
          stopped: boolean;
          wasRunning: boolean;
        };
      },

      /** Delete the profile. Every login the Bot had goes with it. */
      async resetComputer(): Promise<{ reset: boolean; botId: string }> {
        return (await post("/computers/reset", {})) as {
          reset: boolean;
          botId: string;
        };
      },

      async supplySecret(text: string): Promise<SecretResult> {
        return (await post("/human/secret", { text })) as SecretResult;
      },

      async humanInput(input: HumanInput): Promise<HumanInputResult> {
        const { kind, ...rest } = input;
        return (await post(`/human/${kind}`, rest)) as HumanInputResult;
      },

      /** The same computer, addressed as a particular Bot. */
      forBot(id: string) {
        return build(id);
      },
    };
    return computer;
  }

  return build();
}

export type ComputerClient = ReturnType<typeof createComputerClient>;

/** How a navigation is asked for. See `navigate`. */
export type NavigateOptions = {
  holdAtNewHost?: boolean;
  /** The `Referer` a held hop was carrying, sent again when that hop is asked for. */
  referer?: string;
};

/**
 * Which refusal the navigation floor's verdict was.
 *
 * The verdict says it in a sentence, and the floor is shared with the browser container, whose own
 * tests pin those sentences — so the fact is read off the address instead, which is all the verdict
 * read it off too. Anything that is not an http(s) URL is refused for being no web address at all,
 * and is fixed by writing one; everything else the floor refuses, it refuses for where it points,
 * and no rewording opens it.
 */
function floorRefusalOf(raw: string): string {
  if (!URL.canParse(raw)) return URL_INVALID;
  const { protocol } = new URL(raw);
  return protocol === "http:" || protocol === "https:"
    ? NAVIGATION_REFUSED
    : URL_INVALID;
}
