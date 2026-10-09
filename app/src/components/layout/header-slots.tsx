import { createContext, type ReactNode, useContext, useState } from "react";

/**
 * TWO PLACES IN THE ROW AT THE TOP THAT THE SCREEN UNDER IT FILLS.
 *
 * The row belongs to the layout (`app-header.tsx`): the home button, the switcher, the profile
 * button. The conversation had a row of its own directly under it — the Bot's face, its name, its
 * state, and the button for its screen — and two rows of chrome over one conversation is what the
 * owner's reference does not have. So the conversation's row is drawn INTO the layout's: who the
 * screen is about at the left, what can be done to it at the right, beside the profile button.
 *
 * A PORTAL, NOT PROPS HANDED UP. What goes in these places is the conversation's — its presence,
 * its drawer, whether its browser is in use — read by hooks under the conversation's own seam. A
 * portal keeps it there: it is the conversation's component, with the conversation's context and
 * the conversation's error boundary, drawn somewhere else in the window.
 *
 * THE PLACES ARE ELEMENTS HELD IN STATE, set by the row's callback refs, because a portal needs
 * the node and a ref read while rendering leaves the component uncompiled (CLAUDE.md, "The React
 * Compiler compiles the app").
 */
type Slots = {
  /** At the left, after the home button: who this screen is about. */
  leading: HTMLElement | null;
  /** At the right, before the profile button: what can be done here. */
  actions: HTMLElement | null;
};

type SlotSetters = {
  setLeading: (element: HTMLElement | null) => void;
  setActions: (element: HTMLElement | null) => void;
};

const SlotsContext = createContext<Slots | null>(null);
const SettersContext = createContext<SlotSetters | null>(null);

export function HeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <SettersContext value={{ setLeading, setActions }}>
      <SlotsContext value={{ leading, actions }}>{children}</SlotsContext>
    </SettersContext>
  );
}

/** The places, for a screen that draws into them. Nothing where there is no row to draw into. */
export const useHeaderSlots = (): Slots | null => useContext(SlotsContext);

/** One of the two places, drawn by the row. Empty until a screen fills it. */
export function HeaderSlot({
  className,
  name,
}: {
  className?: string;
  name: keyof Slots;
}) {
  const setters = useContext(SettersContext);
  if (!setters) return null;
  return (
    <div
      className={className}
      data-header-slot={name}
      data-tauri-drag-region
      ref={name === "leading" ? setters.setLeading : setters.setActions}
    />
  );
}
