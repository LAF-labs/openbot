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
 * routine's. The message is the code now, the way `PageLoadTimeoutError`'s already was. The model's
 * words for each are in `shared/prompt/tool-results.ko.ts`, the person's in `i18n-ko.ts`, and
 * `computer-routes-codes.test.ts` holds every code a Bot's tool can meet to having the model's.
 */

/** The caller stopped first: a person's Stop, or a routine's deadline. */
export const STOPPED = "laf:stopped";
/** Nothing answered the connection. The container is not running, or not where it was configured. */
export const COMPUTER_UNREACHABLE = "laf:computer_unreachable";
/**
 * It took the connection and did not answer within this client's deadline. Its own fact because the
 * cure is not the same: audit A3 (S3) found a slow page reported as a broken computer.
 */
export const COMPUTER_TIMED_OUT = "laf:computer_timed_out";
/** It answered with a failure this client has no more particular fact for. */
export const COMPUTER_FAILED = "laf:computer_failed";
/** The refs a call carried are not the page's any more. A fresh snapshot is the whole fix. */
export const STALE_REFS = "laf:stale_refs";
/** A page that did not open for a reason other than the deadline: a name that does not resolve. */
export const PAGE_FAILED = "laf:page_failed";
/** An address the floor will not open, or a hop or a landing that went inside this deployment. */
export const NAVIGATION_REFUSED = "laf:navigation_refused";
/** What the Bot asked to open is not a web address at all. */
export const URL_INVALID = "laf:url_invalid";
/** A path the workspace never lets a Bot name: absolute, `..`, outside it. */
export const WORKSPACE_PATH_REFUSED = "laf:workspace_path_refused";
/** A path it may name, with nothing usable there: no file, a folder, more than the limit. */
export const WORKSPACE_FILE_UNUSABLE = "laf:workspace_file_unusable";
/** A person's value arrived for a request that is no longer open. */
export const SECRET_NOT_PENDING = "laf:secret_not_pending";
/** A person's value could not be typed: the box it was for has left the page. */
export const SECRET_FIELD_GONE = "laf:secret_field_gone";

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

export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * The Bot acted on something that is not on the page.
 *
 * Its own error because it is its own condition, and the one the Bot can fix by taking a fresh
 * snapshot.
 *
 * The message a locator failure carries is a Playwright call log, several lines of `waiting for
 * locator('aria-ref=e5')`, which is noise to a model and to a person. It is replaced with the fact,
 * `laf:stale_refs`, whose words say what to do next.
 */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/** The fact a navigation that never finished is said with, on every path that reads it. */
export const PAGE_TIMEOUT = "laf:page_timeout";

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

export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/**
 * The file request itself was refused by the computer: outside the workspace, missing, or too large.
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
 * The request asked for something that is not there, or not usable: no such file, a folder where a
 * file was wanted, a write that is too big.
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
 * The refs the caller is using were taken before the page changed.
 *
 * Its own type because it is the one failure here that the model can fix without a person: take a new
 * snapshot and try again. Collapsed into a generic failure, the Bot apologises to the person instead.
 */
export class StaleSnapshotError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
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

      if (!response.ok) {
        const detail =
          typeof body?.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
        const fact = factOfAnswer(path, response.status, body, detail);
        /*
         * The computer stopped a navigation itself — a redirect hop into the deployment's own
         * network, judged where the browser follows it. Asked before the 403 branch, which would
         * otherwise read it as the workspace refusing a path. The reason the computer sends beside
         * the code is a sentence, and stays where it was written.
         */
        if (body?.code === NAVIGATION_REFUSED) {
          throw new NavigationRefusedError(NAVIGATION_REFUSED);
        }
        // A stale ref is fixed by taking a new snapshot, so it is not reported as the computer being
        // unavailable. A control renamed under its ref (`laf:label_changed`) is fixed the same way.
        if (response.status === 409) {
          throw new StaleSnapshotError(fact);
        }
        // These two must not be collapsed: path confinement and ordinary bad requests lead to
        // different next actions.
        // 403 is the path confinement: a boundary, and the answer will never change.
        if (response.status === 403) {
          throw new WorkspaceRefusedError(fact);
        }
        // 400 is an ordinary bad request: no such file, a folder where a file was wanted, too large. A
        // different request would succeed, which is exactly what the Bot needs to understand.
        if (response.status === 400) {
          throw new WorkspaceRequestError(fact);
        }
        /*
         * A locator that never resolved is not an outage. Playwright reports it as a timeout whose
         * message is a call log naming the selector, which is how "that button is not there" ended up
         * indistinguishable from "the computer is down".
         */
        // Asked before the locator branch, which would otherwise take it: `goto` times out with the
        // same word, and a page that will not load is not an element that left it.
        if (body?.code === PAGE_TIMEOUT || GOTO_TIMEOUT.test(detail)) {
          throw new PageLoadTimeoutError();
        }
        if (LOCATOR_TIMEOUT.test(detail)) {
          throw new ElementNotFoundError(fact);
        }
        throw new ComputerUnavailableError(fact);
      }
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
 * Playwright's words for a navigation that ran out of time: the deadline's word, and the navigation's
 * beside it.
 *
 * The call log's `navigating to "` ALONE is in every `goto` that failed, and it used to be enough —
 * so an address that does not resolve, refused by Chromium in under a second (`net::ERR_NAME_NOT_RESOLVED`,
 * 946 ms, measured 2026-09-14), reached the Bot as a page that had taken thirty seconds not to load.
 * The container says `laf:page_timeout` itself for a real one; this is for an image that does not.
 */
const GOTO_TIMEOUT =
  /goto: Timeout .* exceeded|Timeout .* exceeded[\s\S]*navigating to "/i;
/** And for a control it waited on in vain. */
const LOCATOR_TIMEOUT = /waiting for locator|Timeout .* exceeded/i;

/**
 * The fact an unsuccessful answer from the computer is.
 *
 * The container names most of what it refuses with a code, and a code passes through as it came.
 * Some it still says in words — a workspace path it will not hand over, a person driving without
 * the wheel, whatever Playwright threw — and a sentence from a service that knows no locale is not a
 * fact anybody downstream can phrase. So the words decide nothing here and go no further: what an
 * answer means is read off which door it came out of and with what status, which is also what the
 * container itself decided it on.
 */
function factOfAnswer(
  path: string,
  status: number,
  body: Record<string, unknown> | null,
  detail: string,
): string {
  for (const said of [body?.code, body?.error]) {
    if (typeof said === "string" && said.startsWith("laf:")) return said;
  }
  if (body?.stopped === true) return STOPPED;
  // A person's own hands: the masked box, and the live screen.
  if (path === "/human/secret") {
    return status === 409 ? SECRET_NOT_PENDING : SECRET_FIELD_GONE;
  }
  if (path.startsWith("/human/")) {
    return status === 409 ? "laf:take_control_first" : "laf:input_not_applied";
  }
  if (GOTO_TIMEOUT.test(detail)) return PAGE_TIMEOUT;
  if (status === 409 || LOCATOR_TIMEOUT.test(detail)) return STALE_REFS;
  if (path.startsWith("/files/") || path === "/upload") {
    if (status === 403) return WORKSPACE_PATH_REFUSED;
    if (status === 400) return WORKSPACE_FILE_UNUSABLE;
  }
  if (path === "/navigate") return PAGE_FAILED;
  return COMPUTER_FAILED;
}

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
