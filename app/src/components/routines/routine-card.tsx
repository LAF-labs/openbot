import { IconClock } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  editInChatHref,
  useConversationWith,
} from "@/components/routines/edit-in-chat";
import { savingFailure } from "@/components/routines/saving-failure";
import { useRoutineSwitch } from "@/components/routines/use-routine-switch";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  chatCard,
  chatCardMeta,
  chatCardPadding,
  chatCardTitle,
} from "@/components/ui/card-surface";
import { dayKeys } from "@/lib/agents/day";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  type Routine,
  routineKeys,
  routineListQueryOptions,
  routineRequest,
  scheduleLabel,
  whenLabel,
} from "@/lib/routines/queries";
import { useNow } from "@/lib/use-now";

/**
 * Which routine a line in the conversation is about.
 *
 * By id when this tab saw the call happen — the save's own answer carried it. After a reload only
 * the Bot's arguments are left, which name the routine the way the Bot did: its name, or for an
 * edit the id or current name it looked it up by. A name matches exactly and only when one of this
 * Bot's routines has it; two routines with one name are two candidates, and the line does not guess.
 */
export function routineFor(
  routines: readonly Routine[] | undefined,
  wanted: { routineId?: string | undefined; names: readonly string[] },
  agentId: string | undefined,
): Routine | undefined {
  const mine = (routines ?? []).filter(
    (routine) => agentId === undefined || routine.agentId === agentId,
  );
  if (wanted.routineId) {
    const byId = mine.find((routine) => routine.id === wanted.routineId);
    if (byId) return byId;
  }
  for (const name of wanted.names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const byId = mine.find((routine) => routine.id === trimmed);
    if (byId) return byId;
    const named = mine.filter((routine) => routine.name.trim() === trimmed);
    if (named.length === 1) return named[0];
  }
  return undefined;
}

/**
 * A ROUTINE THE BOT JUST MADE, AS A CARD IN THE CONVERSATION: what, when, when next, and the two
 * things a person does with it — turn it off, or say what to change.
 *
 * The conversation used to keep three lines — "루틴을 저장했습니다", the Bot's own correction of the
 * day, "루틴을 바꿨습니다" — and what had been saved, for when, was only in the Bot's prose (UI/UX
 * audit 0.5.3, item 8). The card reads the routine as it is NOW, from the same list the Routines
 * screen reads, so a card for a routine that was later corrected shows the correction, and one that
 * was switched off says so.
 *
 * `compact` is an edit's line: the name and the schedule it has now, no buttons — the card the
 * routine was made with is already above it.
 *
 * `fallback` is drawn when the routine is not in the list: deleted since, renamed past recognition,
 * or the list still loading. The line the tool always drew is what is left then, which is true.
 */
export function RoutineCard({
  routineId,
  names,
  agentId,
  compact = false,
  fallback,
}: {
  routineId?: string | undefined;
  /** The Bot's own words for which routine, for a line drawn after a reload. */
  names: readonly string[];
  agentId: string | undefined;
  compact?: boolean;
  fallback: ReactNode;
}) {
  const routines = useQuery(routineListQueryOptions());
  const routine = routineFor(routines.data, { routineId, names }, agentId);
  if (!routine) return <>{fallback}</>;
  return compact ? (
    <CompactLine routine={routine} />
  ) : (
    <FullCard routine={routine} />
  );
}

/** "다음 실행 9월 28일 오전 9:00", or that it is off — the promise the switch is making. */
function useNextLine(routine: Routine): string {
  // What 오늘 and 내일 are measured from; see `useNow` for why it is not read inside `whenLabel`.
  const now = useNow();
  return routine.enabled
    ? t("Next {when}", { when: whenLabel(routine.nextRunAt, now) })
    : t("Turned off");
}

/*
 * "지금은", because the line reads the routine as it is now and not as this edit left it. Measured
 * 2026-09-24: two edits in one conversation — to 화 8:30, then to 수 10:00 — and the first edit's
 * line said 수 10:00 beside the Bot's "화요일 8:30에 돕니다". Both were true; only one said when.
 */
function CompactLine({ routine }: { routine: Routine }) {
  return (
    <p className="flex items-start gap-1.5 py-0.5 text-muted-foreground text-sm">
      <IconClock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word">
        {t("Changed a routine · {name} · now {schedule}", {
          name: routine.name,
          schedule: scheduleLabel(routine),
        })}
      </span>
    </p>
  );
}

function FullCard({ routine }: { routine: Routine }) {
  const navigate = useNavigate();
  const toggle = useRoutineSwitch(routine);
  const conversation = useConversationWith(routine.agentId);
  const next = useNextLine(routine);
  const queryClient = useQueryClient();
  /*
   * 지금 한 번 해 보기, ON THE CARD IT WAS MADE WITH (ux-review-0.5.4, item 21). The owner had just
   * said "매일 아침 7시 30분에…" and had no way to see what it would say short of waiting until
   * seven-thirty or finding 지금 실행 on the Routines screen. The same door that button uses, so a
   * run from here is recorded exactly as one from there, and its answer lands in this conversation.
   */
  const tryNow = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}/run`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
      void queryClient.invalidateQueries({
        queryKey: routineKeys.runs(routine.id),
      });
      void queryClient.invalidateQueries({ queryKey: dayKeys.all });
    },
  });

  return (
    <section
      aria-label={t("Routine {name}", { name: routine.name })}
      className={cn(chatCard, chatCardPadding, "flex flex-col gap-2")}
    >
      <div className="flex items-start gap-2">
        {/* The Bot's colour: a routine is the Bot's own work, on a schedule. */}
        <IconClock
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-link"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Wrapped, never cut: at 375 the name is the part the person is checking. */}
          <p className={cn(chatCardTitle, "wrap-break-word")}>{routine.name}</p>
          <p className={chatCardMeta}>
            {scheduleLabel(routine)} · {next}
          </p>
          {routine.summary ? (
            <p className="mt-0.5 wrap-break-word text-sm">{routine.summary}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 ps-6">
        <Button
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!routine.enabled)}
          size="sm"
          variant="outline"
        >
          {routine.enabled ? t("Turn off") : t("Turn on")}
        </Button>
        {/*
         * 고치기 fills this conversation's composer rather than opening a form: the person made the
         * routine by saying it, and changes it the same way (`edit-in-chat.ts`). Absent only when
         * the Bot has no conversation to fill, which a card drawn inside one cannot be.
         */}
        {conversation ? (
          <Button
            onClick={() =>
              void navigate({
                href: editInChatHref(conversation, routine.name),
              })
            }
            size="sm"
            variant="outline"
          >
            {t("Change it")}
          </Button>
        ) : null}
        <Button
          disabled={tryNow.isPending}
          onClick={() => tryNow.mutate()}
          size="sm"
          variant="outline"
        >
          {t("Try it now")}
        </Button>
      </div>
      {/* Mounted with the card, so what it says is heard when it is said. */}
      <LiveRegion as="p" className="ps-6 text-muted-foreground text-xs">
        {tryNow.isPending
          ? t("Running now…")
          : tryNow.isSuccess
            ? t("Started. The answer lands below.")
            : null}
      </LiveRegion>
      {tryNow.isError ? (
        <p className="ps-6 text-destructive text-xs" role="alert">
          {savingFailure(tryNow.error)}
        </p>
      ) : null}
      {toggle.isError ? (
        <p className="ps-6 text-destructive text-xs" role="alert">
          {savingFailure(toggle.error)}
        </p>
      ) : null}
    </section>
  );
}
