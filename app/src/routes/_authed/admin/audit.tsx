import { IconRefresh } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { Fragment, useMemo, useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { auditEventsQueryOptions } from "@/lib/audit/queries";
import { type AuditRun, dayKeyOf, groupByDay } from "@/lib/audit/rows";
import { silenceOf } from "@/lib/audit/silence";
import { activeLocale, t } from "@/lib/i18n";
import { josa } from "@/lib/josa";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

const FILTERS = [
  { label: "Everything", search: "" },
  { label: "Computer actions", search: "?eventType=computer.action_allowed" },
  {
    label: "Blocked",
    // Include every refusal family, not only browser policy refusals. A person declining a request
    // stopped an action just as surely as a deny rule did, and it leaves no action row of its own,
    // so without it here the trail's answer to "was anything blocked" is missing a whole family.
    search:
      "?eventType=computer.action_refused,approval.denied,mcp.call_rejected,component.refused,component.function_refused",
  },
  {
    label: "Did not happen",
    // A stalled stream belongs here. It is the same complaint as an action that was allowed and then
    // did not take: nothing was refused, and nothing came of it either.
    search: "?eventType=computer.action_failed,agent.stream_stalled",
  },
  {
    /*
     * The questions, so the one a person never answered can be found rather than looked for by eye.
     * A request with no answer beside it is the Bot having sat waiting while nobody was watching the
     * screen, which is the case this trail records that nothing else in the product would show.
     */
    label: "Asked a person",
    search:
      "?eventType=approval.requested,approval.granted,approval.denied,approval.standing_granted,approval.standing_revoked",
  },
  {
    // Its own filter rather than a place in "Blocked". A Bot repeating itself has not been stopped by
    // anything, and putting it beside the refusals would make the refusals look less real.
    label: "Going in circles",
    // Both halves of the boundary. A Bot stuck on somebody else's MCP tool is going in circles for
    // the same reason and by the same counter as one stuck on a button.
    search: "?eventType=computer.action_repeated,mcp.call_repeated",
  },
] as const;

function AuditPage() {
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useInfiniteQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.pages ?? []).flatMap((page) => page.events);
  const nameFor = useBotNames();
  /*
   * Days, and inside them runs. The trail is a year long and every row used to carry a bare clock
   * time, so "09:12:44" was the whole of when — on a page whose first question is always which day.
   * The heading carries the date once per day rather than the cell carrying it a hundred times.
   */
  const days = useMemo(() => groupByDay(rows), [rows]);
  /*
   * Recomputed per render on purpose. The alternative is a value captured at mount, and this page is
   * one somebody leaves open: a trail still labelling last night's rows as today at nine the next
   * morning is a date that is quietly wrong on the screen that exists for dates.
   */
  const today = dayKeyOf(new Date().toISOString());
  const yesterday = dayKeyOf(new Date(Date.now() - DAY_MS).toISOString());

  return (
    /*
     * THE ONE WIDE PAGE IN ADMIN, and the one that keeps a table. Five columns of short values is
     * what a log is; rows of prose would make every entry a paragraph and the scanning this page
     * exists for impossible. It takes the same header and the same type scale as everything else,
     * and differs only where the content forces it to.
     */
    <PageShell
      action={
        <Button
          // A refresh that takes a second looked ignored: nothing moved until the answer landed.
          disabled={events.isFetching}
          onClick={() => void events.refetch()}
          size="sm"
          variant="ghost"
        >
          <IconRefresh />
          {events.isFetching ? t("Refreshing…") : t("Refresh")}
        </Button>
      }
      description={t(
        "Every action a Bot took, and every one this deployment's policy refused.",
      )}
      title={t("Audit")}
      width="wide"
    >
      <PageSection>
        {/*
         * `aria-pressed`, not `role="tab"`. These do choose which panel is shown, which is what a
         * tablist is for — but that role promises arrow-key navigation and a roving tabindex, and
         * a screen reader announcing "tab 2 of 3" in front of controls that only answer to Tab
         * and Enter is a worse lie than no role at all. As toggle buttons they are exactly what
         * they are, and the chosen fill and the announced state finally come from one attribute.
         */}
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              aria-pressed={search === filter.search}
              key={filter.label}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t(filter.label)}
            </Button>
          ))}
        </div>

        {events.isPending && rows.length === 0 ? (
          <PageEmpty>{t("Loading the trail…")}</PageEmpty>
        ) : events.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("The audit trail could not be loaded.")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>{t("No events match this filter yet.")}</PageEmpty>
        ) : (
          <div
            className="mt-4 overflow-x-auto rounded-lg border border-border bg-card transition-opacity data-[fetching=true]:opacity-60"
            data-fetching={events.isFetching}
          >
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">{t("When")}</th>
                  <th className="px-4 py-2 font-medium">{t("What")}</th>
                  <th className="px-4 py-2 font-medium">{t("Target")}</th>
                  <th className="px-4 py-2 font-medium">{t("Bot")}</th>
                  <th className="px-4 py-2 font-medium">{t("Decision")}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <Fragment key={day.key}>
                    <tr className="border-border border-t bg-muted/40">
                      <th
                        className="px-4 py-1.5 text-left font-medium text-muted-foreground text-xs"
                        colSpan={5}
                        scope="colgroup"
                      >
                        {day.key === today
                          ? `${t("Today")} · ${dateOf(day.at)}`
                          : day.key === yesterday
                            ? `${t("Yesterday")} · ${dateOf(day.at)}`
                            : dateOf(day.at)}
                      </th>
                    </tr>
                    {day.runs.map((run) => (
                      <Row key={run.event.id} nameFor={nameFor} run={run} />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
         * Under the table, not inside it. The count says what has been read so far rather than how
         * much there is: the server answers with a page and a cursor, never a total, and inventing
         * "100 of 3,412" from a cursor is a number nobody counted.
         */}
        {rows.length > 0 ? (
          <div className="mt-3 flex items-center gap-3">
            {events.hasNextPage ? (
              <Button
                disabled={events.isFetchingNextPage}
                onClick={() => void events.fetchNextPage()}
                size="sm"
                type="button"
                variant="outline"
              >
                {events.isFetchingNextPage ? t("Loading…") : t("Load more")}
              </Button>
            ) : null}
            <p className="text-muted-foreground text-xs">
              {events.hasNextPage
                ? t("{count} events so far", { count: rows.length })
                : t("{count} events, and that is all of them", {
                    count: rows.length,
                  })}
            </p>
          </div>
        ) : null}
      </PageSection>
    </PageShell>
  );
}

function Row({
  run,
  nameFor,
}: {
  run: AuditRun;
  nameFor: (botId: string) => string;
}) {
  const { event, count } = run;
  const at = new Date(event.createdAt).toLocaleTimeString(activeLocale);
  const from = new Date(run.firstAt).toLocaleTimeString(activeLocale);
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    approvedBy?: string;
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const refused =
    event.eventType === "computer.action_refused" ||
    event.eventType === "approval.denied" ||
    event.eventType === "component.refused" ||
    event.eventType === "component.function_refused" ||
    event.eventType === "mcp.call_rejected";
  // The three rows a question leaves behind carry their rule at the top level rather than under a
  // decision, because no decision was reached: the policy stopped and waited for a person.
  const approval = event.eventType.startsWith("approval.");
  const stalled = event.eventType === "agent.stream_stalled";
  /*
   * Allowed by policy but not carried out. A stalled turn belongs in the same family: the Bot was
   * asked and the answer never arrived. Colour is how this table is read, and a row left in the
   * muted foreground reads as "Allowed", which a turn nobody ever got an answer to was not.
   *
   * The three beyond the computer's own were each drawn as an ordinary allowed row: a tool call that
   * died at the vendor, a component function that could not be read, and a credential replacement
   * the vault refused. Every one of them is the same complaint — permitted, attempted, did not
   * happen — and the colour is what a person skimming this table actually reads.
   */
  const failed =
    event.eventType === "computer.action_failed" ||
    event.eventType === "mcp.call_failed" ||
    event.eventType === "component.function_failed" ||
    event.eventType === "credential.rotation_refused" ||
    stalled;
  const silence = stalled ? silenceOf(payload) : null;

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {at}
        {/*
         * The other end of a collapsed run, and ONLY when the run actually spans one. Without it a
         * reader counting boots cannot tell nine restarts in a minute from nine over a night; with
         * it unconditionally, every run written inside one second — which is most of them, since a
         * boot publishes its whole catalogue at once — printed the same clock time twice.
         */}
        {count > 1 && from !== at ? (
          <div className="text-xs">{t("from {time}", { time: from })}</div>
        ) : null}
      </td>
      <td className="px-4 py-2 font-medium">
        {/*
         * WHAT THE BOT DID, IN WORDS. This column printed `payload.action` with the tool namespace
         * sliced off, and the raw event type for every row that has no tool — so the trail opened on
         * `computer.isolation_loaded`, `model.usage`, `routine.ran`. Those are identifiers, and an
         * identifier on a Korean screen is the surface failing to own its own words.
         *
         * A name this build does not know stays an identifier, in a chip that says so. That is the
         * visible-and-fixable failure: a vendor's own MCP tool name lands here legitimately and has
         * no translation anywhere, and inventing one for it would be worse than showing it.
         */}
        <Words
          id={
            typeof payload.action === "string"
              ? payload.action
              : event.eventType
          }
          label={
            typeof payload.action === "string"
              ? TOOLS[payload.action]
              : EVENTS[event.eventType]
          }
        />
        {count > 1 ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
            {t("{count} times", { count })}
          </span>
        ) : null}
      </td>
      <td className="px-4 py-2">
        {/* Named targets and file paths are the audit subject before page elements. */}
        {NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span>
            <Id>{event.targetId}</Id>
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · <Id>{payload.function}</Id>
              </span>
            ) : null}
          </span>
        ) : typeof payload.fingerprint === "string" ? (
          // A repeat row has no element and no file of its own: what it is about is the call, which
          // the fingerprint names in full.
          <Id>{payload.fingerprint}</Id>
        ) : typeof payload.file === "string" ? (
          <Id>{payload.file}</Id>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          // A fact the server recorded about the element, not a sentence it wrote. See FACTS.
          <span className="text-muted-foreground">{fact(element)}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {/* Page host is meaningful only for browser actions, not workspace file actions. */}
        {typeof payload.file !== "string" &&
        typeof payload.page === "string" &&
        payload.page ? (
          <div className="text-xs text-muted-foreground">
            {hostOf(payload.page)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {typeof payload.bot === "string" ? (
          // Keep the immutable bot id available even when names collide.
          <span title={payload.bot}>{nameFor(payload.bot)}</span>
        ) : (
          "-"
        )}
      </td>
      <td className="px-4 py-2">
        <span
          className={
            refused
              ? "font-medium text-destructive"
              : failed
                ? "font-medium text-warning"
                : "text-muted-foreground"
          }
        >
          {/* The map is data; it is translated where it is drawn, English as the key. */}
          {t(
            DECISIONS[event.eventType] ??
              (refused
                ? UNLABELLED_OUTCOMES[0]
                : failed
                  ? UNLABELLED_OUTCOMES[1]
                  : UNLABELLED_OUTCOMES[2]),
          )}
        </span>
        {/* Refusal reasons mirror the conversation-facing reason. */}
        {(event.eventType === "component.refused" ||
          event.eventType === "component.function_refused" ||
          event.eventType === "mcp.call_rejected") &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {fact(payload.reason)}
          </div>
        ) : null}
        {event.eventType === "bot.declined" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
            <span className="italic">{t(", reported by the Bot itself")}</span>
          </div>
        ) : null}
        {/* Which of the three ways this access ended. See DISCONNECT_REASONS. */}
        {event.eventType === "mcp.account_disconnected" &&
        typeof payload.reason === "string" &&
        DISCONNECT_REASONS[payload.reason] ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t(DISCONNECT_REASONS[payload.reason] as string)}
          </div>
        ) : null}
        {(event.eventType === "computer.action_repeated" ||
          event.eventType === "mcp.call_repeated") &&
        typeof payload.count === "number" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("{count} times within a few minutes", {
              count: payload.count,
            })}
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {fact(payload.failure)}
          </div>
        ) : null}
        {/*
         * A note the server recorded as a fact, and ONLY when this surface has words for it.
         *
         * `note` was drawn nowhere, which is how `computer.isolation_loaded` — a row whose entire
         * content is its note — came to say "Isolation at start-up" and nothing else, while the
         * sentence stating that every Bot shares one browser sat in a payload only a database
         * client would ever see. Drawn unconditionally it would instead spill the English notes
         * still in the other rows onto this page, so the condition IS the boundary: a note that has
         * become a code has words here, and a note that is still prose stays where it was.
         */}
        {typeof payload.note === "string" && FACTS[payload.note] ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {fact(payload.note)}
          </div>
        ) : null}
        {approval && typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {fact(payload.reason)}
          </div>
        ) : null}
        {/*
         * The two numbers the stall row is worth reading for. Without them every stalled turn looks
         * the same, and the difference between an endpoint that dies halfway through an answer and
         * one that never begins is the difference between a slow Bot and a dead one.
         */}
        {silence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{silence}</div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
          </div>
        ) : null}
        {approval && typeof payload.rule === "string" && payload.rule ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {payload.rule}
          </div>
        ) : null}
        {/* Who stood behind an action, when the boundary asked and somebody said yes. */}
        {typeof decision.approvedBy === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("Allowed by {person}{josa}", {
              josa: josa(decision.approvedBy, "이/가"),
              person: decision.approvedBy,
            })}
          </div>
        ) : null}
        {decision.mode === "dry-run" && decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            {t("Dry run: recorded, not enforced")}
          </div>
        ) : null}
        {/*
         * Whose screen, and through which door. The rows that matter in this family are the ones
         * where `own` is false — a person looking at a browser signed into somebody else's
         * accounts — and a reader must not have to compare two ids to find them.
         */}
        {event.eventType === "computer.screen_viewed" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.own === true
              ? t("Their own Bot")
              : t("Somebody else's Bot, as {role}", {
                  role: t(payload.viewerRole === "admin" ? "admin" : "user"),
                })}
            {" · "}
            {payload.source === "demonstration"
              ? t("a recording, read back")
              : t("the live screen")}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Target types whose id is a name worth putting on screen.
 *
 * Anything else falls through to the element or file subject.
 */
