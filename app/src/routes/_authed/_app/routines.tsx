import { IconClockPlay, IconDots, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { z } from "zod";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { DetailPanel } from "@/components/layout/detail-panel";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { focusRing } from "@/components/ui/focus";
import { Input } from "@/components/ui/input";
import {
  pageDescriptionClass,
  pageTitleClass,
} from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { activeLocale, t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import {
  hourLabel,
  type Routine,
  type RoutineRun,
  routineKeys,
  routineListQueryOptions,
  routineRequest,
  runShape,
  scheduleLabel,
  weekdayNames,
  whenLabel,
} from "@/lib/routines/queries";

/**
 * Routines: an instruction, a Bot, and a clock.
 *
 * A routine here is a sentence, on purpose — something its owner can read back and edit — and the
 * page is built accordingly: the instruction is the biggest field on it, and a routine's row leads
 * with what it says, not with its schedule.
 */

function RunHistory({ routineId }: { routineId: string }) {
  const runs = useQuery({
    queryKey: routineKeys.runs(routineId),
    queryFn: async () =>
      (await routineRequest(`/api/routines/${routineId}/runs`))
        ?.runs as RoutineRun[],
  });

  // "Never run" is a claim about the past. It must not be made while the past is still arriving.
  if (runs.isPending) {
    return (
      <p className="py-2 text-xs text-muted-foreground">{t("Loading runs…")}</p>
    );
  }
  if (runs.isError) {
    return (
      <div className="flex items-center gap-2 py-2">
        <p className="text-xs text-destructive" role="alert">
          {t("The run history could not be loaded.")}
        </p>
        <Button onClick={() => void runs.refetch()} size="sm" variant="ghost">
          {t("Try again")}
        </Button>
      </div>
    );
  }
  if (!runs.data?.length) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        {t("This routine has not run yet.")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 py-2">
      {runs.data.map((run) => (
        <li
          key={run.id}
          className="rounded-lg border border-border bg-card p-3"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{new Date(run.startedAt).toLocaleString(activeLocale)}</span>
            <span className={run.ok ? "" : "text-destructive"}>
              {run.ok ? t("Ran") : t("Failed")}
              {runShape(run.steps, t) ? ` · ${runShape(run.steps, t)}` : ""}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
            {run.ok ? run.answer : run.error}
          </p>
        </li>
      ))}
    </ul>
  );
}

function RoutineRow({ routine }: { routine: Routine }) {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const [showRuns, setShowRuns] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: routineKeys.all });

  /*
   * THE SWITCH MOVES WHEN IT IS CLICKED. It was driven straight off server state, so nothing
   * happened until the round trip landed — a control that ignores you for half a second reads as
   * broken, and people click it twice. The optimistic write is rolled back on failure, which is the
   * only honest way to show a switch that did not take.
   */
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      routineRequest(`/api/routines/${routine.id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: routineKeys.all });
      const previous = queryClient.getQueryData<Routine[]>(routineKeys.all);
      queryClient.setQueryData<Routine[]>(routineKeys.all, (rows) =>
        rows?.map((row) => (row.id === routine.id ? { ...row, enabled } : row)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(routineKeys.all, context.previous);
      }
    },
    onSettled: invalidate,
  });
  const runNow = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}/run`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: routineKeys.runs(routine.id),
      });
    },
  });
  const remove = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmingDelete(false);
      invalidate();
    },
  });

  const bot = agents.data?.find((agent) => agent.id === routine.agentId);

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        {/*
         * The routine's Bot, and the Bot's id when the roster has not answered yet — a face from
         * the id is stable and merely not the right one, which beats a hole in the row.
         */}
        <BotAvatar
          className="shrink-0"
          seed={bot?.avatarSeed ?? routine.agentId}
          size={36}
        />
        <button
          aria-expanded={showRuns}
          // The house ring. It had none at all, so tabbing across a list of routines went dark.
          className={`min-w-0 flex-1 rounded-md text-left ${focusRing}`}
          onClick={() => setShowRuns((open) => !open)}
          type="button"
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-sm">{routine.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {bot?.name ? `${bot.name} · ` : ""}
              {scheduleLabel(routine)}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {routine.instruction}
          </p>
          {/*
           * WHEN IT LAST WENT AND WHEN IT GOES NEXT.
           *
           * The server has sent `nextRunAt` and `lastRunAt` on every row since routines existed and
           * the screen threw both away, so the one question anybody has about a schedule — is it
           * actually running — could only be answered by opening the run history. 다음 실행 is the
           * promise the switch is making; 마지막 실행 is the evidence it kept it.
           */}
          <p className="truncate text-muted-foreground/80 text-xs">
            {t("Next {when}", { when: whenLabel(routine.nextRunAt) })}
            {routine.lastRunAt
              ? ` · ${t("Last {when}", { when: whenLabel(routine.lastRunAt) })}`
              : ` · ${t("Not run yet")}`}
          </p>
        </button>
        {/*
         * THREE UNLABELLED ICONS, ONE OF THEM PERMANENT, ALL THE SAME SIZE AND COLOUR.
         *
         * 지금 실행 and 삭제 were two grey glyphs either side of a switch, and the destructive one
         * was the easier of the two to hit by accident. 삭제 moves into the ⋯ menu — the same place
         * a Bot's does — and the two that are left say what they are, in a tooltip for the mouse and
         * in `aria-label` for everybody else.
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
                // already be open while the Bot is working, or the click looks like it did nothing
                // for a minute.
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
                 * NAMED FOR THE ROUTINE, NOT FOR ITS STATE. It read "'재고 확인' 켜짐" whether it was
                 * on or off — a label that lies in one of the two states it has. `role="switch"`
                 * already carries `aria-checked`; the name only has to say which switch this is.
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
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => setConfirmingDelete(true)}
              variant="destructive"
            >
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/*
       * 지금 실행 SAID NOTHING. It opened the history panel and the row sat there — the request can
       * take a minute, and for that minute the press looked like it had missed.
       */}
      {runNow.isPending || runNow.isSuccess || runNow.isError ? (
        <p
          className={`px-4 pb-3 text-xs ${runNow.isError ? "text-destructive" : "text-muted-foreground"}`}
          role="status"
        >
          {runNow.isPending
            ? t("Running now…")
            : runNow.isError
              ? runNow.error.message
              : t("Started. The answer lands below.")}
        </p>
      ) : null}
      {/*
       * A routine and every run it ever made, gone on one click of a small grey icon next to a
       * switch. It is the only irreversible thing on this page and it asked nothing.
       */}
      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "The schedule stops and its run history goes with it. This cannot be undone.",
        )}
        error={remove.error?.message}
        onConfirm={() => remove.mutate()}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        open={confirmingDelete}
        pending={remove.isPending}
        title={t("Delete {name}{josa}?", {
          josa: josa(routine.name, "을/를"),
          name: routine.name,
        })}
      />
      {showRuns ? (
        <div className="border-border border-t px-4">
          <RunHistory routineId={routine.id} />
        </div>
      ) : null}
    </div>
  );
}

