import {
  IconBox,
  IconClock,
  IconHelp,
  IconNotebook,
  IconPlugConnected,
  IconUserCircle,
} from "@tabler/icons-react";

/**
 * THE PLACES A PERSON GOES TO CHANGE HOW THE BOT WORKS — one list, drawn twice: the PC sidebar's
 * footer and the phone's 메뉴 page (`/menu`). Held here so the two cannot drift; `phone-nav.test.tsx`
 * holds them equal.
 *
 * 연결 IS HERE SINCE 2026-09-24. It lived only under Settings, and with the Bot's own screen gone
 * from the roster the places it signs into are the most-used thing a person sets up. 봇 프로필 is
 * drawn only for an account with several Bots: with one, the Bot at the top of the column (or of
 * the 메뉴 page) is the way to its profile, and the same link twice is a list padding itself out.
 */
export const FOOTER_LINKS = [
  { to: "/agents", icon: IconUserCircle, label: "Bot profile", primary: true },
  /*
   * 수첩 (one-bot direction #2): what the Bot knows about the shop and the person, where a wrong
   * line is fixed. Near the top because it is the one place a person checks the Bot believes the
   * right things — the profile no longer lists them.
   */
  { to: "/notebook", icon: IconNotebook, label: "Notebook", primary: true },
  { to: "/routines", icon: IconClock, label: "Routines", primary: true },
  /*
   * 스킬 AND 도움말 GO UNDER 더 보기 ON THE PC SIDEBAR (muse-shape plan §4, phase 5). The rows above the
   * footer grew by 아이디어 and will grow by three more, and at the PC app's smallest window (1024×640)
   * every row the footer keeps is a row 오늘 loses. 수첩, 루틴 and 연결 stay in sight because they are
   * the ones a person comes back to; the 메뉴 page lists all of them, `primary` or not.
   */
  { to: "/skills", icon: IconBox, label: "Skills", primary: false },
  {
    to: "/settings/connected-accounts",
    icon: IconPlugConnected,
    label: "Connections",
    primary: true,
  },
  /*
   * ONE `?`, AT THE BOTTOM. The help page and the 문의·의견 box behind it are the only way a person
   * who is stuck can say so; a way out that lives only under Settings is a way out that a person
   * who does not know where Settings is cannot take. Since phase 5 it is one press under the
   * sidebar's 더 보기 — still in the column, never under Settings — and a row of its own on 메뉴.
   */
  { to: "/help", icon: IconHelp, label: "Help", primary: false },
] as const;

export type FooterLink = (typeof FOOTER_LINKS)[number];

/** The links an account draws: 봇 프로필 only with several Bots, for the reason above. */
export function footerLinksFor(isLegacy: boolean): FooterLink[] {
  return FOOTER_LINKS.filter((link) => isLegacy || link.to !== "/agents");
}
