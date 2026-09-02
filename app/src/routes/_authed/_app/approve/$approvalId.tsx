import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  closeQuestion,
  openQuestion,
  type PendingApproval,
  questionOn,
  readApprovals,
  watchQuestions,
} from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/approve/$approvalId")({
  component: ApprovePage,
});

/**
 * One waiting question, on a page of its own, because a notification has to land somewhere.
 *
 * Every other way this product asks for permission is a line in a transcript, and that is right —
 * the comment at the top of `ApprovalRequest` explains why a boundary should not interrupt the
 * whole screen. But a notice fired while the window was behind three other apps is not in a
 * transcript, and until this page existed clicking one did nothing at all: `use-bot-notifications`
 * passed an empty function, and a person told "a Bot needs you" had to go and find which line of
 * which room it was about. This is the address that notice points at, and the address
 * `lafagent://approve/<id>` resolves to when the shell hands a link over.
 *
 * IT DOES NOT DRAW A CARD OF ITS OWN. The card is `ApprovalRequest`, imported, unmodified — a
 * second implementation of the buttons that record somebody's consent is the last thing this
 * product should have, because the two would disagree about what "always allow" covers on the day
 * one of them is changed. The card reads the question out of the module every waiting tool call
 * registers with, so this page's whole job is to put the question there under an id of its own and
 * take it away again.
 */

/** The tool call this page stands in for. There is none; the card needs a key, and this is it. */
const toolCallKey = (approvalId: string) => `approve-page:${approvalId}`;

/**
 * The question with this id, whichever Bot raised it, or null when nothing is waiting on it.
 *
 * Asked per Bot because that is the shape the server offers — `/api/approvals/:botId` — and the
 * page arrives holding an approval id and nothing else. At five Bots to an account that is five
 * small requests once, which is cheaper than the round trip it would take to add an endpoint.
 *
 * Hidden Bots are included. A hidden Bot never raises a notice (`decideNotice` stops it), but a
 * link can still name one of its questions, and a page that answered "nothing is waiting" about
 * something that is would be worse than no page.
 */
function approvalQueryOptions(approvalId: string) {
  return {
    queryKey: ["approvals", "one", approvalId] as const,
    queryFn: async (): Promise<PendingApproval | null> => {
      const rosters = await Promise.all([
        fetch("/api/agents", { credentials: "include" }),
        fetch("/api/agents?hidden=true", { credentials: "include" }),
      ]);
      const botIds = new Set<string>();
      for (const response of rosters) {
        if (!response.ok) throw new Error("Could not load coworkers");
        const body = (await response.json()) as { agents: { id: string }[] };
        for (const agent of body.agents) botIds.add(agent.id);
      }
      const lists = await Promise.all([...botIds].map(readApprovals));
      for (const list of lists) {
        const found = list?.find((one) => one.id === approvalId);
        if (found) return found;
      }
      return null;
    },
    /*
     * Asked once. A question that is answered on this page is taken down by the card itself, and a
     * question answered somewhere else while somebody stares at this page is the rarest case there
     * is — polling it would be a request a second, forever, on a screen that exists to be closed.
     */
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  };
}

function ApprovePage() {
  const { approvalId } = Route.useParams();
  const navigate = useNavigate();
  const key = toolCallKey(approvalId);
  const approval = useQuery(approvalQueryOptions(approvalId));
  const channels = useQuery(channelListQueryOptions());
  const agents = useQuery(agentListQueryOptions());

  const waiting = approval.data;
  /** Whether this question is still open, as the card itself sees it. */
  const isOpen = useSyncExternalStore(
    watchQuestions,
    () => questionOn(key) !== undefined,
  );
  /*
   * The card's only signal is that it closes the question — it answers, then takes itself down. So
   * "was open, is not" is how this page learns somebody pressed a button, without the card having
   * to grow a callback for one caller.
   */
  const wasOpen = useRef(false);
  if (isOpen) wasOpen.current = true;
  const isSettled = wasOpen.current && !isOpen;

  /** The Bot's own room, which is where somebody who has answered should be. */
  const botId = waiting?.botId;
  const channelId = (channels.data ?? []).find((channel) =>
    channel.agentIds.includes(botId ?? ""),
  )?.id;
  const botName = (agents.data ?? []).find((agent) => agent.id === botId)?.name;

  useEffect(() => {
    // A question already decided is not a question. The server keeps its record for the rest of the
    // ten minutes, so this is the ordinary case for a notice somebody comes back to late.
    if (!waiting || waiting.granted !== undefined || isSettled) return;
    openQuestion(key, {
      approvalId: waiting.id,
      botId: waiting.botId,
      subject: waiting.subject,
      rule: waiting.rule,
      scope: waiting.scope,
      expiresAt: waiting.expiresAt,
    });
    return () => closeQuestion(key);
  }, [key, waiting, isSettled]);

  useEffect(() => {
    if (!isSettled) return;
    /*
     * Answered, so this page has nothing left to show. The room rather than Home: the Bot is about
     * to act on what it was just allowed to do, and the transcript is where that becomes visible.
     * `replace`, so Back does not walk somebody into a question they have already answered.
     */
    if (channelId) {
      void navigate({
        params: { channelId },
        replace: true,
        to: "/channel/$channelId",
      });
      return;
    }
    void navigate({ replace: true, to: "/" });
  }, [channelId, isSettled, navigate]);

  const heading = botName
    ? t("{name} needs you", { name: botName })
    : t("A Bot is waiting for you");

  if (approval.isPending) {
    return (
      <PageShell title={heading}>
        <Skeleton className="mt-6 h-28 w-full" />
      </PageShell>
    );
  }

  if (approval.isError) {
    return (
      <PageShell
        description={t(
          "The request could not be loaded. It may just be the connection.",
        )}
        title={heading}
      >
        <Button
          className="mt-6 self-start"
          onClick={() => void approval.refetch()}
          variant="outline"
        >
          {t("Try again")}
        </Button>
      </PageShell>
    );
  }

  /*
   * Nothing waiting, and it is worth saying why rather than bouncing somebody straight out. A
   * question expires ten minutes after it is asked, and a person who answered it on their other
   * machine — or came back to the notice after lunch — arrives here to an empty page and deserves
   * to be told that nothing went wrong.
   */
  if (!waiting || waiting.granted !== undefined) {
    return (
      <PageShell
        description={t(
          "It was already answered, or it waited ten minutes and expired. Nothing is held up.",
        )}
        title={t("Nothing is waiting for an answer")}
      >
        <Button className="mt-6 self-start" render={<Link to="/" />}>
          {t("Go to your Bots")}
        </Button>
      </PageShell>
    );
  }

  return (
    <PageShell
      description={t(
        "Your Bot stopped here and is waiting. It carries on the moment you answer.",
      )}
      title={heading}
    >
      <div className="mt-6">
        <ApprovalRequest toolCallId={key} />
      </div>
      {channelId ? (
        <Button
          className="mt-4 self-start"
          render={<Link params={{ channelId }} to="/channel/$channelId" />}
          variant="ghost"
        >
          {t("Open the conversation")}
        </Button>
      ) : null}
    </PageShell>
  );
}
