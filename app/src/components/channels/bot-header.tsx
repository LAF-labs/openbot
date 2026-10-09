import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHeaderSlots } from "@/components/layout/header-slots";
import { t } from "@/lib/i18n";
import { usePresence } from "./use-presence";

/**
 * WHAT A CONVERSATION PUTS IN THE ROW AT THE TOP: ITS BUTTONS, AND WHO IT IS WITH.
 *
 * It was a row of its own — the Bot's name, a dot for what the Bot was doing that opened a drawer
 * saying more, and the buttons for the Bot's screen and its profile (2026-09-24; one quiet row
 * since 2026-10-04; no face since 2026-10-09). The layout has one row across the top now
 * (`layout/app-header.tsx`), and two rows of chrome over one conversation is what the reference
 * does not have, so this draws INTO that row (`layout/header-slots.tsx`) and has none of its own.
 *
 * THE NAME AND THE STATE ARE NOT DRAWN (the user, 2026-10-09: the row's left is empty, as Hark's
 * is). They are still in the document for a screen reader — the page's heading is the Bot's name,
 * and the state is a line beside it — and `data-bot-state` carries the state's word for a test.
 * The drawer the dot opened (지금, 멈추기, 화면 보기) went with the dot: stopping is on the
 * composer while the Bot works, the screen has its button here, and what waits on the person is in
 * the home panel's 오늘.
 *
 * THE WINDOW'S HANDLE is the layout's row, not this.
 */
export function BotHeader({
  actions,
  agentId,
  name,
}: {
  /** The buttons at the right of the row: the Bot's screen, its profile. */
  actions?: ReactNode;
  agentId: string | undefined;
  name: string | undefined;
}) {
  const presence = usePresence(agentId);
  const slots = useHeaderSlots();
  const word = t(presence.label);

  const who = (
    <div className="sr-only" data-bot-state={word}>
      <h1>{name}</h1>
      <p>{word}</p>
    </div>
  );

  /*
   * Drawn without the layout around it — a screen mounted alone — there is no row to draw into, so
   * the buttons stand in a row here rather than nowhere.
   */
  if (!slots) {
    return (
      <header className="flex h-12 shrink-0 select-none items-center justify-end gap-1 px-3">
        {who}
        {actions}
      </header>
    );
  }

  return (
    <>
      {slots.leading ? createPortal(who, slots.leading) : null}
      {slots.actions && actions ? createPortal(actions, slots.actions) : null}
    </>
  );
}