const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

/**
 * What a row says when no label names its event type: refused, failed, or neither.
 *
 * Named and exported rather than written inline, because these three are the WHOLE risk of the
 * table below being incomplete — an unlabelled type lands on the third of them and reads as a
 * permission that was granted. `audit-labels.test.ts` asserts that only the three event types this
 * fallback was written about ever reach it.
 */
export const UNLABELLED_OUTCOMES = [
  "Blocked",
  "Did not happen",
  "Allowed",
] as const;

export const DECISIONS: Record<string, string> = {
  "bot.declined": "The Bot declined",
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": "The Bot stopped responding",
  "computer.policy_loaded": "Boundary at start-up",
  // Somebody edited the rules. The payload carries their reason, and says so when the switch that
  // decides whether a person sees an action at all was the thing that moved.
  "computer.policy_changed": "The boundary was changed",
  "computer.isolation_loaded": "Isolation at start-up",
  "computer.control_taken": "A person took the wheel",
  "computer.control_released": "The wheel was handed back",
  // Somebody looked at a Bot's browser — live, or a recording read back. Not a refusal and not a
  // permission: an access, said plainly. The row beneath says whose Bot and which door.
  "computer.screen_viewed": "The screen was looked at",
  "computer.help_requested": "The Bot asked for help",
  "computer.secret_requested": "The Bot asked for a secret",
  "computer.secret_supplied": "A person supplied a secret",
  "computer.reset": "The computer was reset",
  "computer.stopped": "A person pressed stop",
  // Not "Blocked". Nothing refused this; the Bot did the same thing again and the trail is saying so.
  "computer.action_repeated": "The Bot repeated itself",
  "approval.requested": "The boundary asked a person",
  "approval.granted": "A person allowed it",
  "approval.denied": "A person declined it",
  // Not "allowed it". These two edit the boundary, and every action the allowance covers afterwards
  // is allowed without anybody looking at it — a reader skimming for grants must not read one of
  // these as one more answered question.
  "approval.standing_granted": "A person stopped being asked about this",
  "approval.standing_revoked": "A person asked to be asked again",

  "component.granted": "Granted to this Bot",
  "component.revoked": "Taken away from this Bot",
  "component.published": "Published, so every Bot may use it",
  "component.unpublished": "Unpublished, so no Bot may use it",
  "component.draft_saved": "Draft saved, not yet published",
  "component.refused": "Refused",
  "component.function_granted": "May read this",
  "component.function_revoked": "May no longer read this",
  "component.function_called": "Read real data",
  "component.function_refused": "Refused",
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": "Could not be read",

  "mcp.call_succeeded": "Called on this Bot's behalf",
  "mcp.call_rejected": "Blocked",
  "mcp.call_failed": "The server did not answer",
  // `computer.action_repeated`'s twin, and not "Blocked" for the same reason: nothing refused this,
  // the Bot called the same tool again and the trail is saying so. Its own words rather than the
  // browser's, because a reader filtering this row wants the server and the tool, not a page.
  "mcp.call_repeated": "The Bot called the same tool again",
  // A tool whose definition moved after somebody consented to it, and the moment somebody looked at
  // what it now says. The first is a pause and not a refusal: nothing was blocked, the tool simply
  // stops running until the pair is closed.
  "mcp.tool_definition_changed": "Paused until somebody reviews it",
  "mcp.tool_definition_approved": "Approved as it now is",
  // The connector flow's three acts. Written as things PEOPLE did, because that is what they are:
  // the deployment introducing itself to a vendor, and somebody putting their own account behind it.
  "mcp.oauth_client_registered": "This deployment registered itself",
  "mcp.account_connected": "A person connected their own account",
  "mcp.account_disconnected": "An account is no longer connected",

  "coworker.asked": "One Bot asked another",
  "room.member_turn": "A Bot took its turn in a room",
  "routine.ran": "A routine ran",
  // A window let go, not a run that failed. "Skipped" and not "Missed": the deployment decided this,
  // and a row that reads as an accident hides the decision. `routine.skipped` is the name rows were
  // written under before the grace became a fraction of the period; they still read the same.
  "routine.skipped": "A routine's window was skipped",
  "routine.skipped_missed": "A routine's window was skipped",
  // The other half of the same decision: late, within grace, run once now.
  "routine.caught_up": "A routine ran late, within its grace",
  // A read, not a permission: the grant was checked and this is the Bot opening the body.
  "skill.viewed": "The Bot read a skill",
  "model.usage": "Model usage recorded",

  "configuration.changed": "Configuration changed",
  "credential.created": "Credential saved",
  "credential.rotated": "Credential replaced",
  // The vault declining a replacement: aimed at a credential already revoked, missing, or belonging
  // to another key. Nothing was blocked by a boundary, so it reads as a failure rather than a
  // refusal — but it is emphatically not the "Allowed" every unlabelled row used to fall back to.
  "credential.rotation_refused": "Could not be replaced",
  "credential.revoked": "Credential retired",

  // A person taking their data, and a person leaving. Neither is a permission and neither is a
  // refusal — they are the two ends of somebody's relationship with this deployment, and the
  // deletion row is written under a code rather than a name because by the time it commits there is
  // no name left to write.
  "account.exported": "A person took a copy of their data",
  "account.deleted": "An account was deleted",

  // Not a permission and not a refusal either: the machine this deployment runs on is created and
  // destroyed elsewhere, and these two say whether that elsewhere heard about it. The failure is
  // the one worth finding — an account that is gone here and still paid for there.
  "fleet.notified": "The fleet was told",
  "fleet.notify_failed": "The fleet could not be told",
  // Neither a permission nor a refusal: a person wrote to the operator. The payload says how far
  // it got; the words themselves are not in the trail.
  "support.feedback_sent": "A message was sent to the operator",
};

