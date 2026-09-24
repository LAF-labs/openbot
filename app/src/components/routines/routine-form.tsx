import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { savingFailure } from "@/components/routines/saving-failure";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import {
  blankForm,
  formOf,
  type Repeat,
  type RoutineFormState,
  routineChange,
  scheduleFrom,
  timeOf,
} from "@/lib/routines/form";
import {
  hourLabel,
  type Routine,
  routineKeys,
  routineRequest,
  scheduleLabel,
  weekdayNames,
} from "@/lib/routines/queries";

/**
 * WRITING A ROUTINE, IN THE PANEL BESIDE THE LIST — a new one, or one that already exists.
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
 * ONE FORM FOR BOTH, because a routine could not be edited at all until 2026-09-18 and the edit is
 * the same question asked again. Handed a `routine`, it opens filled in from it (`formOf`) and saves
 * only what changed (`routineChange`); the Bot is shown and not offered, because a routine stays on
 * the Bot it was made for — its run history, its notepad and the conversation its answers land in
 * are that Bot's.
 *
 * THE FIELDS GO IN THE ORDER THE QUESTION IS ASKED: what is it called, what does it do, when does it
 * go. They used to run 이름 → 무엇을 → 언제 → **만들기** → 요일, with the day chips BELOW the button
 * that submits the form — so the last decision was offered after the press that ends the form.
 */

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

/** The browser's own zone, which a new daily routine is written in. */
const browserZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const TriggerReveal = ({
  routineId,
  token,
}: {
  routineId: string;
  token: string;
}) => {
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
};

