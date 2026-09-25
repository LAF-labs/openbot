/**
 * A browsing task, read out of the transcript: which calls it was, which sites, what was done, and
 * what the Bot is doing right now.
 *
 * THE UNIT IS THE TASK, NOT THE COMPUTER AND NOT THE CALL. A Bot that checks the weather opens a
 * page, reads it, clicks, reads again — four calls, one thing it did. The transcript used to draw a
 * line per call and a live screen per page opened, and the side pane opened itself for each of them.
 * Now the calls in a row are one task, the task is one card, and the card says it in words a person
 * would use. The live screen opens only when somebody asks for it (`live-view.tsx`).
 *
 * Pure, so the grouping, the sites and the sentences are tested without a browser.
 */
import { jsonObjectOf } from "@shared/json-object";
import {
  BROWSING_TOOL_NAMES,
  endingOfSteps,
  resultFactsOf,
  type TaskEnding as SharedEnding,
} from "@shared/task-ending";
import { siteNameOf } from "@/components/computer/task-title";
import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";
import { t } from "@/lib/i18n";

/**
 * The calls that use the Bot's browser, and so make up a browsing task.
 *
 * Not the workspace's file calls: they touch a folder, not a page, and a task card with a picture of
 * the browser beside "saved a file" would be a picture of something that did not happen. Not the
 * two requests for a person either — each of those is a card of its own (`help-card.tsx`), and it ends
 * the task in front of it, because what the Bot did after somebody helped it is a new stretch of
 * work with its own last picture.
 *
 * In `shared/task-ending.ts`, because 오늘 on the server folds the same calls into the same ending.
 */
export const BROWSING_TOOLS: ReadonlySet<string> = BROWSING_TOOL_NAMES;

/** One call in a task, as the transcript holds it. */
export type BrowsingStep = {
  id: string;
  name: string;
  /** The model's arguments, as the JSON string they arrive as. */
  args: string;
  /** The result, once there is one. Absent while the call is running. */
  result?: string;
};

/** What a computer call's result can say about itself. */
export type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  refused?: boolean;
  /** The fact, where there is one. The words come from this, not from `reason`. */
  code?: string;
  reason?: string;
  url?: string;
  title?: string;
  entries?: unknown[];
  /** Lines since `snapshot-lines.ts`; an array from an older server. */
  elements?: unknown[] | string;
  count?: number;
  element?: { role?: string; name?: string };
  tabs?: { title?: string; active?: boolean }[];
};

