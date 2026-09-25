import {
  IconChevronDown,
  IconClockPlay,
  IconDots,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { DetailPanel } from "@/components/layout/detail-panel";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import {
  editInChatHref,
  useConversationWith,
} from "@/components/routines/edit-in-chat";
import { RoutineNotepad } from "@/components/routines/notepad";
import { RoutineForm } from "@/components/routines/routine-form";
import { savingFailure } from "@/components/routines/saving-failure";
import { RoutineSuggestions } from "@/components/routines/suggestions";
import { UnreadPauseBanners } from "@/components/routines/unread-pause-banner";
import { useRoutineSwitch } from "@/components/routines/use-routine-switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { dayKeys } from "@/lib/agents/day";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { activeLocale, t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { routineDeleteRecheck } from "@/lib/rechecks";
import { routineListView, runOutcome } from "@/lib/routines/list-state";
import {
  type Routine,
  type RoutineRun,
  routineKeys,
  routineListQueryOptions,
  routineRequest,
  runShape,
  scheduleLabel,
  whenLabel,
} from "@/lib/routines/queries";
import { pausedForUnread, UNREAD_PAUSE_SENTENCES } from "@/lib/routines/unread";
import { useNow } from "@/lib/use-now";

/**
 * Routines: something the Bot does on its own, at a time.
 *
 * A routine's row leads with its name and when it goes, then the line its Bot wrote for the person
 * about what it does. The instruction the Bot runs is kept, folded under 자세히 with the runs: it is
 * written to the Bot's future self, and as the row's body it read like a system prompt (UI/UX audit
 * 0.5.3, item 8). Changing one starts a sentence in the Bot's conversation; the form is still there.
 */

function RunHistory({ routineId }: { routineId: string }) {
  const runs = useQuery({
    queryKey: routineKeys.runs(routineId),
    queryFn: async () =>
      (await routineRequest(`/api/routines/${routineId}/runs`))
        ?.runs as RoutineRun[],
  });
  const reading = useReading(runs);
  const settled = settledOf(reading);

  /*
   * ONE PLACE FOR ITS LINE, FIRST, IN EVERY STATE: the notice is mounted before it speaks. And A
   * FAILED REFRESH KEEPS THE HISTORY — 지금 실행 refetches this list the moment its run is accepted,
   * and the error used to be checked before the data, so one failed read replaced every run the
   * routine had made with "could not be loaded" until somebody pressed again.
   */
  return (
    <>
      <ReadNotice
        className="py-2"
        line={readLineOf(reading, {
          failed: t("The run history could not be loaded."),
          notHere: t("Routines are not offered here."),
        })}
        onRetry={() => void runs.refetch()}
        size="compact"
      />
      {/* "Never run" is a claim about the past. It must not be made while the past is arriving. */}
      {reading.state === "loading" ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t("Loading runs…")}
        </p>
      ) : null}
      {settled?.state === "empty" ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t("This routine has not run yet.")}
        </p>
      ) : null}
      {settled?.state === "ready" ? (
        <ul className="flex flex-col gap-2 py-2">
          {settled.data.map((run) => {
            /*
             * A run somebody stopped with 모두 멈추기 is not a failure, and red would say it was.
             * Its receipt carries the fact code rather than a sentence; the words are `runOutcome`'s.
             */
            const outcome = runOutcome(run);
            const shape = runShape(run.steps, t);
            return (
              <li
                key={run.id}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {new Date(run.startedAt).toLocaleString(activeLocale)}
                  </span>
                  <span
                    className={
                      outcome.tone === "failed" ? "text-destructive" : ""
                    }
                  >
                    {outcome.label}
                    {shape ? ` · ${shape}` : ""}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                  {outcome.text}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

function RoutineRow({
  routine,
  showBot,
}: {
  routine: Routine;
  /**
   * Whether to say which Bot it is. Only for an account from before 2026-09-24 that still has
   * several: with one Bot, "연남이 · 월 오전 9:00" on every row names the only Bot there is, and at
   * 375 it was the part that pushed the schedule off the card (UI/UX audit 0.5.3, items 8 and 9).
   */
  showBot: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const goTo = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const [showRuns, setShowRuns] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // What 오늘 and 내일 are measured from; see `useNow` for why it is not read inside `whenLabel`.
  const now = useNow();
  const conversation = useConversationWith(routine.agentId);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: routineKeys.all });

  const toggle = useRoutineSwitch(routine);
  const runNow = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}/run`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: routineKeys.runs(routine.id),
      });
      // The run's settlement is what writes the notepad, so the one on screen is now stale too.
      void queryClient.invalidateQueries({
        queryKey: routineKeys.notepad(routine.id),
      });
      // And 오늘: a run that found nothing new says so nowhere else (`lib/agents/day.ts`).
      void queryClient.invalidateQueries({ queryKey: dayKeys.all });
    },
  });
  /*
   * 계속 돌리기 on this one routine: never paused for going unread. Its own door, never the edit's —
   * a Bot's `manage_routine` reaches the edit, and this is the person's call.
   */
  const keepRunning = useMutation({
    mutationFn: async (keep: boolean) =>
      routineRequest(`/api/routines/${routine.id}/keep-running`, {
        method: "POST",
        body: JSON.stringify({ keepRunning: keep }),
      }),
    onSettled: invalidate,
  });
  // The dialog closes itself once this resolves; the list it was pressed from refreshes first.
  const remove = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const bot = showBot
    ? agents.data?.find((agent) => agent.id === routine.agentId)
    : undefined;
  const openForm = () => void navigate({ search: { edit: routine.id } });

  return (
    <div
      className="scroll-mt-4 rounded-xl border border-border bg-card transition-shadow duration-700 data-[jumped=true]:ring-2 data-[jumped=true]:ring-primary/40"
      // 오늘 and the drawer link here by this (`app-sidebar/bot-day.tsx`, `revealWhenDrawn`).
      id={`routine-${routine.id}`}
    >
      <div className="flex items-start gap-3 p-4">
        {/*
         * The routine's Bot, and the Bot's id when the roster has not answered yet — a face from
         * the id is stable and merely not the right one, which beats a hole in the row. Only where
         * there is more than one Bot to tell apart, and not on a phone, where it took a fifth of
         * the width from the name.
         */}
        {showBot ? (
          <BotAvatar
            className="hidden shrink-0 sm:block"
            seed={bot?.avatarSeed ?? routine.agentId}
            size={36}
          />
        ) : null}
        <button
          aria-expanded={showRuns}
          // The house ring. It had none at all, so tabbing across a list of routines went dark.
          className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left ${focusRing}`}
          onClick={() => setShowRuns((open) => !open)}
          type="button"
        >
          {/*
           * TWO LINES, WRAPPED, NEVER CUT. At 375 the name read "주…", the Bot "연남이…" and the next
           * run "9월 2…" — every fact on the card truncated to its first syllable. What it is called,
           * then when it goes; a long name takes a second line rather than the schedule's place.
           */}
          <span className="wrap-break-word font-medium text-sm">
            {routine.name}
          </span>
          <span className="text-muted-foreground text-xs">
            {bot?.name ? `${bot.name} · ` : ""}
            {scheduleLabel(routine)}
          </span>
          {/*
           * WHAT IT DOES, IN THE PERSON'S WORDS — the line its Bot wrote for them. The instruction
           * is the Bot's note to its future self ("매주 월요일 아침이다. 사용자에게 …"), and it was
           * the row's body; it is under 자세히 now, beside the runs it produced.
           */}
          {routine.summary ? (
            <span className="mt-0.5 wrap-break-word text-sm">
              {routine.summary}
            </span>
          ) : null}
          {/*
           * WHY IT IS OFF, when nobody here turned it off. A switch at off reads as something the
           * person did and forgot; this line says the rule did it, and the banner above has the
           * answers (`UnreadPauseBanners`).
           */}
          {pausedForUnread(routine) ? (
            <span className="text-warning text-xs">
              {t(UNREAD_PAUSE_SENTENCES.row)}
            </span>
          ) : null}
          {/*
           * WHEN IT LAST WENT AND WHEN IT GOES NEXT.
           *
           * The server has sent `nextRunAt` and `lastRunAt` on every row since routines existed and
           * the screen threw both away, so the one question anybody has about a schedule — is it
           * actually running — could only be answered by opening the run history. 다음 실행 is the
           * promise the switch is making; 마지막 실행 is the evidence it kept it.
           */}
          <span className="text-muted-foreground/80 text-xs">
            {t("Next {when}", { when: whenLabel(routine.nextRunAt, now) })}
            {routine.lastRunAt
              ? ` · ${t("Last {when}", { when: whenLabel(routine.lastRunAt, now) })}`
              : ` · ${t("Not run yet")}`}
          </span>
          {/* Said, because a row that opens on a press looked like a row with nothing more in it. */}
          <span className="mt-0.5 inline-flex items-center gap-0.5 text-muted-foreground text-xs">
            {showRuns ? t("Less") : t("Details")}
            <IconChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform ${showRuns ? "rotate-180" : ""}`}
            />
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {/*
           * THREE UNLABELLED ICONS, ONE OF THEM PERMANENT, ALL THE SAME SIZE AND COLOUR.
           *
           * 지금 실행 and 삭제 were two grey glyphs either side of a switch, and the destructive one
           * was the easier of the two to hit by accident. 삭제 moves into the ⋯ menu — the same
           * place a Bot's does — and the two that are left say what they are, in a tooltip for the
           * mouse and in `aria-label` for everybody else.
           */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={
                    runNow.isPending
                      ? t("Running {name}…", { name: routine.name })
                      : t("Run {name} now", { name: routine.name })
                  }
                  disabled={runNow.isPending}
                  // Opened here rather than in onSuccess: the panel the answer lands in should
                  // already be open while the Bot is working, or the click looks like it did
                  // nothing for a minute.
                  onClick={() => {
                    setShowRuns(true);
                    runNow.mutate();
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <IconClockPlay />
                </Button>
              }
            />
            <TooltipContent>{t("Run now")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Switch
                  /*
                   * NAMED FOR THE ROUTINE, NOT FOR ITS STATE. It read "'재고 확인' 켜짐" whether it
                   * was on or off — a label that lies in one of the two states it has.
                   * `role="switch"` already carries `aria-checked`; the name only has to say which
                   * switch this is.
                   */
                  aria-label={t("Scheduled runs for {name}", {
                    name: routine.name,
                  })}
                  checked={routine.enabled}
                  onCheckedChange={(enabled) => toggle.mutate(enabled === true)}
                />
              }
            />
            <TooltipContent>
              {routine.enabled ? t("On schedule") : t("Paused")}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={t("Actions for {name}", { name: routine.name })}
                  size="icon-sm"
                  variant="ghost"
                >
                  <IconDots />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-auto">
              {/*
               * 고치기 FIRST, AND IT IS A SENTENCE, NOT A FORM. The person says what to change in
               * the Bot's conversation, the way the routine was made; the composer opens holding
               * "‘주간 매출 요약’을 이렇게 바꿔 줘: " (`edit-in-chat.ts`). A Bot that has never
               * been spoken to has no conversation to open, and then 고치기 is the form.
               *
               * 직접 고치기 is the form, kept for somebody who would rather set the hour themselves.
               * Both above 삭제, the only irreversible thing on the page.
               */}
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={() =>
                  conversation
                    ? void goTo({
                        href: editInChatHref(conversation, routine.name),
                      })
                    : openForm()
                }
              >
                {t("Change it")}
              </DropdownMenuItem>
              {conversation ? (
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={openForm}
                >
                  {t("Change it yourself")}
                </DropdownMenuItem>
              ) : null}
              {/*
               * 안 읽어도 계속 돌리기: the exemption from the unread rule, for one routine, as a check
               * the person can see the state of. The banner's 계속 돌리기 sets the same thing for
               * all of a Bot's paused routines at once.
               */}
              <DropdownMenuCheckboxItem
                checked={routine.keepRunning === true}
                // One line: measured wrapping to "안 읽어도 계속 / 돌리기" in the menu's default width.
                className="whitespace-nowrap"
                disabled={keepRunning.isPending}
                onCheckedChange={(checked) =>
                  keepRunning.mutate(checked === true)
                }
              >
                {t(UNREAD_PAUSE_SENTENCES.menu)}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmingDelete(true)}
                variant="destructive"
              >
                {t("Delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/*
       * 지금 실행 SAID NOTHING. It opened the history panel and the row sat there — the request can
       * take a minute, and for that minute the press looked like it had missed.
       *
       * Mounted with the row, so what it says is heard (`LiveRegion`): drawn only once pressed, the
       * line arrived with its region and 실행 중… was never read out.
       */}
      <LiveRegion as="p" className="px-4 pb-3 text-muted-foreground text-xs">
        {runNow.isPending
          ? t("Running now…")
          : runNow.isSuccess
            ? t("Started. The answer lands below.")
            : null}
      </LiveRegion>
      <LiveRegion
        as="p"
        className="px-4 pb-3 text-destructive text-xs"
        tone="alert"
      >
        {runNow.isError
          ? savingFailure(runNow.error)
          : toggle.isError
            ? savingFailure(toggle.error)
            : keepRunning.isError
              ? savingFailure(keepRunning.error)
              : null}
      </LiveRegion>
      {/*
       * A routine and every run it ever made, gone on one click of a small grey icon next to a
       * switch. It is the only irreversible thing on this page and it asked nothing.
       */}
      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "The schedule stops and its run history goes with it. This cannot be undone.",
        )}
        onConfirm={() => remove.mutateAsync()}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        onStale={invalidate}
        open={confirmingDelete}
        recheck={() => routineDeleteRecheck(routine.id)}
        title={t("Delete {name}{josa}?", {
          josa: josa(routine.name, "을/를"),
          name: routine.name,
        })}
      />
      {showRuns ? (
        <div className="border-border border-t px-4">
          {/*
           * WHAT THE BOT IS TOLD, FIRST IN 자세히. The words that actually run — kept, because the
           * summary is a description of them and somebody checking why a run went the way it did
           * needs the real thing; folded, because they are written to the Bot, not to the person.
           */}
          <div className="py-3">
            <p className="text-muted-foreground text-xs">
              {t("What the Bot is told each time")}
            </p>
            <p className="mt-1 wrap-break-word whitespace-pre-wrap text-sm leading-relaxed">
              {routine.instruction}
            </p>
          </div>
          {/* Where it left off before what it said: the notepad is what the next run starts from. */}
          <RoutineNotepad routineId={routine.id} />
          <RunHistory routineId={routine.id} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 수정, in the same panel 새 루틴 opens in, on the routine the address names.
 *
 * Read out of the list the page already holds rather than fetched on its own: the row that was
 * pressed is in it, and one cache entry means the form and the row cannot show the same routine two
 * ways. Keyed by the routine so a second 수정 on another row starts from that routine, not from
 * whatever the first one had in its fields.
 */
const EditRoutine = ({ id, onDone }: { id: string; onDone: () => void }) => {
  const routines = useQuery(routineListQueryOptions());
  const reading = useReading(routines);
  const settled = settledOf(reading);
  const routine = settled?.data.find((candidate) => candidate.id === id);
  if (routine) {
    return <RoutineForm key={routine.id} onDone={onDone} routine={routine} />;
  }
  /*
   * "NO LONGER THERE" IS A CLAIM, and a list that could not be read cannot make it: the panel said
   * the routine had been deleted whenever the one read behind it failed. Not even out of the list
   * from before — a refresh that failed is a failure here, since the answer this panel needs is the
   * one that did not come.
   *
   * Every state that is not the form shares this one panel, so its lines are mounted before they
   * speak (`LiveRegion`): opened on a routine, the panel loads, and then says what it found.
   */
  const isGone = settled !== null && reading.state !== "failed";
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start gap-3 p-8">
      <ReadNotice
        line={
          reading.state === "failed"
            ? {
                kind: "failed",
                message: t("Your routines could not be loaded."),
                isRetrying: reading.isRetrying,
              }
            : readLineOf(reading, {
                failed: t("Your routines could not be loaded."),
                notHere: t("Routines are not offered here."),
              })
        }
        onRetry={() => void routines.refetch()}
      />
      {/* Deleted in another window, or by its Bot, while the address still named it. */}
      <LiveRegion as="p" className="text-muted-foreground text-sm">
        {isGone ? t("That routine is no longer there.") : null}
      </LiveRegion>
      {reading.state === "loading" ? (
        <div className="flex w-full flex-col gap-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <Button onClick={onDone} size="sm" variant="outline">
          {t("Close")}
        </Button>
      )}
    </div>
  );
};

/**
 * Whether the window is wide enough for the 400px form beside, or over, the list: the rail and
 * 400px with a little of the list left showing. Watched rather than read once, so turning a
 * tablet or widening the app's window changes it.
 */
const ROOM_FOR_THE_WIDE_FORM = "(min-width: 640px)";

function hasRoom(): boolean {
  return (
    typeof window.matchMedia !== "function" ||
    window.matchMedia(ROOM_FOR_THE_WIDE_FORM).matches
  );
}

function watchRoom(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(ROOM_FOR_THE_WIDE_FORM);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function RoutinesPage() {
  const queryClient = useQueryClient();
  const { new: isCreating, edit: editingId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const routines = useQuery(routineListQueryOptions());
  const creating = isCreating === true;
  const editing = typeof editingId === "string" && editingId.length > 0;
  const routinesReading = useReading(routines);
  const list = routineListView(routinesReading, { isCreating: creating });
  const agents = useQuery(agentListQueryOptions());
  // One Bot is the product (2026-09-24); only an older account with several is told which is which.
  const showBot = (agents.data?.length ?? 0) > 1;
  const isRoomy = useSyncExternalStore(watchRoom, hasRoom, () => true);
  const handleDone = () => {
    void navigate({ search: {} });
    void queryClient.invalidateQueries({ queryKey: routineKeys.all });
  };

  return (
    <DetailPanel
      detail={
        creating ? (
          <RoutineForm onDone={handleDone} />
        ) : editing ? (
          <EditRoutine id={editingId} onDone={handleDone} />
        ) : null
      }
      // 400px like a Bot's profile, not 320: this is a form with a select, two more selects and
      // seven day chips on one line, and at 320 the chips wrapped to three rows. But only where
      // 400 fits: laid over a phone's 319px column, the form ran under the rail and lost its left
      // edge — "새 루틴" read "‥틴" (measured at 375, 2026-09-24).
      detailWidth={isRoomy ? 400 : 320}
      onClose={() => navigate({ search: {} })}
      open={creating || editing}
    >
      <PageShell
        title={t("Routines")}
        // Examples from a shop's week, not "다이제스트": that word was the one on this page nobody
        // who runs a shop would use (UI/UX audit 0.5.3, item 8).
        description={t(
          "Things your Bot does on its own at set times — a weekly sales summary, a daily look at new reviews.",
        )}
        action={
          <Button
            nativeButton={false}
            render={(props) => (
              <Link search={{ new: true }} to="/routines" {...props} />
            )}
            size="sm"
          >
            <IconPlus />
            {t("New routine")}
          </Button>
        }
      >
        <PageSection>
          {/*
           * The cards first, then the list: a suggestion is only worth anything before the person
           * has written the routine themselves. The section draws nothing when there is nothing
           * to offer, so the list sits where it always did.
           */}
          {/*
           * What the unread rule paused, first: it is about routines the person already has, and a
           * pause that sits below the suggestions is a pause read after an offer of more routines.
           */}
          <UnreadPauseBanners />
          <RoutineSuggestions />
          <div className="flex flex-col gap-3">
            {/*
             * OVER THE ROWS, AND THERE BEFORE IT SPEAKS. The page was blank on a failed fetch — no
             * rows, no snail, no explanation — and later drew a red "could not be loaded" above rows
             * that were still there and still worked, which read as the list being wrong rather
             * than old. The failure, the quiet line and "not offered here" share this one place.
             */}
            <ReadNotice
              line={list.notice}
              onRetry={() => void routines.refetch()}
            />
            {list.isLoading
              ? [0, 1, 2].map((slot) => (
                  <Skeleton className="h-[92px] rounded-xl" key={slot} />
                ))
              : null}
            {list.rows.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                showBot={showBot}
              />
            ))}
            {list.empty ? (
              <div className="flex flex-col items-center gap-3 py-10">
                {/* Eyes closed and nothing on its head: the face the set has for unhurried. */}
                <BotAvatar
                  className="opacity-80"
                  seed="s:wedge.cyan"
                  size={56}
                />
                <p className="text-center text-muted-foreground text-sm">
                  {list.empty}
                </p>
                {/* The way to make one, where the sentence says to — not only in the header. */}
                <Button
                  nativeButton={false}
                  render={(props) => (
                    <Link search={{ new: true }} to="/routines" {...props} />
                  )}
                  variant="secondary"
                >
                  {t("New routine")}
                </Button>
              </div>
            ) : null}
          </div>
        </PageSection>
      </PageShell>
    </DetailPanel>
  );
}

/**
 * Writing a routine is a search parameter, not a local boolean — the same contract Skills and the
 * Bots roster make. It survives a reload, it can be linked to, and Back closes it.
 */
const routinesSearchSchema = z
  .object({ new: z.boolean().optional(), edit: z.string().optional() })
  /* `.catch({})` so an unknown parameter is ignored rather than throwing out of validateSearch and
   * taking the whole route down with it. */
  .catch({});

export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
  validateSearch: routinesSearchSchema,
});