function TriggerReveal({
  routineId,
  token,
}: {
  routineId: string;
  token: string;
}) {
  const command = `curl -X POST ${window.location.origin}/api/routines/${routineId}/trigger -H "x-trigger-token: ${token}"`;
  return (
    <div className="rounded-lg border border-border bg-muted/60 p-3 text-xs">
      <p className="font-medium">{t("Webhook trigger — shown only once")}</p>
      <p className="mt-1 text-muted-foreground">
        {t(
          "Any system that POSTs this fires the routine (at most once per 30 seconds). The request body, if any, is handed to the Bot.",
        )}
      </p>
      <code className="mt-2 block select-all break-all rounded bg-background p-2 font-mono text-xs">
        {command}
      </code>
    </div>
  );
}

/**
 * WRITING A ROUTINE, IN THE PANEL BESIDE THE LIST.
 *
 * ONE CREATION PATTERN FOR THE THREE SIBLING PAGES, AND THE CHOICE IS THE RIGHT-HAND PANEL.
 * Routines opened a card inline above the list, Skills slid a panel in from the right, and a Bot is
 * made with no form at all — three answers on three pages a person walks between in one session.
 *
 * The panel wins over a dialog for the reason `DetailPanel` already gives: it is a search parameter,
 * so writing a routine is a real navigation. It survives a reload, it can be linked to, Back closes
 * it, and the routines you already have stay on screen beside the one you are writing — which is
 * how anybody writes the second one. A dialog would take the list away and put the form somewhere
 * a URL cannot reach. Skills already made this bet and it is the same bet.
 *
 * THE FIELDS GO IN THE ORDER THE QUESTION IS ASKED: what is it called, what does it do, when does it
 * go. They used to run 이름 → 무엇을 → 언제 → **만들기** → 요일, with the day chips BELOW the button
 * that submits the form — so the last decision was offered after the press that ends the form.
 */
