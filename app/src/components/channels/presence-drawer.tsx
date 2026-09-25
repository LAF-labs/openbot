import { IconChevronDown, IconPlayerStopFilled } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { Button } from "@/components/ui/button";
import { focusRingInset } from "@/components/ui/focus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMyBots } from "@/lib/agents/my-bots";
import type { Presence } from "@/lib/agents/presence";
import {
  workingKeys,
  workingLabel,
  workingQueryOptions,
} from "@/lib/agents/working";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { setScreenOpen } from "@/lib/computer/screen-panel";
import { stopHeldChats } from "@/lib/copilot/held-chats";
import { t } from "@/lib/i18n";
import { useIsWideViewport } from "@/lib/use-wide-viewport";
import { cn } from "@/lib/utils";
import { pressStopAll, stopEverything } from "@/lib/work/stop-all";
import { PILL_CLASS, PILL_TONES, PresencePillBody } from "./bot-header";

/**
 * THE PILL OPENS A DRAWER: WHAT THE BOT IS DOING, WHAT IS WAITING ON THE PERSON, WHAT IS NEXT.
 *
 * The one place that answers "is anything going on?" without scrolling the conversation for it
 * (UI/UX audit 0.5.3, item 18). Short sections, not tabs — each is a line or three, and tabs
 * would make a person press twice to learn there is nothing waiting.
 *
 * Nothing here is answered in the drawer. An approval is answered on its card, where its reasons,
 * its preview and its scope are; the drawer points there (the row scrolls to the card and puts the
 * keyboard on its first button). A routine is changed in chat or on the routines screen. The drawer
 * is a map, and a second place to press 허용 would be a second description of one grant.
 *
 * "지금" is read from what the app already holds — the banner's task and the working poll. Everything
 * under it is 오늘, the sidebar's own component (`app-sidebar/bot-day.tsx`), since 2026-09-25: the
 * pill and the sidebar showed the same waiting and the same next routines from two copies of the
 * same code, and one copy is how they stay the same.
 *
 * ON THE PC APP, ONLY WHAT THE SIDEBAR DOES NOT SAY (2026-09-25, UX review 0.5.4 item 12): 지금, with
 * a Stop beside it, and 기다리는 일. The full column beside it already shows 한 일 and 다음, and the
 * drawer repeated them word for word. Below `lg` the column is a rail or a sheet that is away, and the
 * drawer shows the whole day.
 *
 * STOP IS HERE, BESIDE WHAT IS BEING DONE (item 17). It lived only in the account menu, as 모두 멈추기,
 * and 지금 said what the Bot was doing with no way to make it stop. It is the same stop — this window's
 * conversation first, then the server's runs, routines included (`pressStopAll`) — because a person
 * has one Bot and "stop what it is doing" is all of it. An account from before the cap, with several
 * Bots, does not get it here: the one button would stop the others too, and 모두 멈추기 says so.
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
        className="max-h-[min(70vh,560px)] w-80 gap-0 overflow-y-auto p-0 text-sm max-sm:w-[calc(100vw-24px)]"
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
  const browsing = useBrowsingNow();
  const task = browsing.task?.botId === botId ? browsing.task : null;
  const working = useQuery(workingQueryOptions());
  const routineRun = working.data?.find(
    (run) => run.agentId === botId && run.origin === "routine",
  );

  const doing = task
    ? [task.sites.at(-1), task.doing].filter(Boolean).join(" · ")
    : routineRun
      ? workingLabel(routineRun)
      : presence.tone === "active"
        ? t(presence.label)
        : null;
  const isWide = useIsWideViewport();
  const mine = useMyBots();
  const isOnlyBot = (mine.bots?.length ?? 0) <= 1;
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: () =>
      pressStopAll({ stopHere: stopHeldChats, stopServer: stopEverything }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workingKeys.all });
    },
  });
  const canStop = doing !== null && isOnlyBot;

  return (
    <div className="flex flex-col divide-y divide-border">
      <section className="flex flex-col gap-1.5 px-3.5 py-3">
        <h2 className="font-medium text-muted-foreground text-xs">
          {t("Now")}
        </h2>
        {doing ? (
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.75 size-1.5 shrink-0 rounded-full bg-primary"
            />
            <p className="wrap-break-word min-w-0 flex-1 text-sm">{doing}</p>
            {canStop ? (
              <Button
                aria-label={t("Stop the Bot")}
                className="shrink-0"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
                size="xs"
                variant="destructive"
              >
                <IconPlayerStopFilled />
                {t("Stop")}
              </Button>
            ) : null}
            {task ? (
              <Button
                className="shrink-0"
                onClick={() => {
                  onClose();
                  setScreenOpen(true);
                }}
                size="xs"
                variant="secondary"
              >
                {t("View screen")}
              </Button>
            ) : null}
          </div>
        ) : (
          <DrawerEmpty>{t("Nothing going on right now.")}</DrawerEmpty>
        )}
      </section>
      <BotDay
        botId={botId}
        onLeave={onClose}
        placement="drawer"
        waitingOnly={isWide}
      />
    </div>
  );
}

function DrawerEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
