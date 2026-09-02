import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { auditEventsQueryOptions } from "@/lib/audit/queries";
import { silenceOf } from "@/lib/audit/silence";
import { activeLocale, t } from "@/lib/i18n";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

/** One row as the API returns it. */
type AuditEvent = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

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
    search: "?eventType=computer.action_repeated",
  },
] as const;

function AuditPage() {
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
  const nameFor = useBotNames();

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
          onClick={() => events.refetch()}
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
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.label}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              /* The fill is the state, as on every other set of switches in the app. */
              variant={search === filter.search ? "default" : "outline"}
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
                  <th className="px-4 py-2 font-medium">{t("On")}</th>
                  <th className="px-4 py-2 font-medium">{t("Bot")}</th>
                  <th className="px-4 py-2 font-medium">{t("Decision")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <Row event={event} key={event.id} nameFor={nameFor} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function Row({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
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
   * The four beyond the computer's own were each drawn as an ordinary allowed row: a tool call that
   * died at the vendor, a component function that could not be read, a connector sync that failed,
   * and a credential replacement the vault refused. Every one of them is the same complaint —
   * permitted, attempted, did not happen — and the colour is what a person skimming this table
   * actually reads.
   */
  const failed =
    event.eventType === "computer.action_failed" ||
    event.eventType === "mcp.call_failed" ||
    event.eventType === "component.function_failed" ||
    event.eventType === "connector.sync_failed" ||
    event.eventType === "credential.rotation_refused" ||
    stalled;
  const silence = stalled ? silenceOf(payload) : null;

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {new Date(event.createdAt).toLocaleTimeString(activeLocale)}
      </td>
      <td className="px-4 py-2 font-medium">
        {/* Strip the internal computer tool namespace for display. */}
        {typeof payload.action === "string"
          ? payload.action.replace("computer_", "")
          : event.eventType}
      </td>
      <td className="px-4 py-2">
        {/* Named targets and file paths are the audit subject before page elements. */}
        {NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.fingerprint === "string" ? (
          // A repeat row has no element and no file of its own: what it is about is the call, which
          // the fingerprint names in full.
          <span className="font-mono text-xs">{payload.fingerprint}</span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          <span className="text-muted-foreground">{element}</span>
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
            {payload.reason}
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
        {event.eventType === "computer.action_repeated" &&
        typeof payload.count === "number" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("{count} times within a few minutes", {
              count: payload.count,
            })}
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.failure}
          </div>
        ) : null}
        {approval && typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
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
            {t("Allowed by {person}", { person: decision.approvedBy })}
          </div>
        ) : null}
        {decision.mode === "dry-run" && decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            {t("Dry run: recorded, not enforced")}
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
  "computer.isolation_loaded": "Isolation at start-up",
  "computer.control_taken": "A person took the wheel",
  "computer.control_released": "The wheel was handed back",
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

  "connector.sync_succeeded": "Sync finished",
  "connector.sync_failed": "Sync failed",
  "knowledge.searched": "Knowledge searched",
  "agent.invoked": "The Bot was asked",
  "coworker.asked": "One Bot asked another",
  "routine.ran": "A routine ran",
  // A window let go, not a run that failed. "Skipped" and not "Missed": the deployment decided this,
  // and a row that reads as an accident hides the decision.
  "routine.skipped": "A routine's window was skipped",
  "model.usage": "Model usage recorded",

  "configuration.changed": "Configuration changed",
  "credential.created": "Credential saved",
  "credential.rotated": "Credential replaced",
  // The vault declining a replacement: aimed at a credential already revoked, missing, or belonging
  // to another key. Nothing was blocked by a boundary, so it reads as a failure rather than a
  // refusal — but it is emphatically not the "Allowed" every unlabelled row used to fall back to.
  "credential.rotation_refused": "Could not be replaced",
  "credential.revoked": "Credential retired",
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
