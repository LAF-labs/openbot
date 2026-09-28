import type { Persona } from "@shared/persona";
import type { ShopProfile } from "@shared/shop/catalogue";
import { siteIsForThisShop, sitesInShopOrder } from "@/lib/shop/catalogue";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";

/**
 * The few connections the first conversation offers, in the order this person would reach for them.
 *
 * THE ANSWER ORDERS, IT NEVER CHOOSES WHAT EXISTS. Every id below is on 연결 for everybody, and the
 * step that draws these links there for the rest (CLAUDE.md: the persona is a hint, never a gate). A
 * 사장님 who studies is offered the same Canva and Calendar a student is; the student simply sees
 * them first.
 *
 * WHY THESE. Each is something the Bot can do on the person's own account the minute it is on:
 * a 학생's 일정 and 필기, a 직장인's 메일 and 일정, a 사장님's own 배달·예약 sites. Canva is in every
 * list because a 발표 자료, a 보고서 표지 and a 메뉴판 are the same tool.
 */
const LEAD: Readonly<Record<Persona, readonly string[]>> = {
  student: ["google-calendar", "notion", "canva", "google-drive", "gmail"],
  worker: ["gmail", "google-calendar", "notion", "google-sheets", "canva"],
  owner: ["canva", "google-calendar", "gmail", "google-sheets"],
  other: ["google-calendar", "gmail", "canva", "notion"],
};

/** How many the step shows. Three is a question somebody answers; ten is a settings page. */
export const SUGGESTED_COUNT = 3;

/**
 * The ids to offer, most likely first, before the deployment has said which it has — the caller
 * keeps the ones its overview knows and takes {@link SUGGESTED_COUNT}.
 *
 * A 사장님 leads with the sites of their own kind of shop (the same rule 연결 uses to put them first),
 * at most two, because the delivery app a restaurant lives in is worth more to it than any account.
 */
export function suggestedConnections(
  persona: Persona,
  shop: Pick<ShopProfile, "kind" | "places">,
): string[] {
  const sites =
    persona === "owner"
      ? sitesInShopOrder(BUSINESS_SITES, shop)
          .filter((site) => siteIsForThisShop(site.id, shop))
          .slice(0, 2)
          .map((site) => site.id)
      : [];
  return [...sites, ...LEAD[persona]];
}
