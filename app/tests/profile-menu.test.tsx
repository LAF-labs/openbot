import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { footerLinksFor } from "../src/components/app-sidebar/places";
import { ko } from "../src/lib/i18n-ko";
import type { ProfileMenuShown } from "./support/profile-menu-render";

/*
 * THE MENU BEHIND THE PERSON'S PICTURE (2026-10-10, `docs/laf/redesign-2026-10.md` §1, piece 3-1).
 *
 * The column at the left of the window is gone, and everything it led to is one list a press
 * away: stopping, where the Bot's work is read, the places that change how it works, what is about
 * the account, and leaving. What the list holds is read in a process of its own, in Korean, with
 * the button really pressed (`support/profile-menu-render.tsx` says why it cannot be opened here).
 */
let rendering: Promise<ProfileMenuShown> | undefined;
function rendered(): Promise<ProfileMenuShown> {
  rendering ??= render();
  return rendering;
}

async function render(): Promise<ProfileMenuShown> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/profile-menu-render.tsx")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("PROFILE_MENU "));
  if (status !== 0 || !line) {
    throw new Error(
      `the menu's render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("PROFILE_MENU ".length)) as ProfileMenuShown;
}

const places = (isLegacy: boolean) =>
  footerLinksFor(isLegacy).map((link) => link.to as string);
const wentTo = (items: [string, string | null][]) => items.map(([, to]) => to);

describe("the menu behind the person's picture", () => {
  test("is named 메뉴 and for whom, and draws no word: the picture's one letter is all its text", async () => {
    const { quiet } = await rendered();
    expect(quiet.button.label).toBe("메뉴 · 김기범 · kim@example.com");
    expect(quiet.button.title).toBe(quiet.button.label);
    expect(quiet.button.text).toBe("김");
    expect(quiet.button.hasMark).toBe(false);
  }, 30_000);

  /*
   * THE ORDER. 모두 멈추기 first, because it is the one item somebody reaches for in a hurry;
   * then where the Bot's work is read, in the order the column had it; then the places that
   * change how it works — the same list the 메뉴 page draws, held equal by `places.ts`; then what
   * is about the account; and leaving, last.
   */
  test("one list: stopping first, where the work is read, the places that change how it works, the account's, and leaving last", async () => {
    const { quiet } = await rendered();
    expect(wentTo(quiet.items)).toEqual([
      null,
      "/channel/c-1",
      "/feed",
      "/ideas",
      "/goals",
      "/made",
      ...places(false),
      "/settings",
      null,
    ]);
    expect(quiet.items.map(([name]) => name)).toEqual([
      "모두 멈추기",
      "대화",
      "소식",
      "아이디어",
      "목표",
      "만든 것",
      "수첩",
      "루틴",
      "스킬",
      "연결",
      "계정",
      "도움말",
      "설정",
      "로그아웃",
    ]);
    // With one Bot there is no list of Bots and no second way to its profile.
    expect(quiet.labels).toEqual([]);
    expect(wentTo(quiet.items)).not.toContain("/agents");
  }, 30_000);

  test("계정 is among the places, beside 연결, and has its Korean", async () => {
    const all = places(false);
    expect(all.indexOf("/settings/logins")).toBe(
      all.indexOf("/settings/connected-accounts") + 1,
    );
    expect(ko.Accounts).toBe("계정");
    /*
     * The table is read as `t(place.label)`, which the coverage test cannot see (CLAUDE.md,
     * "Korean is not optional"): every label in it, the legacy one included, has its Korean.
     */
    const words: Record<string, string> = ko;
    for (const link of footerLinksFor(true)) {
      expect([link.label, typeof words[link.label]]).toEqual([
        link.label,
        "string",
      ]);
    }
  });

  /*
   * WHAT THE COLUMN SAID WITHOUT BEING OPENED. 소식's count and the conversation's unread mark
   * were in sight on every screen, and a closed menu shows neither — so the button wears one mark
   * while either has something new, its name says so, and the item inside says which.
   */
  test("something new is one mark on the button, said in its name, and the item inside says what", async () => {
    const { oneBot } = await rendered();
    expect(oneBot.button.hasMark).toBe(true);
    expect(oneBot.button.label).toBe(
      "메뉴 · 김기범 · kim@example.com · 새로 온 것 있음",
    );
    const named = Object.fromEntries(
      oneBot.items.map(([name, to]) => [to ?? name, name]),
    );
    expect(named["/channel/c-1"]).toBe("대화읽지 않음");
    expect(named["/feed"]).toBe("소식3새 소식 3개");
    // 목표's number is what is being worked on, not something new: it is there, quietly.
    expect(named["/goals"]).toBe("목표2진행 중인 목표 2개");
    expect(ko["Something new"]).toBe("새로 온 것 있음");
  }, 30_000);

  /*
   * AN ACCOUNT FROM BEFORE THE CAP keeps every Bot it had, hidden ones too, and reaches each from
   * here: one item a Bot, opening that Bot's conversation, in place of the single 대화.
   */
  test("an account with several Bots lists each under 내 봇들, opening its own conversation, and has the way to their profiles", async () => {
    const { several } = await rendered();
    expect(several.labels).toEqual(["내 봇들"]);
    expect(several.items.slice(0, 4)).toEqual([
      ["모두 멈추기", null],
      ["초롱", "/channel/c-1"],
      // Unread, said on the Bot it is unread for.
      ["두리읽지 않음", "/channel/c-2"],
      // Nobody has spoken to the hidden one: it opens the empty conversation, by its id.
      ["세모", "/channel/new?agent=bot-3"],
    ]);
    expect(several.items.map(([name]) => name)).not.toContain("대화");
    expect(wentTo(several.items)).toEqual([
      null,
      "/channel/c-1",
      "/channel/c-2",
      "/channel/new?agent=bot-3",
      "/feed",
      "/ideas",
      "/goals",
      "/made",
      ...places(true),
      "/settings",
      null,
    ]);
    expect(places(true)).toContain("/agents");
    // One of them has something unread: the one mark on the button.
    expect(several.button.hasMark).toBe(true);
  }, 30_000);

  test("an administrator has 관리 before 설정, and nobody else has it", async () => {
    const { admin, quiet } = await rendered();
    const to = wentTo(admin.items);
    expect(to.indexOf("/admin")).toBe(to.indexOf("/settings") - 1);
    expect(wentTo(quiet.items)).not.toContain("/admin");
  }, 30_000);
});
