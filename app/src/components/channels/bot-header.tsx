import type { ReactNode } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { useBotMood } from "@/lib/agents/bot-mood";
import type { Presence } from "@/lib/agents/presence";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePresence } from "./use-presence";

/**
 * THE BOT AS A PRESENCE AT THE TOP OF ITS CONVERSATION (2026-09-24).
 *
 * It was a 24px face and a name — a list row's worth of identity over the one screen a person spends
 * their day on. Now the face is bigger and alive (its expression follows what the Bot is doing:
 * thinking, out on a site, waiting on the person, glad it finished), and under the name one word says
 * what that is. The word is a pill because it is also the way in to the drawer that says more
 * (`presence-drawer.tsx`).
 *
 * THE WINDOW'S HANDLE. The installed app draws its traffic lights over the page (`titleBarStyle:
 * "Overlay"`), so this row is where the window is dragged from. Tauri only drags from an element that
 * carries `data-tauri-drag-region` itself — not from its children — so the face and the name carry it
 * too, and the pill and the buttons, which are pressed rather than dragged, do not. Inert in a tab.
 *
 * 56px, not the 44 the sidebar's title row is: the face and two lines need it, and the rows do not
 * line up across the column border anyway — the sidebar's top row is the traffic lights' and holds
 * nothing.
 */
export function BotHeader({
  actions,
  agentId,
  avatarSeed,
  lastMessageAt,
  leading,
  name,
  pill,
}: {
  /** The buttons on the right: the screen, the profile. */
  actions?: ReactNode;
  agentId: string | undefined;
  avatarSeed: string | undefined;
  lastMessageAt?: string | undefined;
  /** What comes before the face — the menu button on a phone. */
  leading?: ReactNode;
  name: string | undefined;
  /** The pill, drawn by the caller when it opens something; `PresencePill` otherwise. */
  pill?: (presence: Presence) => ReactNode;
}) {
  const presence = usePresence(agentId);
  const mood = useBotMood({
    working: presence.tone === "active",
    blocked: presence.tone === "attention",
    lastMessageAt,
  });
  // The mood knows "just finished" and "asleep"; the presence knows which kind of busy it is.
  const face = mood === "working" ? presence.face : mood;

  return (
    <header
      className="sticky top-0 z-10 flex h-14 shrink-0 select-none items-center gap-2 bg-background/90 px-3 backdrop-blur-sm"
      data-tauri-drag-region
    >
      {leading}
      <div
        className="flex min-w-0 flex-1 items-center gap-2.5"
        data-tauri-drag-region
      >
        {avatarSeed === undefined ? (
          <span className="size-9 shrink-0 rounded-full bg-muted" />
        ) : (
          <BotAvatar
            className="shrink-0"
            seed={avatarSeed}
            size={36}
            state={face}
          />
        )}
        <div
          className="flex min-w-0 flex-col items-start gap-0.5"
          data-tauri-drag-region
        >
          <h1
            className="max-w-full truncate font-semibold text-base leading-5"
            data-tauri-drag-region
          >
            {name}
          </h1>
          {pill ? pill(presence) : <PresencePill presence={presence} />}
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
      {/*
       * NOT A LIVE REGION, ON PURPOSE. The word changes at every step of a turn — 생각 중, 일하는 중,
       * 답하는 중 — and the two changes that matter are already said where they happen: the approval
       * card and the help card each announce themselves, politely. Announcing the pill too would say
       * every step twice. The word is in the pill's name for whoever moves to it.
       */}
    </header>
  );
}

/** The pill's look per tone. Amber is the person's turn; the Bot's colour is the Bot busy. */
export const PILL_TONES: Readonly<Record<Presence["tone"], string>> = {
  attention: "bg-warning/12 text-warning",
  active: "bg-primary/8 text-link",
  quiet: "bg-muted text-muted-foreground",
};

const DOT_TONES: Readonly<Record<Presence["tone"], string>> = {
  attention: "animate-pulse bg-warning",
  active: "animate-pulse bg-primary",
  quiet: "bg-muted-foreground/50",
};

/** The pill's face: a dot and one word. Shared by the static pill and the drawer's trigger. */
export function PresencePillBody({ presence }: { presence: Presence }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          DOT_TONES[presence.tone],
        )}
      />
      <span className="truncate">{t(presence.label)}</span>
    </>
  );
}

export const PILL_CLASS =
  "inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 font-medium text-xs";

/** The pill where there is nothing to open — before the first conversation exists. */
export function PresencePill({ presence }: { presence: Presence }) {
  return (
    <span className={cn(PILL_CLASS, PILL_TONES[presence.tone])}>
      <PresencePillBody presence={presence} />
    </span>
  );
}
