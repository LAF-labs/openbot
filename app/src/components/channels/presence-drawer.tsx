import { IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useControl } from "@/components/computer/use-control";
import { Button } from "@/components/ui/button";
import { focusRingInset } from "@/components/ui/focus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Presence } from "@/lib/agents/presence";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import {
  describeSubject,
  openQuestionCalls,
  watchQuestions,
} from "@/lib/approvals";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { setScreenOpen } from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { routineListQueryOptions, whenLabel } from "@/lib/routines/queries";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { PILL_CLASS, PILL_TONES, PresencePillBody } from "./bot-header";

/**
 * THE PILL OPENS A DRAWER: WHAT THE BOT IS DOING, WHAT IS WAITING ON THE PERSON, WHAT IS NEXT.
 *
 * The one place that answers "is anything going on?" without scrolling the conversation for it
 * (UI/UX audit 0.5.3, item 18). Three short sections, not tabs — each is a line or three, and tabs
 * would make a person press twice to learn there is nothing waiting.
 *
 * Nothing here is answered in the drawer. An approval is answered on its card, where its reasons,
 * its preview and its scope are; the drawer points there (보기 scrolls to the card and puts the
 * keyboard on its first button). A routine is changed in chat or on the routines screen. The drawer
 * is a map, and a second place to press 허용 would be a second description of one grant.
 *
 * Everything is read from what the app already holds — the tab's open questions, the computer's
 * control state, the banner's task, the routine list and the working poll. No endpoint of its own.
 */
export function PresenceDrawer({
  botId,
  presence,
}: {
  botId: string;
  presence: Presence;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      <PopoverTrigger
        render={
          <button
            aria-label={t("{status}. See what the Bot is doing", {
              status: t(presence.label),
            })}
            className={cn(
              PILL_CLASS,
              PILL_TONES[presence.tone],
              focusRingInset,
              "cursor-pointer transition-[filter] hover:brightness-95 dark:hover:brightness-125",
            )}
            type="button"
          />
        }
      >
        <PresencePillBody presence={presence} />
        <IconChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-70 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 gap-0 p-0 text-sm max-sm:w-[calc(100vw-24px)]"
      >
        <DrawerBody
          botId={botId}
          onClose={() => setIsOpen(false)}
          presence={presence}
        />
      </PopoverContent>
    </Popover>
  );
}

function DrawerBody({
  botId,
  onClose,
  presence,
}: {
  botId: string;
  onClose: () => void;
  presence: Presence;
}) {
  const now = useNow();
  const browsing = useBrowsingNow();
  const task = browsing.task?.botId === botId ? browsing.task : null;
  const working = useQuery(workingQueryOptions());
  const routineRun = working.data?.find(
    (run) => run.agentId === botId && run.origin === "routine",
  );
  const control = useControl(botId, false);
  /*
   * The questions as one string, so the snapshot is a value React can compare: a fresh array from
   * `openQuestionCalls()` on every read would be a new snapshot every time and render forever.
   */
  const asking = useSyncExternalStore(
    watchQuestions,
    () => questionsKey(botId),
    () => "[]",
  );
  const questions = JSON.parse(asking) as [string, string][];
  const routines = useQuery(routineListQueryOptions());
  const upcoming = (routines.data ?? [])
    .filter((routine) => routine.agentId === botId && routine.enabled)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
    .slice(0, 3);
  const helpWanted =
    control !== null &&
    (control.requested || control.secretWanted !== undefined);

  /** Close, then take the person to the card and the keyboard to its first button. */
  const handleShow = (selector: string) => {
    onClose();
    requestAnimationFrame(() => {
      const card = [...document.querySelectorAll<HTMLElement>(selector)].at(-1);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
  };

  const doing = task
    ? [task.sites.at(-1), task.doing].filter(Boolean).join(" · ")
    : routineRun
      ? workingLabel(routineRun)
      : presence.tone === "active"
        ? t(presence.label)
        : null;

  return (
    <div className="flex flex-col divide-y divide-border">
      <DrawerSection title={t("Now")}>
        {doing ? (
          <DrawerRow
            action={
              task ? (
                <Button
                  onClick={() => {
                    onClose();
                    setScreenOpen(true);
                  }}
                  size="xs"
                  variant="secondary"
                >
                  {t("View screen")}
                </Button>
              ) : null
            }
            dot="active"
            text={doing}
          />
        ) : (
          <DrawerEmpty>{t("Nothing going on right now.")}</DrawerEmpty>
        )}
      </DrawerSection>

      <DrawerSection title={t("Your turn")}>
        {questions.length === 0 && !helpWanted ? (
          <DrawerEmpty>{t("Nothing is waiting for you.")}</DrawerEmpty>
        ) : null}
        {questions.map(([toolCallId, question]) => (
          <DrawerRow
            action={
              <Button
                onClick={() =>
                  handleShow(`[data-waiting-card="${CSS.escape(toolCallId)}"]`)
                }
                size="xs"
                variant="secondary"
              >
                {t("Show me")}
              </Button>
            }
            dot="attention"
            key={toolCallId}
            text={question}
          />
        ))}
        {helpWanted ? (
          <DrawerRow
            action={
              <Button
                onClick={() => handleShow('[data-waiting-card="help"]')}
                size="xs"
                variant="secondary"
              >
                {t("Show me")}
              </Button>
            }
            dot="attention"
            text={control?.reason?.trim() || t("The Bot needs your help")}
          />
        ) : null}
      </DrawerSection>

      <DrawerSection title={t("Next routines")}>
        {upcoming.length === 0 ? (
          <DrawerEmpty>{t("No routines coming up.")}</DrawerEmpty>
        ) : (
          upcoming.map((routine) => (
            <DrawerRow
              detail={whenLabel(routine.nextRunAt, now)}
              key={routine.id}
              text={routine.name}
            />
          ))
        )}
        <Link
          className={cn(
            "mt-1 self-start rounded-sm font-medium text-link text-xs underline-offset-4 hover:underline",
            focusRingInset,
          )}
          onClick={onClose}
          to="/routines"
        >
          {t("See all routines")}
        </Link>
      </DrawerSection>
    </div>
  );
}

function questionsKey(botId: string): string {
  return JSON.stringify(
    openQuestionCalls()
      .filter(({ question }) => question.botId === botId)
      .map(({ toolCallId, question }) => [
        toolCallId,
        question.subject
          ? describeSubject(question.subject)
          : t(
              "It is waiting on an answer about something this screen cannot name.",
            ),
      ]),
  );
}

function DrawerSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-1.5 px-3.5 py-3">
      <h2 className="font-medium text-muted-foreground text-xs">{title}</h2>
      {children}
    </section>
  );
}

function DrawerRow({
  action,
  detail,
  dot,
  text,
}: {
  action?: ReactNode;
  detail?: string;
  dot?: "active" | "attention";
  text: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {dot ? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.75 size-1.5 shrink-0 rounded-full",
            dot === "attention" ? "bg-warning" : "bg-primary",
          )}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="wrap-break-word text-sm">{text}</p>
        {detail ? (
          <p className="text-muted-foreground text-xs tabular-nums">{detail}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function DrawerEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
