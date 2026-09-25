import { IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { Button } from "@/components/ui/button";
import { focusRingInset } from "@/components/ui/focus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Presence } from "@/lib/agents/presence";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { setScreenOpen } from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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
      <BotDay botId={botId} onLeave={onClose} placement="drawer" />
    </div>
  );
}

function DrawerEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
