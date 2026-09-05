import { t } from "@/lib/i18n";
import type { AgentProfile } from "./queries";
import { type Seats, seatsFullMessage } from "./seats";

/**
 * WHAT THE ⋯ MENU OFFERS, DECIDED AWAY FROM THE MARKUP.
 *
 * Four verbs, three of them conditional, and the conditions are the part worth being sure about: a
 * Bot the deployment shipped must not offer Edit, Duplicate or Delete — the server refuses all
 * three and an affordance that only ever fails is a promise the screen cannot keep — and Duplicate
 * has to say which seat it is about to spend before it spends it.
 *
 * Hide is the one item everybody gets, including on a Bot they cannot manage: hiding is a fact
 * about the reader's own list rather than about the Bot.
 */
export type BotMenuItem = {
  id: "edit" | "hide" | "duplicate" | "delete";
  label: string;
  /** The consequence, under the name. Nobody knew what Hide did until they had pressed it. */
  description: string;
  disabled?: boolean;
  destructive?: boolean;
};

export function botMenuItems(
  profile: Pick<AgentProfile, "canManage" | "hidden">,
  seats: Seats,
): BotMenuItem[] {
  const items: BotMenuItem[] = [];
  if (profile.canManage) {
    items.push({
      description: t("Its name and what it does."),
      id: "edit",
      label: t("Edit profile"),
    });
  }
  items.push({
    description: profile.hidden
      ? t("Put it back on your Bot list.")
      : t("Off your Bot list. It keeps working, and keeps its seat."),
    id: "hide",
    label: profile.hidden ? t("Unhide") : t("Hide"),
  });
  if (profile.canManage) {
    items.push({
      description: seats.isFull
        ? seatsFullMessage(seats)
        : seats.isLastSeat
          ? t("A copy with the same settings. It takes your last seat.")
          : t("A copy with the same settings. It takes a seat."),
      disabled: seats.isFull,
      id: "duplicate",
      label: t("Duplicate"),
    });
    items.push({
      description: t("It asks first. There is no undo."),
      destructive: true,
      id: "delete",
      label: t("Delete"),
    });
  }
  return items;
}
