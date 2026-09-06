import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { focusRing } from "@/components/ui/focus";
import {
  type FirstTask,
  makeMorningReport,
  reportFirstTaskPressed,
  routineSentence,
} from "@/lib/agents/first-tasks";
import type { WorkPatternId } from "@/lib/agents/presets";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { routineKeys } from "@/lib/routines/queries";

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
  hint,
  onAsk,
  tasks,
}: {
  agent: AgentProfile;
  /** A first message is already on its way; a second chip must not start a second channel. */
  disabled: boolean;
  /** What the Bot's card suggested, recorded beside each press so the two can be compared. */
  hint: WorkPatternId | null;
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

  return (
    <section
      aria-label={t("Try one of these first")}
      className="flex w-full max-w-md flex-col gap-2 text-left"
    >
      <p className="text-muted-foreground text-xs">
        {t("Try one of these first")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {tasks.map((task) =>
          task.kind === "connect" ? (
            <Link
              className={chip}
              key="connect"
              onClick={() =>
                reportFirstTaskPressed({
                  agentId: agent.id,
                  kind: "connect",
                  pattern: null,
                  sentence: null,
                  via: null,
                  hint,
                })
              }
              to="/settings/connected-accounts"
            >
              {t("Connect a site")}
            </Link>
          ) : (
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
                  hint,
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
        makeRoutine.isSuccess ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("The routine is made.")}
            {" · "}
            <Link
              className={`underline underline-offset-2 hover:text-foreground ${focusRing}`}
              to="/routines"
            >
              {t("See it on Routines")}
            </Link>
          </p>
        ) : (
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
                  hint,
                });
                makeRoutine.mutate(t(sentence));
              }}
              type="button"
            >
              {makeRoutine.isPending
                ? t("Making the routine…")
                : t("Get a report every morning at 7:30")}
            </button>
            <p className="text-muted-foreground text-xs">
              {t(
                "The first sentence above, asked every morning at 7:30, answered in this conversation.",
              )}
            </p>
            {makeRoutine.error ? (
              <p className="text-destructive text-xs" role="alert">
                {makeRoutine.error.message}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
};
