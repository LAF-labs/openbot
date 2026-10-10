import { describe, expect, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  createShownGuard,
  pageOriginsIn,
  type ShownRun,
  withoutShown,
} from "../src/logins/shown";

/*
 * A SAVED PASSWORD A PAGE SHOWS BACK, IN ANY RUN (2026-10-10, `docs/laf/redesign-2026-10.md` §6,
 * "실행이 끝난 뒤에는 서버가 한 번 더 거른다"). The Bot's computer forgets what it put in when the run
 * ends; the site's own storage does not, and a later run reads the page with nothing held. The
 * server knows the vault, so it reads what a browser tool hands a model once more.
 *
 * The values here are made up for these tests and are nobody's.
 */
const SHOP = "https://shop.example";
const OTHER = "https://other.example";
const PASSWORD = "tr0ub4dor&3";
const SAID = toolResultText("laf:value_hidden");
const RUN: ShownRun = {
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  toolCallId: "call-1",
};

const saved = (entries: Record<string, string[]>) =>
  new Map(Object.entries(entries));

/** A vault that answers from a table, and says what it was asked. */
function vaultOf(entries: Record<string, string[]>, unreadable: string[] = []) {
  const asked: Array<{ userId: string; addresses: string[] }> = [];
  return {
    asked,
    vault: {
      passwordsAt: async (userId: string, addresses: readonly string[]) => {
        asked.push({ userId, addresses: [...addresses] });
        return {
          shown: new Map(
            addresses.flatMap((address) =>
              entries[address] ? [[address, entries[address]] as const] : [],
            ),
          ),
          unreadable,
        };
      },
    },
  };
}

describe("where an outcome says its pages are", () => {
  test("every address in it, as the origin of a page, once", () => {
    expect(
      pageOriginsIn({
        ok: true,
        url: `${SHOP}/my/page?tab=1`,
        tabs: [
          { index: 0, url: `${SHOP}/my/page?tab=1`, title: "내 정보" },
          { index: 1, url: `${OTHER}/news`, title: "소식" },
        ],
        page: { url: "http://127.0.0.1:4395/next", text: "…" },
      }),
    ).toEqual([SHOP, OTHER, "http://127.0.0.1:4395"]);
  });

  test("a thing with no address, or one that is no page's, has none", () => {
    expect(pageOriginsIn({ ok: true, path: "notes.txt", text: "x" })).toEqual(
      [],
    );
    expect(pageOriginsIn({ ok: true, url: "about:blank" })).toEqual([]);
    expect(
      pageOriginsIn({ ok: true, url: 7, text: `${SHOP}/in/a/sentence` }),
    ).toEqual([]);
    expect(pageOriginsIn("a sentence")).toEqual([]);
  });
});