/**
 * Why an account stopped being connected, in the three ways it can happen.
 *
 * The server records which one and the reasons are genuinely different events — somebody changing
 * their mind, an offboarding, or an administrator taking the whole connector away. An auditor
 * asking "what happened to their access" is asking exactly this, so the row says it rather than
 * leaving the distinction in a payload nobody reads.
 */
export const DISCONNECT_REASONS: Record<string, string> = {
  person_disconnected: "They disconnected it themselves",
  person_removed: "They were removed from this deployment",
  mcp_server_removed: "The whole connector was removed",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One day, so the heading can name yesterday without a date library. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A day heading, in the reader's own language and calendar. */
function dateOf(at: string): string {
  return new Date(at).toLocaleDateString(activeLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

/**
 * A label if this build has one for it, and otherwise the identifier, dressed as an identifier.
 *
 * The chip is the point. An unlabelled value used to be indistinguishable from a labelled one —
 * `model.usage` sat in the same column, in the same weight, as a sentence somebody wrote — so
 * nothing on the screen said which of the two a reader was looking at, and the gap was invisible
 * from the page it was on.
 */
const Words = ({ id, label }: { id: string; label: string | undefined }) =>
  label ? <span>{t(label)}</span> : <Id>{id}</Id>;

/**
 * A name this deployment did not choose — a component's slug, a vendor's tool, a file path.
 *
 * One spelling of it, because the table has four columns that can hold one and they were three
 * different weights of monospace. In a chip it reads as a handle to copy rather than as something
 * to try to understand.
 */
const Id = ({ children }: { children: React.ReactNode }) => (
  <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono font-normal text-xs">
    {children}
  </code>
);

/**
 * A fact code the server recorded, as this surface says it.
 *
 * `laf:` is the marker no English sentence can carry by accident, so a value that has it is a fact
 * with a name and a value that does not is prose — from a vendor, from an exception, or from the
 * server's own refusal sentences, which are still English and still print here. Those are listed in
 * the report that came with this change; what is fixed here is that the CODES never reach a reader
 * as `laf:` and that anything new arriving with the prefix is caught by `audit-labels.test.ts`
 * before a person meets it.
 */
function fact(value: string): string {
  if (!value.startsWith("laf:")) return value;
  const label = FACTS[value];
  return label ? t(label) : value;
}

/**
 * What the trail records instead of a sentence, in the surface's own words.
 *
 * Keyed by `server/src/audit.ts`'s exported codes, which is what `audit-labels.test.ts` walks — a
 * code added there with nothing said about it here fails the run rather than reaching a screen.
 */
export const FACTS: Record<string, string> = {
  "laf:element_not_in_snapshot": "Not in the screen the server was holding",

  /*
   * The refusals, in the words a COLUMN wants — short, because this is scanned rather than read.
   *
   * Deliberately shorter than what the same code says to the model and to the person whose card did
   * not appear (`shared/prompt/tool-results.ko.ts`, and the app's own sentence beside the refused
   * card). One fact, three readers, three lengths: the model is told what to do next, the person is
   * told why the screen is empty, and this reader is scanning a hundred rows for the one that is
   * not like the others.
   *
   * Each of these names WHICH refusal it was, and none of them repeats the component, the function
   * or the tool — those are already in the Target column of the same row.
   */
  "laf:component_unknown": "No component of that name here",
  "laf:component_not_published": "Not published, so no Bot may use it",
  "laf:component_withheld": "Withheld from this Bot",
  "laf:function_unknown": "No data function of that name here",
  "laf:function_not_granted": "This component was not granted that function",
  "laf:tool_not_granted": "This Bot was not given that tool",
  "laf:skill_not_granted": "This Bot was not given that skill",

  // The three last resorts, where what failed left no message of its own. A row saying only "Did
  // not happen" with a blank beneath it reads as a surface that lost the reason.
  "laf:action_failed": "It failed, and said nothing about how",
  "laf:read_failed": "The read failed, and said nothing about how",
  "laf:tool_reported_error": "The tool said it failed and said no more",

  // The boot row's whole content. Not a refusal — the arrangement this deployment runs under.
  "laf:one_shared_computer":
    "Every Bot of this account drives the same browser: sessions, files and logins are shared",
};

/**
 * WHAT EACH TOOL DOES, IN THE WORDS THIS COLUMN WANTS.
 *
 * Short, because it is a column somebody scans rather than reads. Keyed by the catalogue's own tool
 * names (`shared/tools/computer.ts`), which `audit-labels.test.ts` imports and walks: a tool added
 * to the catalogue with no words here shows its identifier, and the run says so first.
 */
export const TOOLS: Record<string, string> = {
  computer_navigate: "Open a page",
  computer_read: "Read the page",
  computer_snapshot: "Look at the screen",
  computer_click: "Click",
  // Not "Type": the dictionary already spends that word on 유형, the noun.
  computer_type: "Type into a field",
  computer_key: "Press a key",
  computer_scroll: "Scroll",
  computer_switch_tab: "Switch tab",
  computer_upload_file: "Upload a file",
  computer_request_secret: "Ask for a secret",
  computer_request_help: "Ask for help",
  computer_list_files: "List files",
  computer_read_file: "Read a file",
  computer_write_file: "Write a file",
  // Not in the catalogue and never registered on a Bot, but the contract still names it and an old
  // row can carry it. Cheaper to say than to find out from a reader.
  computer_screenshot: "Take a screenshot",
};

/**
 * WHAT KIND OF THING EACH ROW IS, for the rows that are not a tool call.
 *
 * Deliberately the AREA and not the outcome. The outcome is the last column's job (`DECISIONS`),
 * and several types share a label here on purpose: `credential.created` and `credential.revoked`
 * are both "a credential", and what happened to it is the sentence beside them. Repeating the
 * sentence in two columns would make the table twice as wide and no more informative.
 *
 * Every type the server can write has an entry, and `audit-labels.test.ts` walks the server's own
 * list to say so. Several of these are almost never drawn — the computer's own action rows carry a
 * tool name and take the table above — and they are here anyway, because "almost never" is exactly
 * when a fallback gets noticed.
 */
export const EVENTS: Record<string, string> = {
  "configuration.changed": "Settings",
  "credential.created": "A credential",
  "credential.rotated": "A credential",
  "credential.rotation_refused": "A credential",
  "credential.revoked": "A credential",
  "agent.stream_stalled": "The Bot's answer",
  "bot.declined": "The Bot's answer",
  "mcp.call_succeeded": "A connector call",
  "mcp.call_rejected": "A connector call",
  "mcp.call_failed": "A connector call",
  "mcp.call_repeated": "A connector call",
  "mcp.oauth_client_registered": "A connector's application",
  "mcp.account_connected": "A connected account",
  "mcp.account_disconnected": "A connected account",
  "mcp.tool_definition_changed": "A tool's definition",
  "mcp.tool_definition_approved": "A tool's definition",
  "computer.action_allowed": "An action",
  "computer.action_refused": "An action",
  "computer.action_failed": "An action",
  "computer.action_repeated": "The same action again",
  // The same words as the tool above it. It is the same act seen from the trail rather than from
  // the Bot, and giving it a second sentence would be a second name for one thing.
  "computer.help_requested": "Ask for help",
  "computer.control_taken": "The wheel",
  "computer.control_released": "The wheel",
  "computer.screen_viewed": "The screen",
  "computer.secret_requested": "A secret",
  "computer.secret_supplied": "A secret",
  "approval.requested": "A question",
  "approval.granted": "A question",
  "approval.denied": "A question",
  "approval.standing_granted": "A standing allowance",
  "approval.standing_revoked": "A standing allowance",
  "computer.stopped": "The computer",
  "computer.reset": "The computer",
  "computer.policy_loaded": "The boundary",
  "computer.policy_changed": "The boundary",
  "computer.isolation_loaded": "Isolation",
  "model.usage": "Model usage",
  "coworker.asked": "One Bot asking another",
  "room.member_turn": "A room turn",
  "routine.ran": "A routine",
  "routine.skipped": "A routine",
  "routine.skipped_missed": "A routine",
  "routine.caught_up": "A routine",
  "skill.viewed": "A skill",
  "component.granted": "A component",
  "component.revoked": "A component",
  "component.published": "A component",
  "component.unpublished": "A component",
  "component.draft_saved": "A component",
  "component.refused": "A component",
  "component.function_granted": "A component's data",
  "component.function_revoked": "A component's data",
  "component.function_called": "A component's data",
  "component.function_refused": "A component's data",
  "component.function_failed": "A component's data",
  "account.exported": "An account",
  "account.deleted": "An account",
  "fleet.notified": "The fleet",
  "fleet.notify_failed": "The fleet",
  "support.feedback_sent": "A message to the operator",
};