/** 매일, 특정 요일, N분마다. The first two are both `daily` rows; the middle one carries days. */
type Repeat = "daily" | "weekly" | "interval";

function repeatLabel(repeat: Repeat): string {
  if (repeat === "weekly") return t("On certain days");
  if (repeat === "interval") return t("Every N minutes");
  return t("Every day");
}

/** What the form has to say back after a press, field by field. */
type Problems = {
  agent?: string;
  days?: string;
  instruction?: string;
  minutes?: string;
  name?: string;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Five-minute steps: a routine wants a time of day, not a stopwatch. */
const MINUTES = Array.from({ length: 12 }, (_, step) => step * 5);
/** Monday to Friday, the one preset worth a button. `weekdayNames()` is indexed 0 = Sunday. */
const WEEKDAYS = [1, 2, 3, 4, 5];

function NewRoutine({ onDone }: { onDone: () => void }) {
  const agents = useQuery(agentListQueryOptions());
  const agentFieldId = useId();
  const instructionId = useId();
  const nameId = useId();
  const repeatId = useId();
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  /*
   * THREE REPEATS, NOT TWO, BECAUSE THE THIRD ONE WAS ALREADY THERE AND UNNAMED.
   *
   * The stored shapes are `daily` and `interval`; a daily routine with a `days` restriction is what
   * makes a weekly one, and the form never said so. It showed 매일 and then, underneath, seven day
   * chips with none of them lit — which is a choice nobody was asked to make, offered in a state
   * that reads as "none of these", on a schedule that runs every day. 특정 요일 is that third shape
   * with a name, and the chips only exist inside it.
   */
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [minutes, setMinutes] = useState("60");
  /*
   * The time is a wall clock in the reader's own zone, defaulted from their browser.
   *
   * This field was labelled "Time (UTC)" and defaulted to 22:30, which is 07:30 in Seoul — the
   * value was right and the person had no way to know it. Nobody setting a morning routine should
   * have to convert anything.
   *
   * TWO SELECTS RATHER THAN `<input type="time">`. The native control is formatted by the BROWSER's
   * locale, not by the app's: measured in a Chrome running in English, the field said 07:30 AM
   * directly above this form's own 매일 07:30 and a saved row's 평일 09:00. Three formats, one
   * screen. An hour and a minute the app renders itself are the app's own words in both languages,
   * and on a phone they are two taps rather than a spinner.
   */
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(30);
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  /** Empty means every day, which is what the server stores for an unrestricted routine. */
  const [days, setDays] = useState<number[]>([]);
  /** Shown only after a press. Nothing is red before somebody has tried. */
  const [problems, setProblems] = useState<Problems>({});

  const [trigger, setTrigger] = useState<{
    routineId: string;
    token: string;
  } | null>(null);

  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  /*
   * The schedule, said back. Built from the same label the saved rows use, so what the form
   * promises and what the list reports can never describe the same schedule differently.
   */
  const summarySentence = scheduleLabel({
    agentId: "",
    dailyDays: repeat === "weekly" ? days : [],
    dailyLocal: time,
    dailyTimeZone: timeZone,
    enabled: true,
    id: "",
    instruction: "",
    intervalMinutes: Number(minutes),
    name: "",
    scheduleKind: repeat === "interval" ? "interval" : "daily",
  } as Routine);

  const create = useMutation({
    mutationFn: async () =>
      routineRequest("/api/routines", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          name,
          instruction,
          schedule:
            repeat === "interval"
              ? { kind: "interval", minutes: Number(minutes) }
              : {
                  kind: "daily",
                  time,
                  timeZone,
                  // Omitted rather than empty: the server refuses an empty selection on purpose,
                  // so "every day" has to be the absence of a restriction, not an empty one.
                  ...(repeat === "weekly" && days.length > 0 ? { days } : {}),
                },
        }),
      }),
    onSuccess: (body) => {
      const routine = body?.routine as
        | { id: string; triggerToken?: string }
        | undefined;
      // The token exists only in this response; once this card is dismissed it is gone for good,
      // which is the point of hashing it server-side.
      if (routine?.triggerToken) {
        setTrigger({ routineId: routine.id, token: routine.triggerToken });
      } else {
        onDone();
      }
    },
  });

  if (trigger) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-8">
        <TriggerReveal routineId={trigger.routineId} token={trigger.token} />
        <div className="flex justify-end">
          <Button onClick={onDone} size="sm">
            {t("Done")}
          </Button>
        </div>
      </div>
    );
  }

  /*
   * VALIDATED ON THE PRESS, WITH THE BUTTON LIVE THE WHOLE TIME.
   *
   * 루틴 만들기 opened disabled — a mid-grey filled pill, skipped by the tab order, with nothing
   * anywhere on the form saying what was missing. A disabled primary action is a question with the
   * answer hidden: the person can see the button and cannot find out what it wants. So the button
   * is always pressable, and pressing it with an empty form says which field is empty, beside that
   * field.
   */
  const check = (): boolean => {
    const found: Problems = {};
    if (!agentId) found.agent = t("Pick a Bot first.");
    if (!name.trim()) found.name = t("Give the routine a name.");
    if (!instruction.trim())
      found.instruction = t("Say what the routine should do each time.");
    if (repeat === "weekly" && days.length === 0)
      found.days = t("Pick at least one day.");
    if (repeat === "interval" && !(Number(minutes) >= 5))
      found.minutes = t("Five minutes is the shortest gap.");
    setProblems(found);
    return Object.keys(found).length === 0;
  };

  return (
    /*
     * A FORM, NOT A CARD OF CONTROLS. Enter did nothing anywhere in it, and the only way out was the
     * button that had opened it — a person who changed their mind had to scroll up and find it.
     */
    <form
      className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (create.isPending) return;
        if (!check()) return;
        create.mutate();
      }}
    >
      <header>
        {/* h2: the page behind this panel already has the page's one h1. */}
        <h2 className={pageTitleClass}>{t("New routine")}</h2>
        <p className={`mt-1 ${pageDescriptionClass}`}>
          {t(
            "An instruction, a Bot, and a clock. You can change all of it later.",
          )}
        </p>
      </header>

      <FieldGroup>
        <Field data-invalid={Boolean(problems.name)}>
          <FieldLabel htmlFor={nameId}>{t("Name")}</FieldLabel>
          <Input
            aria-invalid={Boolean(problems.name)}
            autoFocus
            id={nameId}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("Name, e.g. Morning review digest")}
            value={name}
          />
          {problems.name ? (
            <FieldError errors={[{ message: problems.name }]} />
          ) : null}
        </Field>

        <Field data-invalid={Boolean(problems.instruction)}>
          <FieldLabel htmlFor={instructionId}>
            {t("What should it do?")}
          </FieldLabel>
          <Textarea
            aria-invalid={Boolean(problems.instruction)}
            id={instructionId}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t(
              "What should it do? e.g. Check the store reviews and summarize the new ones.",
            )}
            rows={3}
            value={instruction}
          />
          {problems.instruction ? (
            <FieldError errors={[{ message: problems.instruction }]} />
          ) : null}
        </Field>

        <Field data-invalid={Boolean(problems.agent)}>
          <FieldLabel htmlFor={agentFieldId}>{t("Which Bot")}</FieldLabel>
          <Select
            onValueChange={(value) => setAgentId(value ?? "")}
            value={agentId}
          >
            <SelectTrigger
              aria-invalid={Boolean(problems.agent)}
              id={agentFieldId}
            >
              {/* Explicit children: the bare fallback renders the raw `agent_<uuid>`. */}
              <SelectValue placeholder={t("Which Bot")}>
                {agents.data?.find((agent) => agent.id === agentId)?.name ??
                  t("Which Bot")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {problems.agent ? (
            <FieldError errors={[{ message: problems.agent }]} />
          ) : null}
        </Field>

        <Field>
          <FieldLabel htmlFor={repeatId}>{t("When")}</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              onValueChange={(value) => setRepeat((value ?? "daily") as Repeat)}
              value={repeat}
            >
              <SelectTrigger className="w-36" id={repeatId}>
                {/* The value is a code; the person reads the label. */}
                <SelectValue>{repeatLabel(repeat)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">{t("Every day")}</SelectItem>
                <SelectItem value="weekly">{t("On certain days")}</SelectItem>
                <SelectItem value="interval">{t("Every N minutes")}</SelectItem>
              </SelectContent>
            </Select>

            {repeat === "interval" ? (
              <>
                <Input
                  aria-label={t("Minutes")}
                  aria-invalid={Boolean(problems.minutes)}
                  className="w-24"
                  min={5}
                  onChange={(event) => setMinutes(event.target.value)}
                  type="number"
                  value={minutes}
                />
                <span className="text-muted-foreground text-sm">
                  {t("minutes")}
                </span>
              </>
            ) : (
              <>
                <Select
                  onValueChange={(value) => setHour(Number(value ?? "7"))}
                  value={String(hour)}
                >
                  <SelectTrigger aria-label={t("Hour")} className="w-28">
                    <SelectValue>{hourLabel(hour)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {hourLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={(value) => setMinute(Number(value ?? "0"))}
                  value={String(minute)}
                >
                  <SelectTrigger aria-label={t("Minutes")} className="w-24">
                    <SelectValue>
                      {t("{minutes} min", { minutes: minute })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MINUTES.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {t("{minutes} min", { minutes: option })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
          {problems.minutes ? (
            <FieldError errors={[{ message: problems.minutes }]} />
          ) : null}

          {/*
           * The chips belong to 특정 요일 and appear with it. Seven options that are all visible at
           * once do not need a menu, and the point of the whole control is that a Monday-morning
           * routine does not also go off on Sunday.
           */}
          {repeat === "weekly" ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {weekdayNames().map((label, index) => (
                <Button
                  aria-pressed={days.includes(index)}
                  className="w-10"
                  key={label}
                  onClick={() =>
                    setDays((current) =>
                      current.includes(index)
                        ? current.filter((day) => day !== index)
                        : [...current, index].sort((a, b) => a - b),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {label}
                </Button>
              ))}
              <Button
                className="ms-1"
                onClick={() => setDays(WEEKDAYS)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Weekdays")}
              </Button>
            </div>
          ) : null}
          {problems.days ? (
            <FieldError errors={[{ message: problems.days }]} />
          ) : null}

          {/* Said back in words, because a row of chips and a clock is not a sentence. */}
          <p className="mt-1 text-muted-foreground text-sm">
            {summarySentence}
          </p>
        </Field>
      </FieldGroup>

      {create.error ? (
        <p className="text-destructive text-sm" role="alert">
          {create.error.message}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button disabled={create.isPending} type="submit">
          {create.isPending ? t("Creating…") : t("Create routine")}
        </Button>
        <Button onClick={onDone} type="button" variant="outline">
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

function RoutinesPage() {
  const queryClient = useQueryClient();
  const { new: isCreating } = Route.useSearch();
  const navigate = Route.useNavigate();
  const routines = useQuery(routineListQueryOptions());
  const creating = isCreating === true;

  return (
    <DetailPanel
      detail={
        creating ? (
          <NewRoutine
            onDone={() => {
              void navigate({ search: {} });
              void queryClient.invalidateQueries({ queryKey: routineKeys.all });
            }}
          />
        ) : null
      }
      // 400px like a Bot's profile, not 320: this is a form with a select, two more selects and
      // seven day chips on one line, and at 320 the chips wrapped to three rows.
      detailWidth={400}
      onClose={() => navigate({ search: {} })}
      open={creating}
    >
      <PageShell
        title={t("Routines")}
        description={t(
          "An instruction a Bot runs on a clock — a morning digest, a daily check, a weekly summary.",
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
          <div className="flex flex-col gap-3">
            {/* The page was blank on a failed fetch: no rows, no snail, no explanation, nothing. */}
            {routines.isPending
              ? [0, 1, 2].map((slot) => (
                  <Skeleton className="h-[92px] rounded-xl" key={slot} />
                ))
              : null}
            {routines.isError ? (
              <div className="flex flex-col items-start gap-2 py-6">
                <p className="text-destructive text-sm" role="alert">
                  {t("Your routines could not be loaded.")}
                </p>
                <Button
                  onClick={() => void routines.refetch()}
                  size="sm"
                  variant="outline"
                >
                  {t("Try again")}
                </Button>
              </div>
            ) : null}
            {(routines.data ?? []).map((routine) => (
              <RoutineRow key={routine.id} routine={routine} />
            ))}
            {routines.data?.length === 0 && !creating ? (
              <div className="flex flex-col items-center gap-3 py-10">
                {/* Eyes closed and nothing on its head: the face the set has for unhurried. */}
                <BotAvatar
                  className="opacity-80"
                  seed="s:wedge.cyan"
                  size={56}
                />
                <p className="text-center text-muted-foreground text-sm">
                  {t(
                    "No routines yet. Give a Bot something to do every morning.",
                  )}
                </p>
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
  .object({ new: z.boolean().optional() })
  /* `.catch({})` so an unknown parameter is ignored rather than throwing out of validateSearch and
   * taking the whole route down with it. */
  .catch({});

export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
  validateSearch: routinesSearchSchema,
});