export const RoutineForm = ({
  routine,
  onDone,
}: {
  /** The routine being edited. Absent, the form makes a new one. */
  routine?: Routine;
  onDone: () => void;
}) => {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const agentFieldId = useId();
  const instructionId = useId();
  const nameId = useId();
  const repeatId = useId();
  const isEditing = routine !== undefined;
  /*
   * ONE STATE, FILLED IN ONCE. From the routine when editing, so the form opens on what is stored;
   * from the defaults otherwise. The list refetching underneath — a run landing, the switch pressed
   * in the row beside it — does not reset what the person has typed.
   *
   * THE TIME IS A WALL CLOCK. For a new routine it is the reader's own zone, defaulted from their
   * browser: this field was once labelled "Time (UTC)" and defaulted to 22:30, which is 07:30 in
   * Seoul — right, and unknowable to the person. For a routine being edited it is the zone that
   * routine is written in (`formOf`).
   *
   * TWO SELECTS RATHER THAN `<input type="time">`. The native control is formatted by the BROWSER's
   * locale, not by the app's: measured in a Chrome running in English, the field said 07:30 AM
   * directly above this form's own 매일 07:30 and a saved row's 평일 09:00. Three formats, one
   * screen. An hour and a minute the app renders itself are the app's own words in both languages,
   * and on a phone they are two taps rather than a spinner.
   */
  const [form, setForm] = useState<RoutineFormState>(() =>
    routine ? formOf(routine, browserZone()) : blankForm(browserZone()),
  );
  const update = (patch: Partial<RoutineFormState>) =>
    setForm((current) => ({ ...current, ...patch }));
  const { name, instruction, repeat, minutes, hour, minute, days } = form;
  /*
   * ONE BOT, NO QUESTION. "어느 봇이" was a required select on every new routine for a person who has
   * exactly one Bot to pick (UI/UX audit 0.5.3, item 9): the only answer, asked for anyway, and the
   * form refused to save until it was given. With one Bot it is that Bot and the field is not drawn;
   * an older account with several still chooses.
   */
  const onlyBot = agents.data?.length === 1 ? agents.data[0] : undefined;
  const hasSeveralBots = (agents.data?.length ?? 0) > 1;
  const agentId = form.agentId || onlyBot?.id || "";
  /** Shown only after a press. Nothing is red before somebody has tried. */
  const [problems, setProblems] = useState<Problems>({});

  const [trigger, setTrigger] = useState<{
    routineId: string;
    token: string;
  } | null>(null);

  /*
   * A minute off the grid — a Bot can store 07:32 — is offered as itself, so the select can show the
   * value it holds and saving does not round a time nobody asked to change.
   */
  const minuteOptions = MINUTES.includes(minute)
    ? MINUTES
    : [...MINUTES, minute].sort((a, b) => a - b);

  /*
   * The schedule, said back. Built from the same label the saved rows use, so what the form
   * promises and what the list reports can never describe the same schedule differently.
   */
  const summarySentence = scheduleLabel({
    agentId: "",
    dailyDays: repeat === "weekly" ? days : [],
    dailyLocal: timeOf(form),
    dailyTimeZone: form.timeZone,
    enabled: true,
    id: "",
    instruction: "",
    intervalMinutes: Number(minutes),
    name: "",
    scheduleKind: repeat === "interval" ? "interval" : "daily",
  } as Routine);

  const save = useMutation({
    mutationFn: async () => {
      if (routine) {
        return routineRequest(`/api/routines/${routine.id}`, {
          method: "PATCH",
          body: JSON.stringify(routineChange(routine, form)),
        });
      }
      return routineRequest("/api/routines", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          name,
          instruction,
          schedule: scheduleFrom(form),
        }),
      });
    },
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
      const saved = body?.routine as
        | { id: string; triggerToken?: string }
        | undefined;
      // The token exists only in a create's response; once this card is dismissed it is gone for
      // good, which is the point of hashing it server-side.
      if (saved?.triggerToken) {
        setTrigger({ routineId: saved.id, token: saved.triggerToken });
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
    // Only where there is a field to say it beside; with one Bot the server names the Bot.
    if (!agentId && hasSeveralBots) found.agent = t("Pick a Bot first.");
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending) return;
    if (!check()) return;
    // An edit that changed nothing is not a request: the panel closes on what is already saved.
    if (routine && Object.keys(routineChange(routine, form)).length === 0) {
      onDone();
      return;
    }
    save.mutate();
  };

  return (
    /*
     * A FORM, NOT A CARD OF CONTROLS. Enter did nothing anywhere in it, and the only way out was the
     * button that had opened it — a person who changed their mind had to scroll up and find it.
     */
    <form
      className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8"
      noValidate
      onSubmit={handleSubmit}
    >
      <header>
        {/* h2: the page behind this panel already has the page's one h1. */}
        <h2 className={pageTitleClass}>
          {isEditing ? t("Edit routine") : t("New routine")}
        </h2>
        <p className={`mt-1 ${pageDescriptionClass}`}>
          {isEditing
            ? t(
                "Its run history, its notepad and its webhook stay as they are.",
              )
            : t("What it does, and when. You can change all of it later.")}
        </p>
      </header>

      <FieldGroup>
        <Field data-invalid={Boolean(problems.name)}>
          <FieldLabel htmlFor={nameId}>{t("Name")}</FieldLabel>
          <Input
            aria-invalid={Boolean(problems.name)}
            autoFocus
            id={nameId}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={t("Name, e.g. Weekly sales summary")}
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
            onChange={(event) => update({ instruction: event.target.value })}
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

        {hasSeveralBots ? (
          <Field data-invalid={Boolean(problems.agent)}>
            <FieldLabel htmlFor={agentFieldId}>{t("Which Bot")}</FieldLabel>
            <Select
              disabled={isEditing}
              onValueChange={(value) => update({ agentId: value ?? "" })}
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
            {/* Said, because a control that does not open with nothing beside it reads as broken. */}
            {isEditing ? (
              <FieldDescription>
                {t("A routine stays with the Bot it was made for.")}
              </FieldDescription>
            ) : null}
            {problems.agent ? (
              <FieldError errors={[{ message: problems.agent }]} />
            ) : null}
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor={repeatId}>{t("When")}</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              onValueChange={(value) =>
                update({ repeat: (value ?? "daily") as Repeat })
              }
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
                  onChange={(event) => update({ minutes: event.target.value })}
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
                  onValueChange={(value) =>
                    update({ hour: Number(value ?? "7") })
                  }
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
                  onValueChange={(value) =>
                    update({ minute: Number(value ?? "0") })
                  }
                  value={String(minute)}
                >
                  <SelectTrigger aria-label={t("Minutes")} className="w-24">
                    <SelectValue>
                      {t("{minutes} min", { minutes: minute })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {minuteOptions.map((option) => (
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
                    update({
                      days: days.includes(index)
                        ? days.filter((day) => day !== index)
                        : [...days, index].sort((a, b) => a - b),
                    })
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
                onClick={() => update({ days: WEEKDAYS })}
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

      {save.error ? (
        <p className="text-destructive text-sm" role="alert">
          {savingFailure(save.error)}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button disabled={save.isPending} type="submit">
          {isEditing
            ? save.isPending
              ? t("Saving…")
              : t("Save changes")
            : save.isPending
              ? t("Creating…")
              : t("Create routine")}
        </Button>
        <Button onClick={onDone} type="button" variant="outline">
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
};
