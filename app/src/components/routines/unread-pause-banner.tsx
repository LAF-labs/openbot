import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { savingFailure } from "@/components/routines/saving-failure";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import {
  routineKeys,
  routineListQueryOptions,
  routineRequest,
} from "@/lib/routines/queries";
import {
  UNREAD_PAUSE_SENTENCES,
  type UnreadPauseGroup,
  unreadPausesByBot,
} from "@/lib/routines/unread";

/**
 * 결과를 안 보셔서 멈춘 루틴 — one banner per Bot, above the list.
 *
 * WHY A BANNER AND NOT ONLY THE ROW. The rule stops routines nobody pressed anything for, and a
 * switch sitting at off in a list reads as something the person did themselves and forgot. The
 * banner says who stopped them and why, once for the Bot the rule decided about, with the two
 * answers beside the sentence: 다시 켜기, and 계속 돌리기 for a routine whose results the person
 * reads somewhere else or simply wants kept going.
 *
 * ONE PRESS, ONE REQUEST, THE WHOLE BOT. The server turns back on every routine of that Bot the rule
 * paused, in one statement (`POST /api/routines/resume`) — and none the person switched off
 * themselves. The banner goes when the list comes back without the pause in it, which is the
 * server's word that it took rather than the button's guess.
 */
export const UnreadPauseBanners = () => {
  const routines = useQuery(routineListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const groups = unreadPausesByBot(routines.data ?? []);
  /*
   * WHAT A PRESS CAME TO, SAID WHERE IT OUTLIVES THE BANNER. A banner whose press worked is gone the
   * moment the list comes back without its pause, and a line inside it would go with it — so the
   * person who pressed 다시 켜기 heard nothing at all, only a banner that was no longer there. This
   * region is mounted with the list, before there is anything to say.
   */
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <LiveRegion className="sr-only">{said}</LiveRegion>
      {groups.length === 0 ? null : (
        <div className="mb-6 flex flex-col gap-3">
          {groups.map((group) => (
            <UnreadPauseBanner
              botName={
                agents.data?.find((agent) => agent.id === group.agentId)
                  ?.name ?? t("This Bot")
              }
              group={group}
              key={group.agentId}
              onAnswered={setSaid}
            />
          ))}
        </div>
      )}
    </>
  );
};

const UnreadPauseBanner = ({
  group,
  botName,
  onAnswered,
}: {
  group: UnreadPauseGroup;
  botName: string;
  /** The sentence for what the press did, for the region that outlives this banner. */
  onAnswered: (said: string) => void;
}) => {
  const queryClient = useQueryClient();
  const resume = useMutation({
    mutationFn: async (keepRunning: boolean) =>
      routineRequest("/api/routines/resume", {
        method: "POST",
        body: JSON.stringify({ agentId: group.agentId, keepRunning }),
      }),
    onSuccess: (_answer, keepRunning) => {
      onAnswered(
        keepRunning
          ? t("{name}'s routines will keep running, read or not.", {
              name: botName,
            })
          : t("Turned {name}'s routines back on.", { name: botName }),
      );
      return queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });

  return (
    <section
      aria-label={t(UNREAD_PAUSE_SENTENCES.title, {
        count: group.routines.length,
        name: botName,
      })}
      className="rounded-xl border border-warning/30 bg-warning/10 p-4"
    >
      <p className="font-medium text-sm">
        {t(UNREAD_PAUSE_SENTENCES.title, {
          count: group.routines.length,
          name: botName,
        })}
      </p>
      <p className="mt-1 text-muted-foreground text-sm">
        {t(UNREAD_PAUSE_SENTENCES.body)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={resume.isPending}
          onClick={() => resume.mutate(false)}
          size="sm"
        >
          {t(UNREAD_PAUSE_SENTENCES.turnBackOn)}
        </Button>
        <Button
          disabled={resume.isPending}
          onClick={() => resume.mutate(true)}
          size="sm"
          variant="outline"
        >
          {t(UNREAD_PAUSE_SENTENCES.keepRunning)}
        </Button>
      </div>
      <p className="mt-2 text-muted-foreground text-xs">
        {t(UNREAD_PAUSE_SENTENCES.keepRunningHint)}
      </p>
      {/* A refusal keeps the banner, so its line is the banner's, mounted with it. */}
      <LiveRegion as="p" className="mt-2 text-destructive text-xs" tone="alert">
        {resume.error ? savingFailure(resume.error) : null}
      </LiveRegion>
    </section>
  );
};
