import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LiveRegion } from "@/components/layout/live-region";
import { focusRing } from "@/components/ui/focus";
import {
  type FirstTask,
  makeMorningReport,
  reportFirstTaskPressed,
} from "@/lib/agents/first-tasks";
import {
  type BriefingSection,
  briefingContents,
  briefingInstruction,
} from "@/lib/agents/morning-briefing";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { failureSentence } from "@/lib/press";
import { routineKeys } from "@/lib/routines/queries";
import { dailyPlaceById } from "@/lib/shop/catalogue";

/**
 * THE FIRST THING TO ASK, AS SOMETHING TO PRESS.
 *
 * Four sentences, a way to the 연결 screen when nothing is connected, and a chip that makes a
 * morning briefing of what this Bot can reach (`morning-briefing.ts`). It sits under the intro card
 * on a new Bot's empty conversation: the card decides what the Bot is, these decide what it does first. A sentence a
 * person can press is worth more than a paragraph of what the Bot could do, because the ten minutes
 * between signing up and a first useful answer are spent on the blank composer underneath.
 *
 * The routine goes through `POST /api/routines` exactly as the Routines page's own form does, with
 * one difference a person can see: the webhook box the page shows once afterwards is not drawn
 * here. It is the one control on that form nobody on this screen has a use for, and the token it
 * holds is shown once and never again — so the honest thing is not to show it at all, and to say
 * where the routine went instead.
 *
 * Every press is reported as a browser event (`FIRST_TASK_PRESSED`) before it does anything, so
 * "did the chips get used" can be answered without a table.
 */