/** A result string, parsed. The runtime stringifies a thrown handler as "Error: <message>". */
export function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/** The arguments, parsed; empty for anything that is not an object, including a half-streamed one. */
export function argsOf(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  return jsonObjectOf(args) ?? {};
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not the model's arguments: those carry only a ref like `e12`. The server looked the element up in
 * its own snapshot, which is also what it wrote to the audit trail, so the card and the audit row
 * name the thing identically.
 */
export function labelOf(result: string | undefined): string | undefined {
  const name = outcomeOf(result).element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** The person's words for a code, or the server's own text where there is no code. */
export function labelForCode(
  code: unknown,
  fallback: unknown,
): string | undefined {
  const known = typeof code === "string" ? OUTCOME_LABELS[code] : undefined;
  if (known) return t(known);
  return typeof fallback === "string" && fallback.trim() ? fallback : undefined;
}

/** An ordinary failure rather than a refusal, so the two are drawn differently. */
export function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

/** The host of an address, without `www.`; null for anything that is not a web page. */
export function hostOf(address: unknown): string | null {
  if (typeof address !== "string" || !address.trim()) return null;
  try {
    const url = new URL(address.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The sites a task went to, in the order it first went to each.
 *
 * Where the page ended up rather than where the Bot asked to go when there is a result: a portal
 * that forwards `naver.com` to `www.naver.com/…` is one site, and a sign-in that bounces to
 * `nid.naver.com` is the site the person would want named.
 */
export function sitesOf(steps: readonly BrowsingStep[]): string[] {
  const sites: string[] = [];
  for (const step of steps) {
    if (step.name !== "computer_navigate") continue;
    const outcome = outcomeOf(step.result);
    const host =
      (outcome.ok === true ? hostOf(outcome.url) : null) ??
      hostOf(argsOf(step.args).url);
    if (host && !sites.includes(host)) sites.push(host);
  }
  return sites;
}

/** One line of the task's list of what it did: the existing transcript grammar, word for word. */
export type StepLine = {
  label: string;
  detail?: string;
  running: boolean;
  refused: boolean;
  failed: boolean;
};

/**
 * What a step was, as a line under the card.
 *
 * Never a typed value: a fill names the field it went into and nothing it put there (CLAUDE.md,
 * "Never record what somebody typed" — the Bot's own typing is in its arguments, and this does not
 * read them).
 */
export function stepLine(step: BrowsingStep): StepLine {
  const outcome = outcomeOf(step.result);
  const args = argsOf(step.args);
  const running = step.result === undefined;
  const refused = outcome.refused === true;
  const failed = didNotWork(outcome);
  const why =
    refused || failed ? labelForCode(outcome.code, outcome.reason) : undefined;
  const base = { running, refused, failed };
  switch (step.name) {
    case "computer_navigate":
      return {
        ...base,
        label: t("Opened"),
        detail:
          why ??
          (typeof outcome.title === "string" && outcome.title.trim()
            ? outcome.title.trim()
            : (hostOf(outcome.url) ?? hostOf(args.url) ?? undefined)),
      };
    case "computer_read":
      return { ...base, label: t("Read the page"), detail: why };
    case "computer_snapshot": {
      // A number since the snapshot became lines (`snapshot-lines.ts`); an array from an older server.
      const count =
        typeof outcome.count === "number"
          ? outcome.count
          : Array.isArray(outcome.elements)
            ? outcome.elements.length
            : 0;
      return {
        ...base,
        label: t("Read the page"),
        detail:
          why ??
          (count ? t("{count} things it can act on", { count }) : undefined),
      };
    }
    case "computer_click":
      return {
        ...base,
        label: t("Clicked"),
        detail: why ?? labelOf(step.result),
      };
    case "computer_type":
      return {
        ...base,
        label: t("Filled in"),
        detail: why ?? labelOf(step.result),
      };
    case "computer_key":
      return {
        ...base,
        label: t("Pressed"),
        detail: why ?? (typeof args.key === "string" ? args.key : undefined),
      };
    case "computer_scroll":
      return { ...base, label: t("Scrolled"), detail: why };
    case "computer_switch_tab":
      return {
        ...base,
        label: t("Switched tab"),
        // The tab's own title, never its address: long, and half of it a session id.
        detail: why ?? outcome.tabs?.find((tab) => tab.active)?.title,
      };
    case "computer_upload_file":
      return {
        ...base,
        label: t("Attached file"),
        detail: why ?? (typeof args.path === "string" ? args.path : undefined),
      };
    default:
      return { ...base, label: step.name, detail: why };
  }
}

/**
 * What the Bot is doing right now, for the banner: the step that is running, or — between steps,
 * while the model decides — that it is deciding.
 *
 * Present tense and short, because it sits beside a site name on one line of a banner.
 */
export function doingNow(steps: readonly BrowsingStep[]): string {
  const last = steps.at(-1);
  if (!last || last.result !== undefined) return t("Working out the next step");
  const host = hostOf(argsOf(last.args).url);
  switch (last.name) {
    case "computer_navigate":
      // The site as people call it (네이버), as the card title does, not its host.
      return host
        ? t("Opening {site}", { site: siteNameOf(host) })
        : t("Opening a page");
    case "computer_read":
    case "computer_snapshot":
      return t("Reading the page");
    case "computer_click":
      return t("Clicking");
    case "computer_type":
      return t("Filling in");
    case "computer_key":
      return t("Pressing a key");
    case "computer_scroll":
      return t("Scrolling");
    case "computer_switch_tab":
      return t("Switching tab");
    case "computer_upload_file":
      return t("Attaching a file");
    default:
      return t("Working in the browser");
  }
}

/**
 * How a task stands: running, or how it ended (`shared/task-ending.ts`, the one decision the card,
 * 오늘 and the drawer all read). 사장님 차례 is not here: it is a question open on a step, which the
 * card subscribes to (`task-state.ts`).
 */
export type TaskEnding = { kind: "running" } | SharedEnding;

export function endingOf(
  steps: readonly BrowsingStep[],
  isOpen: boolean,
  cutOff: CutOff = null,
): TaskEnding {
  if (isOpen) return { kind: "running" };
  const ending = endingOfSteps(
    steps.map((step) => ({
      name: step.name,
      facts: resultFactsOf(step.result),
    })),
  );
  if (ending.kind !== "done" || cutOff === null) return ending;
  return cutOff === "failed"
    ? { kind: "failed", code: null }
    : { kind: "stopped" };
}

/**
 * A task whose turn ended right after its last step, with nothing said after it — the Bot was
 * between steps when the turn ended. `failed` when the turn left a failure line, `stopped` when it
 * did not (the owner pressed Stop, or sent something else over it), null when the Bot answered.
 *
 * MEASURED 2026-09-25 (0.5.4 final QA): Stop pressed while the Bot was thinking between two steps
 * of a Naver News task left the card reading 끝남 — the last step had worked — while 오늘 read the
 * same turn's ledger and said 멈춤, and no 이어서 하기 was offered. The steps alone cannot tell a
 * finished task from one cut off between two of them; whether the Bot spoke after is the fact.
 */
export type CutOff = "stopped" | "failed" | null;

/**
 * The call whose result carries the task's last picture: the last one that has a result.
 *
 * A call that never got one — the run was stopped mid-action — has no result row for the picture to
 * sit on, and the picture of the step before it is the last thing that is known to have happened.
 */
export function pictureStepOf(steps: readonly BrowsingStep[]): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.result !== undefined) return step.id;
  }
  return null;
}
