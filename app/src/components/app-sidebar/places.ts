import {
  IconBox,
  IconClock,
  IconHelp,
  IconNotebook,
  IconPlugConnected,
  IconUserCircle,
} from "@tabler/icons-react";

/**
 * THE PLACES A PERSON GOES TO CHANGE HOW THE BOT WORKS — one list, under the profile button at the
 * top right of every surface (`layout/profile-menu.tsx`). It was drawn twice, at the sidebar's foot
 * and on a phone's 메뉴 page, and held here so the two could not drift; both went on 2026-10-09 and
 * the list stayed where it was. `top-row.test.tsx` walks it in Korean.
 *
 * 연결 IS HERE SINCE 2026-09-24. It lived only under Settings, and with the Bot's own screen gone
 * from the roster the places it signs into are the most-used thing a person sets up. 봇 프로필 is
 * a row for everybody: the menu has no Bot at its top that could be the way to its profile.
 */
export const FOOTER_LINKS = [
  { to: "/agents", icon: IconUserCircle, label: "Bot profile" },
  /*
   * 수첩 (one-bot direction #2): what the Bot knows about the shop and the person, where a wrong
   * line is fixed. Near the top because it is the one place a person checks the Bot believes the
   * right things — the profile no longer lists them.
   */
  { to: "/notebook", icon: IconNotebook, label: "Notebook" },
  { to: "/routines", icon: IconClock, label: "Routines" },
  /*
   * BEHIND ONE 메뉴 ON THE PC SIDEBAR SINCE PHASE 9 (muse-shape plan §4). Phase 5 kept 수첩, 루틴 and
   * 연결 in sight with 스킬 and 도움말 under 더 보기; with the fourth row above (목표), that footer cut
   * the first row of 오늘, which the column still listed then, at 1024×640 — measured, when
   * there was a column to measure — so the whole list moved under one row, the same list
   * the 메뉴 page draws. The row is an icon at the foot since 2026-10-04 and one button with the
   * account's picture since 2026-10-06; the places listed under it are the same.
   */
  { to: "/skills", icon: IconBox, label: "Skills" },
  {
    to: "/settings/connected-accounts",
    icon: IconPlugConnected,
    label: "Connections",
  },
  /*
   * ONE `?`, AT THE BOTTOM. The help page and the 문의·의견 box behind it are the only way a person
   * who is stuck can say so; a way out that lives only under Settings is a way out that a person
   * who does not know where Settings is cannot take. It is one press under the sidebar's 메뉴 —
   * still in the column, never under Settings — and a row of its own on the phone's 메뉴 page.
   */
  { to: "/help", icon: IconHelp, label: "Help" },
] as const;