export const FirstTaskChips = ({
  agent,
  briefing,
  briefingMade = false,
  disabled,
  onAsk,
  placeKnown,
  tasks,
}: {
  agent: AgentProfile;
  /** What the 7:30 briefing will hold, from what this Bot can reach now (`briefingSections`). */
  briefing: readonly BriefingSection[];
  /** This Bot already has its 아침 브리핑 — made here before a reload, or on Routines. */
  briefingMade?: boolean;
  /** A first message is already on its way; a second chip must not start a second channel. */
  disabled: boolean;
  onAsk: (sentence: string) => void;
  /** Whether the person's place — named, or from the device — is known. The weather needs it. */
  placeKnown: boolean;
  tasks: readonly FirstTask[];
}) => {
  const queryClient = useQueryClient();
  const openConversation = useMutation(
    createChannelMutationOptions(queryClient),
  );
  const makeRoutine = useMutation({
    mutationFn: async (instruction: string) => {
      /*
       * THE CONVERSATION FIRST. A routine delivers only into a conversation that exists, and one
       * exists only once something has been sent (`routines/deliver.ts`: making one as a side effect
       * of a schedule would be a surprise). Pressed here, before anything was said, the chip made a
       * briefing that arrived nowhere — found on 2026-09-27 by pressing it on a fresh account and
       * reading an empty roster after 7:30. This press is the person asking for the briefing in
       * this conversation, so it opens it: the same idempotent `POST /api/channels` a first message
       * makes, which answers with the Bot's conversation if it already has one.
       */
      await openConversation.mutateAsync([agent.id]);
      return makeMorningReport({
        agentId: agent.id,
        instruction,
        /*
         * The name the Routines page's own 아침 브리핑 suggestion carries. That card is withheld while
         * a routine of the same name exists (`routines/suggestions.ts`): two briefings a morning is
         * one too many, whichever way the second was made.
         */
        name: t("Morning briefing"),
        // The person's own clock, the way the Routines page reads it: 7:30 means 7:30 here.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });
  const made = makeRoutine.isSuccess || briefingMade;

  const chip = `rounded-full border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:border-ring/40 hover:bg-muted/60 disabled:opacity-50 ${focusRing}`;

  /*
   * THE WAY TO 연결 IS A LINK, NOT A CHIP. It was drawn in the row with the same pill as the
   * sentences, and every other pill in that row asks the Bot something where you are; this one
   * left the conversation for Settings (0.5.3 audit, item 12). A press that does something other
   * than what its neighbours do has to look different. A place the person picked still leads — it
   * is the one act that makes the sentences under it this shop's — but as a line above the row, and
   * the general one sits under it.
   */
  const connectLink = (task: Extract<FirstTask, { kind: "connect" }>) => (
    <Link
      className={`self-start text-muted-foreground text-sm underline underline-offset-2 hover:text-foreground ${focusRing}`}
      key={`connect:${task.place ?? ""}`}
      onClick={() =>
        /*
         * Reported as the connect chip it has always been. Which place it named is not on the wire:
         * the fleet counts presses by catalogue keys it already validates, and a new field there is
         * a contract change for a fact the insights do not ask about.
         */
        reportFirstTaskPressed({
          agentId: agent.id,
          kind: "connect",
          pattern: null,
          sentence: null,
          via: null,
          hint: null,
        })
      }
      to="/settings/connected-accounts"
    >
      {/*
       * A place the person picked is named, in their own word for it: "배달의민족 연결하기" is an
       * errand somebody recognises as theirs, "사이트 연결하기" is a chore.
       */}
      {task.place
        ? t("Connect {place}", {
            place: t(dailyPlaceById(task.place)?.name ?? task.place),
          })
        : t("Connect a site")}
    </Link>
  );
  const connects = tasks.filter((task) => task.kind === "connect");

  return (
    <section
      aria-label={t("Try one of these first")}
      className="flex w-full max-w-md flex-col gap-2 text-left"
    >
      <p className="text-muted-foreground text-xs">
        {t("Try one of these first")}
      </p>
      {connects.filter((task) => task.place).map(connectLink)}
      <div className="flex flex-wrap gap-1.5">
        {tasks.map((task) =>
          task.kind === "connect" ? null : (
            <button
              className={chip}
              disabled={disabled}
              key={task.sentence}
              onClick={() => {
                reportFirstTaskPressed({
                  agentId: agent.id,
                  kind: "ask",
                  pattern: task.pattern,
                  sentence: task.sentence,
                  via: task.via,
                  hint: null,
                });
                // The Korean, not the key: the Bot is asked in the person's own language.
                onAsk(t(task.sentence));
              }}
              type="button"
            >
              {t(task.sentence)}
            </button>
          ),
        )}
      </div>
      {/*
       * Mounted with the chip it answers, so 루틴을 만들었습니다 is heard when it is said: drawn
       * only on success, the line arrived with its region and was never read out.
       */}
      <LiveRegion as="p" className="text-sm text-muted-foreground">
        {made ? (
          <>
            {t("The routine is made.")}
            {" · "}
            <Link
              className={`underline underline-offset-2 hover:text-foreground ${focusRing}`}
              to="/routines"
            >
              {t("See it on Routines")}
            </Link>
          </>
        ) : null}
      </LiveRegion>
      {made ? null : (
        <div className="flex flex-col gap-1">
          <button
            className={`${chip} self-start`}
            disabled={makeRoutine.isPending}
            onClick={() => {
              /*
               * `schedule`, and through nothing: the briefing is not one of the row's sentences but
               * a morning report of several, and the press route wants the kind of work it is
               * (`parseFirstTaskPress` refuses a routine press without one). Its sections are not on
               * the wire, for the reason the sentence never is.
               */
              reportFirstTaskPressed({
                agentId: agent.id,
                kind: "routine",
                pattern: "schedule",
                sentence: null,
                via: null,
                hint: null,
              });
              makeRoutine.mutate(briefingInstruction(briefing, t));
            }}
            type="button"
          >
            {makeRoutine.isPending
              ? t("Making the routine…")
              : t("Get a briefing every morning at 7:30")}
          </button>
          {/*
           * WHAT ARRIVES, SAID BEFORE IT IS MADE. The chip used to name the one sentence it repeated
           * (0.5.3 audit, item 12); a briefing is several, composed from what is connected right now,
           * and somebody who connected nothing should not be surprised at 7:30 by what is in it — or
           * by what is not.
           */}
          <p className="text-muted-foreground text-xs">
            {t(
              "What it will have: {contents}. It comes to this conversation, and you can change it on Routines.",
              { contents: briefingContents(briefing, t) },
            )}
          </p>
          {/*
           * The weather is the one section every briefing has, and a routine cannot ask where the
           * shop is (`placeText`, routine mode): without a place it says every morning that it could
           * not look. Said here, where the place can still be given.
           */}
          {placeKnown ? null : (
            <p className="text-muted-foreground text-xs">
              {t("Weather needs your shop's location.")}{" "}
              <Link
                className={`underline underline-offset-2 hover:text-foreground ${focusRing}`}
                to="/settings/shop"
              >
                {t("Add it on My shop")}
              </Link>
            </p>
          )}
          <LiveRegion as="p" className="text-destructive text-xs" tone="alert">
            {makeRoutine.error ? failureSentence(makeRoutine.error) : null}
          </LiveRegion>
        </div>
      )}
      {connects.filter((task) => !task.place).map(connectLink)}
    </section>
  );
};
