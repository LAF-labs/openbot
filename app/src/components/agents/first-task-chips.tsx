import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LiveRegion } from "@/components/layout/live-region";
import { focusRing } from "@/components/ui/focus";
import {
  type FirstTask,
  makeMorningReport,
  reportFirstTaskPressed,
  routineSentence,
} from "@/lib/agents/first-tasks";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { failureSentence } from "@/lib/press";
import { routineKeys } from "@/lib/routines/queries";
import { dailyPlaceById } from "@/lib/shop/catalogue";

/**
 * THE FIRST THING TO ASK, AS SOMETHING TO PRESS.
 *
 * Four sentences, a way to the 연결 screen when nothing is connected, and a chip that makes the
 * first sentence a morning routine. It sits under the intro card on a new Bot's empty
 * conversation: the card decides what the Bot is, these decide what it does first. A sentence a
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
  disabled,
  onAsk,
  tasks,
}: {
  agent: AgentProfile;
  /** A first message is already on its way; a second chip must not start a second channel. */
  disabled: boolean;
  onAsk: (sentence: string) => void;
  tasks: readonly FirstTask[];
}) => {
  const queryClient = useQueryClient();
  const sentence = routineSentence(tasks);
  const leading = tasks.find((task) => task.kind === "ask");
  const makeRoutine = useMutation({
    mutationFn: (instruction: string) =>
      makeMorningReport({
        agentId: agent.id,
        instruction,
        name: t("Morning report"),
        // The person's own clock, the way the Routines page reads it: 7:30 means 7:30 here.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });

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
      {sentence && leading?.kind === "ask" ? (
        <>
          {/*
           * Mounted with the chip it answers, so 루틴을 만들었습니다 is heard when it is said: drawn
           * only on success, the line arrived with its region and was never read out.
           */}
          <LiveRegion as="p" className="text-sm text-muted-foreground">
            {makeRoutine.isSuccess ? (
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
          {makeRoutine.isSuccess ? null : (
            <div className="flex flex-col gap-1">
              <button
                className={`${chip} self-start`}
                disabled={makeRoutine.isPending}
                onClick={() => {
                  reportFirstTaskPressed({
                    agentId: agent.id,
                    kind: "routine",
                    pattern: leading.pattern,
                    sentence,
                    via: leading.via,
                    hint: null,
                  });
                  makeRoutine.mutate(t(sentence));
                }}
                type="button"
              >
                {/*
                 * WHAT ARRIVES, NAMED ON THE CHIP. It said "매일 아침 7:30에 보고받기" over "위의 첫
                 * 문장을 매일 아침 7:30에 물어보고", and which sentence was "the first one above" took
                 * a second reading to find (0.5.3 audit, item 12). The sentence itself is the name.
                 */}
                {makeRoutine.isPending
                  ? t("Making the routine…")
                  : t("Get “{task}” every morning at 7:30", {
                      task: t(sentence),
                    })}
              </button>
              <p className="text-muted-foreground text-xs">
                {t(
                  "Your Bot is asked this every morning at 7:30 and answers in this conversation.",
                )}
              </p>
              <LiveRegion
                as="p"
                className="text-destructive text-xs"
                tone="alert"
              >
                {makeRoutine.error ? failureSentence(makeRoutine.error) : null}
              </LiveRegion>
            </div>
          )}
        </>
      ) : null}
      {connects.filter((task) => !task.place).map(connectLink)}
    </section>
  );
};