describe("a saved password in a page's words", () => {
  test("is taken out of the page of the site it was saved for", () => {
    const read = {
      ok: true,
      url: `${SHOP}/welcome`,
      title: `환영합니다 ${PASSWORD}`,
      text: `비밀번호: ${PASSWORD}\n다른 줄`,
    };
    const { outcome, hidden } = withoutShown(
      read,
      saved({ [SHOP]: [PASSWORD] }),
    );
    expect(hidden).toBe(true);
    expect(outcome).toEqual({
      ok: true,
      url: `${SHOP}/welcome`,
      title: "환영합니다 [•••]",
      text: "비밀번호: [•••]\n다른 줄",
    });
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
  });

  /*
   * THE SCOPE IS THE POINT. A password hunted on every page would make hiding it an answer to
   * "is this one of theirs?": a page that lists candidates comes back with one line blanked, and
   * the page's author has only to be told which. On a page of another site the same letters are
   * that page's words.
   */
  test("is left alone on a page of any other site, where hiding it would say what it is", () => {
    const listing = {
      ok: true,
      url: `${OTHER}/common-passwords`,
      text: `1. hunter2\n2. ${PASSWORD}\n3. letmein`,
    };
    const { outcome, hidden } = withoutShown(
      listing,
      saved({ [SHOP]: [PASSWORD] }),
    );
    expect(hidden).toBe(false);
    expect(outcome).toBe(listing);
  });

  test("is judged tab by tab: each by its own address, whatever page the list came with", () => {
    const tabs = [
      { index: 0, url: `${OTHER}/a`, title: `${PASSWORD} — 남의 탭` },
      { index: 1, url: `${SHOP}/b`, title: `${PASSWORD} — 그 사이트의 탭` },
    ];
    // The list rides on a page of another site: the saved site's tab is still its own.
    const onOther = withoutShown(
      { ok: true, url: `${OTHER}/a`, elements: PASSWORD, tabs },
      saved({ [SHOP]: [PASSWORD] }),
    );
    expect(onOther.outcome).toEqual({
      ok: true,
      url: `${OTHER}/a`,
      elements: PASSWORD,
      tabs: [
        tabs[0],
        { index: 1, url: `${SHOP}/b`, title: "[•••] — 그 사이트의 탭" },
      ],
    });
    // And the other way: on the saved site's page, another site's tab keeps its words.
    const onShop = withoutShown(
      { ok: true, url: `${SHOP}/b`, elements: PASSWORD, tabs },
      saved({ [SHOP]: [PASSWORD] }),
    );
    expect(onShop.outcome).toEqual({
      ok: true,
      url: `${SHOP}/b`,
      elements: "[•••]",
      tabs: [
        tabs[0],
        { index: 1, url: `${SHOP}/b`, title: "[•••] — 그 사이트의 탭" },
      ],
    });
  });

  test("is taken out of the page an act arrived at, and of a note riding on the outcome", () => {
    const acted = {
      ok: true,
      action: "click",
      url: `${SHOP}/sign-in`,
      notes: [`경고창이 떴다 (${PASSWORD})`],
      page: { url: `${SHOP}/done`, title: "완료", text: `pw=${PASSWORD}` },
    };
    const { outcome } = withoutShown(acted, saved({ [SHOP]: [PASSWORD] }));
    expect(outcome).toEqual({
      ok: true,
      action: "click",
      url: `${SHOP}/sign-in`,
      notes: ["경고창이 떴다 ([•••])"],
      page: { url: `${SHOP}/done`, title: "완료", text: "pw=[•••]" },
    });
  });

  test("is taken out of an address after its site, and the site is left to be read", () => {
    const { outcome } = withoutShown(
      { ok: true, url: `${SHOP}/reset?pw=${PASSWORD}#x` },
      saved({ [SHOP]: [PASSWORD] }),
    );
    expect(outcome).toEqual({ ok: true, url: `${SHOP}/reset?pw=[•••]#x` });
  });

  test("is not looked for in bytes written as text, nor in a thing with no address", () => {
    const shot = { ok: true, url: `${SHOP}/a`, base64: `AAAA${PASSWORD}AAAA` };
    expect(withoutShown(shot, saved({ [SHOP]: [PASSWORD] })).outcome).toBe(
      shot,
    );
    // A file's text is read to be written back: there is no page it is the words of.
    const file = { ok: true, path: "passwords.txt", text: PASSWORD };
    expect(withoutShown(file, saved({ [SHOP]: [PASSWORD] })).outcome).toBe(
      file,
    );
  });

  test("by the rule the computer hides with: either case, and a number only as a whole number", () => {
    const { outcome } = withoutShown(
      {
        ok: true,
        url: `${SHOP}/a`,
        text: `TR0UB4DOR&3 / PIN 4821 / 14,821원 / 010-4821-0000`,
      },
      saved({ [SHOP]: [PASSWORD, "4821"] }),
    );
    expect((outcome as { text: string }).text).toBe(
      "[•••] / PIN [•••] / 14,821원 / 010-4821-0000",
    );
  });
});

