import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { ReadNotice } from "@/components/layout/read-states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentAllowance,
  agentAllowancesQueryOptions,
  agentKeys,
} from "@/lib/agents/queries";
import { describeSubject } from "@/lib/approvals";
import { ensure } from "@/lib/ensure";
import { activeLocale, t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";

/**
 * WHAT THE OWNER HAS ALLOWED WITHOUT ASKING, AND THE WAY BACK.
 *
 * "항상 허용" on a card promised "관리 화면에서 취소할 때까지", and the only place it could be taken
 * back was the administrator's rules page — CEL and playground links, which an owner who is not an
 * administrator cannot even open (ux-review-0.5.4 §1.7). A standing permission its owner cannot
 * find is a boundary that lies by omission. It is listed here, on the Bot it applies to, read from
 * the rows the boundary itself consults, and each one can be taken back.
 *
 * Drawn when empty too. The card links here, and "아직 없어요" is the answer to the question somebody
 * followed that link to ask.
 */
export function AllowancesCard({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const allowances = useQuery(agentAllowancesQueryOptions(agentId));
  const [revoking, setRevoking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reading = useReading(allowances, {
    isEmpty: (answer) => answer.allowances.length === 0,
    unavailable: { "laf:agent_not_found": "not_allowed" },
  });
  const settled = settledOf(reading);
  const inForce = settled?.data.inForce ?? true;

  const handleRevoke = (id: string) => {
    setRevoking(id);
    setProblem(null);
    // `try`…`finally`, through `ensure`: the React Compiler cannot compile the statement itself.
    return ensure(
      async () => {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(agentId)}/allowances/${encodeURIComponent(id)}`,
          { credentials: "include", method: "DELETE" },
        ).catch(() => null);
        // 409 is "already taken back", most likely in another window: the list is simply stale.
        if (!response || (!response.ok && response.status !== 409)) {
          setProblem(t("That did not go through. Try again."));
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: agentKeys.allowances(agentId),
        });
      },
      () => setRevoking(null),
    );
  };

  return (
    <section
      className="flex scroll-mt-4 flex-col gap-2 rounded-xl bg-muted p-3"
      // The approval card's "항상 허용" note links here.
      id="allowances"
    >
      {reading.state === "loading" ? (
        <>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
        </>
      ) : (
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium text-base">
            {t("What you have allowed")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {inForce
              ? t(
                  "When you pressed “Always allow”, the Bot stopped asking about these. Take one back and it asks again.",
                )
              : // Said in the card's own sentence, not a footnote: a list under "it no longer asks"
                // that is in fact being asked about is the lie this card exists to stop telling.
                t(
                  "Paused for now: the Bot asks about all of these again. They are kept for when that changes.",
                )}
          </p>
        </div>
      )}
      {settled?.state === "ready" ? (
        <ul className="flex flex-col gap-1">
          {settled.data.allowances.map((allowance) => (
            <li
              className="flex items-start gap-2 rounded-lg bg-background px-3 py-2"
              key={allowance.id}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="wrap-break-word text-sm">
                  {scopeText(allowance)}
                </span>
                {allowance.subject ? (
                  <span className="wrap-break-word text-muted-foreground text-xs">
                    {t("When you allowed it: {what}", {
                      what: describeSubject(allowance.subject),
                    })}
                  </span>
                ) : null}
                <span className="text-muted-foreground text-xs">
                  {tierText(allowance)}
                </span>
              </span>
              <Button
                className="shrink-0"
                disabled={revoking === allowance.id}
                onClick={() => void handleRevoke(allowance.id)}
                size="sm"
                variant="ghost"
              >
                {t("Ask me again")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {settled?.state === "empty" ? (
        <p className="rounded-lg bg-background px-3 py-2 text-muted-foreground text-sm">
          {t("Nothing yet. The Bot asks you before anything that needs it.")}
        </p>
      ) : null}
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {problem}
      </LiveRegion>
      <ReadNotice
        className="py-0"
        line={readLineOf(reading, {
          failed: t("What you allowed could not be loaded."),
          notHere: t("Nothing is allowed without asking here."),
        })}
        onRetry={() => void allowances.refetch()}
        size="compact"
      />
    </section>
  );
}

/** What it covers, in the words the button that granted it used. */
function scopeText(allowance: AgentAllowance): string {
  if (allowance.scopeKind === "host") {
    return t("Anything on {site}", { site: allowance.scopeValue });
  }
  if (allowance.scopeKind === "file") {
    return t("The file {path}", { path: allowance.scopeValue });
  }
  return t("The tool {tool}", { tool: allowance.scopeValue });
}

/** For good, or for one conversation until it runs out. */
function tierText(allowance: AgentAllowance): string {
  const granted = new Date(allowance.grantedAt).toLocaleDateString(
    activeLocale,
    { dateStyle: "medium" },
  );
  if (allowance.tier === "thread" && allowance.expiresAt) {
    return t("Only in one conversation, until {when}", {
      when: new Date(allowance.expiresAt).toLocaleString(activeLocale, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    });
  }
  return t("Allowed on {date}, until you take it back", { date: granted });
}
