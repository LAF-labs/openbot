import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHeaderSlots } from "@/components/layout/header-slots";
import type { Presence } from "@/lib/agents/presence";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePresence } from "./use-presence";

/**
 * THE BOT AS A PRESENCE AT THE TOP OF ITS CONVERSATION (2026-09-24).
 *
 * The name, and what the Bot is doing beside it. The state is a pill because it is also the way in
 * to the drawer that says more (`presence-drawer.tsx`).
 *
 * NO FACE (the owner, 2026-10-09). There was one before the name — 24px, its expression following
 * what the Bot was doing — and the Bot has none now: the profile is a name. Nothing the face said
 * is left unsaid, because the dot and its word below already said all of it. A Bot that had just
 * finished looked glad for two seconds and one quiet for half an hour dozed; neither is something
 * the Bot is doing, so neither has a word.
 *
 * THE WINDOW'S HANDLE. The installed app draws its traffic lights over the page (`titleBarStyle:
 * "Overlay"`), so this row is where the window is dragged from. Tauri only drags from an element that
 * carries `data-tauri-drag-region` itself — not from its children — so the name carries it too, and
 * the pill and the buttons, which are pressed rather than dragged, do not. Inert in a tab.
 *
 * ONE QUIET ROW (the owner, 2026-10-04: too many words on the screen). It was 56px with, under the
 * name, a pill that always said a word — "쉬는 중" for most of every day, which tells nobody anything,
 * and "생각 중" while the end of the transcript was already saying so. Now the row is 48px and the
 * state sits beside the name as a dot: grey at rest, the control's colour and pulsing while it
 * works. The word is still the dot's name, for a screen reader and on hover, and the dot still
 * opens the drawer. Only one state keeps its word on the screen — the person's turn
 * (`saysItsWord`).
 *
 * IN THE ROW AT THE TOP, WHERE THERE IS ONE (2026-10-09). The layout has a row of its own now — the
 * home button, the profile button, a phone's 홈 | 채팅 (`app-header.tsx`) — and this one stood
 * directly under it: two rows of chrome over one conversation. So inside the layout the name and
 * the dot are drawn at that row's left and the buttons at its right (`header-slots.tsx`), and no
 * row is drawn here, at any width. Anywhere this is drawn without the layout around it, it is the
 * row it always was.
 */
export function BotHeader({
  actions,
  agentId,
  leading,
  name,
  pill,
}: {
  /** The buttons on the right: the screen, the profile. */
  actions?: ReactNode;
  agentId: string | undefined;
  /** What comes before the name — the menu button on a phone. */
  leading?: ReactNode;
  name: string | undefined;
  /** The pill, drawn by the caller when it opens something; `PresencePill` otherwise. */
  pill?: (presence: Presence) => ReactNode;
}) {
  const presence = usePresence(agentId);
  const slots = useHeaderSlots();

  const identity = (
    <>
      <h1
        className="min-w-0 truncate font-semibold text-sm leading-5"
        data-tauri-drag-region
      >
        {name}
      </h1>
      {pill ? pill(presence) : <PresencePill presence={presence} />}
    </>
  );

  if (slots) {
    return (
      <>
        {slots.leading
          ? createPortal(
              <div
                className="flex min-w-0 items-center gap-2"
                data-bot-identity
                data-tauri-drag-region
              >
                {identity}
              </div>,
              slots.leading,
            )
          : null}
        {slots.actions && actions ? createPortal(actions, slots.actions) : null}
      </>
    );
  }

  return (
    <header
      className="sticky top-0 z-10 flex h-12 shrink-0 select-none items-center gap-2 bg-background/90 px-3 backdrop-blur-sm"
      data-tauri-drag-region
    >
      {leading}
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {identity}
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

/** The pill's look per tone. Amber is the person's turn; the control's colour is the Bot busy. */
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

/**
 * Whether the state is said in a word on the screen, or only shown as a dot.
 *
 * ONLY THE PERSON'S TURN. Amber is the one state somebody has to act on, and a dot alone would not
 * say what is wanted. Resting says nothing a person needs, and working is already said where the
 * work is — the end of the conversation. The word is the dot's name either way.
 */
export function saysItsWord(presence: Presence): boolean {
  return presence.tone === "attention";
}

/** The pill's inside: a dot, and its word where the word is said. Shared with the drawer's trigger. */
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
      {saysItsWord(presence) ? (
        <span className="truncate">{t(presence.label)}</span>
      ) : null}
    </>
  );
}

export const PILL_CLASS =
  "inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 font-medium text-xs";

/** The dot by itself: a 20px place to press or point at, with no plate under it. */
export const DOT_CLASS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full pointer-coarse:size-9";

/** The state's look: the pill where it says its word, the bare dot where it does not. */
export function presenceClass(presence: Presence): string {
  return saysItsWord(presence)
    ? cn(PILL_CLASS, PILL_TONES[presence.tone])
    : DOT_CLASS;
}

/** The state where there is nothing to open — before the first conversation exists. */
export function PresencePill({ presence }: { presence: Presence }) {
  return (
    <span className={presenceClass(presence)} title={t(presence.label)}>
      <PresencePillBody presence={presence} />
      {saysItsWord(presence) ? null : (
        <span className="sr-only">{t(presence.label)}</span>
      )}
    </span>
  );
}