describe("the guard a browser tool's outcome passes on its way to a model", () => {
  test("asks the vault about the pages in the outcome, hides, says so once, and tells whoever keeps pictures", async () => {
    const { vault, asked } = vaultOf({ [SHOP]: [PASSWORD] });
    const seen: Array<[ShownRun, boolean]> = [];
    const guard = createShownGuard({
      logins: vault,
      seen: (run, hidden) => seen.push([run, hidden]),
    });
    const outcome = await guard(RUN, {
      ok: true,
      url: `${SHOP}/welcome`,
      text: `다시 보여 준 값: ${PASSWORD}`,
      notes: ["먼저 있던 말"],
    });
    expect(asked).toEqual([{ userId: "user-1", addresses: [SHOP] }]);
    expect(outcome).toEqual({
      ok: true,
      url: `${SHOP}/welcome`,
      text: "다시 보여 준 값: [•••]",
      notes: ["먼저 있던 말", SAID],
    });
    // The whole of what is handed over, written out: the password is nowhere in it.
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    expect(seen).toEqual([[RUN, true]]);
  });

  test("hands over untouched what holds no saved password, and says that too", async () => {
    const { vault } = vaultOf({ [SHOP]: [PASSWORD] });
    const seen: boolean[] = [];
    const guard = createShownGuard({
      logins: vault,
      seen: (_run, hidden) => seen.push(hidden),
    });
    const plain = { ok: true, url: `${SHOP}/a`, text: "아무 값도 없는 글" };
    expect(await guard(RUN, plain)).toBe(plain);
    const elsewhere = { ok: true, url: `${OTHER}/a`, text: PASSWORD };
    expect(await guard(RUN, elsewhere)).toBe(elsewhere);
    // A failure and a sentence are calls too: a picture is filed under the task's last one.
    const failed = { ok: false, code: "laf:stale_refs", reason: "…" };
    expect(await guard(RUN, failed)).toBe(failed);
    expect(await guard(RUN, "건너뛰었다")).toBe("건너뛰었다");
    expect(seen).toEqual([false, false, false, false]);
  });

  test("what the computer already hid is not said twice, and is not a hit of this server's", async () => {
    const { vault } = vaultOf({ [SHOP]: [PASSWORD] });
    const seen: boolean[] = [];
    const guard = createShownGuard({
      logins: vault,
      seen: (_run, hidden) => seen.push(hidden),
    });
    const already = {
      ok: true,
      url: `${SHOP}/welcome`,
      text: "로그인했습니다: [•••]",
      notes: [SAID],
    };
    expect(await guard(RUN, already)).toBe(already);
    // Both hid something in one outcome: one sentence.
    const both = await guard(RUN, {
      ok: true,
      url: `${SHOP}/welcome`,
      text: `[•••] / ${PASSWORD}`,
      notes: [SAID],
    });
    expect(both).toEqual({
      ok: true,
      url: `${SHOP}/welcome`,
      text: "[•••] / [•••]",
      notes: [SAID],
    });
    expect(seen).toEqual([false, true]);
  });

  test("asks nothing of the vault for an outcome that is at no page, and nothing at all without one", async () => {
    const { vault, asked } = vaultOf({ [SHOP]: [PASSWORD] });
    const guard = createShownGuard({ logins: vault });
    const file = { ok: true, path: "a.txt", text: PASSWORD };
    expect(await guard(RUN, file)).toBe(file);
    expect(asked).toEqual([]);

    const seen: boolean[] = [];
    const none = createShownGuard({
      seen: (_run, hidden) => seen.push(hidden),
    });
    const read = { ok: true, url: `${SHOP}/a`, text: PASSWORD };
    expect(await none(RUN, read)).toBe(read);
    // Nothing was saved, so nothing can be shown back: there is nobody to tell.
    expect(seen).toEqual([]);
  });

  /*
   * NEVER HANDED OVER UNREAD. Both callers answer a throw as a call that failed
   * (`turns/chat-tools.ts`, `runner/unattended.ts`); a guard that passed the outcome on when the
   * vault could not be asked would hide passwords except on the day the database blinked.
   */
  test("throws where the vault cannot be asked, and nobody is told the call was handed over", async () => {
    const seen: boolean[] = [];
    const guard = createShownGuard({
      logins: {
        passwordsAt: async () => {
          throw new Error("the database is away");
        },
      },
      seen: (_run, hidden) => seen.push(hidden),
    });
    await expect(
      guard(RUN, { ok: true, url: `${SHOP}/a`, text: PASSWORD }),
    ).rejects.toThrow("the database is away");
    expect(seen).toEqual([]);
  });

  test("a login this server cannot read hides nothing, and the rest are still looked for", async () => {
    const { vault } = vaultOf({ [SHOP]: [PASSWORD] }, ["login-unreadable"]);
    const guard = createShownGuard({ logins: vault });
    const outcome = await guard(RUN, {
      ok: true,
      url: `${SHOP}/a`,
      text: PASSWORD,
    });
    expect<unknown>(outcome).toEqual({
      ok: true,
      url: `${SHOP}/a`,
      text: "[•••]",
      notes: [SAID],
    });
  });
});
