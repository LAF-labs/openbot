import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import type { PluginSkill } from "../src/lib/plugins/queries";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  CURRENT_USER,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE SKILLS PAGE: what a failed read says, and what a row calls a skill.
 *
 * `pluginsPageQueryOptions` was destructured for `data` and `isPending`, so `isError` had nowhere
 * to go and a 500 landed in the same branch as an empty list: 아직 스킬이 없습니다, in front of
 * somebody whose skills are all still on the server. That is the same failure the agents roster and
 * Routines each had and each fixed; this is the third one.
 *
 * And the row menu offered `/danggeun-reply 삭제` — a slug in the middle of a Korean sentence, and
 * the one part of a skill its author did not choose the wording of.
 *
 * Each state is produced by answering `/api/plugins` differently and reading the screen, rather than
 * by looking for `isError` in the source: the guard this file exists for is one line, and a walk
 * that finds the word cannot tell whether the branch it guards is the one that is drawn.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

// A shop's example since 2026-09-24 (UI/UX audit 0.5.3, item 11), not "any Bot you own".
const NONE_YET =
  "Nothing saved yet. Save something you ask for often, like a polite reply to a new review.";
const FAILED = "Your skills could not be loaded.";

function skill(
  overrides: Partial<PluginSkill> & { slug: string },
): PluginSkill {
  return {
    id: `skill-${overrides.slug}`,
    ownerUserId: CURRENT_USER.id,
    title: overrides.slug,
    summary: "",
    instructions: "",
    origin: "personal",
    installedBy: null,
    grantedTo: [],
    ...overrides,
  };
}

/** The page, with `/api/plugins` answered as the test says and everything else as the shell does. */
async function skillsPage(plugins: ApiAnswer, path = "/skills") {
  const view = await mountApp({
    path,
    api: (request) =>
      request.pathname === "/api/plugins" ? plugins(request) : undefined,
  });
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  return {
    ...view,
    main,
    /** How often the list has been asked for. Refetches share the path; nothing else does. */
    listReads: () =>
      view.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/api/plugins",
      ).length,
    /*
     * The alert that is SAYING something. Its region is mounted before it speaks (`LiveRegion`), so
     * it is on the page, empty, in every state; what a person hears is whether it has words.
     */
    alert: () =>
      [...main.querySelectorAll('[role="alert"]')].find((alert) =>
        alert.textContent?.trim(),
      ) ?? null,
    section: (title: string) => {
      const heading = [...main.querySelectorAll("h2")].find(
        (h2) => h2.textContent === title,
      );
      const section = heading?.closest("section");
      if (!section) throw new Error(`no section titled ${title}`);
      return section;
    },
  };
}

describe("a read that failed", () => {
  test("says so, and offers the press that tries again", async () => {
    const view = await skillsPage(() => json({ error: "boom" }, 500));
    expect(view.alert()?.textContent).toBe(FAILED);
    expect(view.buttonNamed("Try again")).toBeDefined();
    expect(ko[FAILED]).toBeTruthy();
    await view.unmount();
  });

  test("the press asks the server again, and the answer replaces the alert", async () => {
    let failing = true;
    const view = await skillsPage(() =>
      failing
        ? json({ error: "boom" }, 500)
        : json({ catalogue: [], servers: [], skills: [] }),
    );
    expect(view.listReads()).toBe(1);

    failing = false;
    const again = view.buttonNamed("Try again");
    if (!again) throw new Error("no Try again button");
    await view.click(again);
    await view.waitFor(() => view.alert() === null, "the alert to clear");

    expect(view.listReads()).toBe(2);
    expect(view.main.textContent).toContain(NONE_YET);
    await view.unmount();
  });

  test('never says "no skills yet" about a read that failed', async () => {
    /*
     * The guard is the whole fix. "You have not written one" is a claim about the person, and it
     * was being made by a dropped connection.
     */
    const view = await skillsPage(() => json({ error: "boom" }, 500));
    expect(view.main.textContent).not.toContain(NONE_YET);
    await view.unmount();
  });
});

describe("a read still in flight", () => {
  test("holds the rows' place with a placeholder, and claims nothing", async () => {
    // Routines and the roster both hold their space; this page drew a section title over a void.
    const view = await skillsPage(() => new Promise<Response>(() => {}));
    const yours = view.section("Your skills");
    expect(
      yours.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(view.main.textContent).not.toContain(NONE_YET);
    expect(view.alert()).toBeNull();
    await view.unmount();
  });
});

describe("nothing written yet", () => {
  test("says so, once the server has actually answered", async () => {
    const view = await skillsPage(() =>
      json({ catalogue: [], servers: [], skills: [] }),
    );
    expect(view.section("Your skills").textContent).toContain(NONE_YET);
    expect(
      view.section("Your skills").querySelector('[data-slot="skeleton"]'),
    ).toBeNull();
    expect(ko[NONE_YET]).toBeTruthy();
    await view.unmount();
  });
});

describe("a skill's row", () => {
  const mine = skill({
    slug: "danggeun-reply",
    title: "당근 답장",
    summary: "당근마켓 문의에 답하기",
  });
  const answer = () =>
    json({
      catalogue: [],
      servers: [],
      skills: [
        mine,
        skill({ slug: "standup", title: "Standup notes", ownerUserId: null }),
      ],
    });

  test("is named by its title in the menu, never by its slug", async () => {
    const view = await skillsPage(answer);
    const yours = view.section("Your skills");
    expect(yours.textContent).toContain("당근 답장");
    // A screen reader saying "actions for slash danggeun hyphen reply" is reading a URL out loud.
    expect(
      yours.querySelector('button[aria-label="Actions for 당근 답장"]'),
    ).not.toBeNull();
    expect(
      yours.querySelector('button[aria-label*="danggeun-reply"]'),
    ).toBeNull();
    expect(ko["Actions for {name}"]).toBeTruthy();
    await view.unmount();
  });

  test("keeps the slug, as a chip, where it belongs", async () => {
    /*
     * The command is still the thing a person types, so it stays on the row — but set as a chip
     * rather than as bare monospace loose in an Inter sentence, where it reads as a typo.
     */
    const view = await skillsPage(answer);
    const chip = [...view.section("Your skills").querySelectorAll("code")].find(
      (code) => code.textContent === "/danggeun-reply",
    );
    if (!chip) throw new Error("the slug is not drawn as a chip");
    expect(chip.className).toContain("font-mono");
    expect(chip.className).toContain("bg-muted");
    // The interpunct only when there is a summary to separate it from.
    expect(chip.parentElement?.textContent).toBe(
      "/danggeun-reply · 당근마켓 문의에 답하기",
    );
    await view.unmount();
  });

  test("a workspace skill is listed with no menu, because nothing on it can be pressed", async () => {
    const view = await skillsPage(answer);
    const workspace = view.section("Workspace skills");
    expect(workspace.textContent).toContain("Standup notes");
    expect(
      workspace.querySelector('button[aria-label^="Actions for"]'),
    ).toBeNull();
    // And it is not counted among this person's own.
    expect(view.section("Your skills").textContent).not.toContain(
      "Standup notes",
    );
    await view.unmount();
  });
});

describe("the skills the package ships", () => {
  /*
   * MEASURED 2026-09-25: the three browsing skills sat under "워크스페이스 스킬 — 관리자가 모두를 위해
   * 작성했습니다" on a one-person deployment, each described by its note to the model.
   */
  const answer = () =>
    json({
      catalogue: [],
      servers: [],
      skills: [
        skill({
          slug: "네이버블로그",
          title: "네이버 블로그 글 찾아 읽기",
          summary: "블로그 검색은 search.naver.com …&ssc=tab.blog.all",
          ownerUserId: null,
          origin: "built_in",
        }),
        skill({ slug: "standup", title: "Standup notes", ownerUserId: null }),
      ],
    });

  test("are listed as built in, by title and command, without the model's note", async () => {
    const view = await skillsPage(answer);
    const builtIn = view.section("Built-in skills");
    expect(builtIn.textContent).toContain("네이버 블로그 글 찾아 읽기");
    expect(builtIn.textContent).toContain("/네이버블로그");
    expect(builtIn.textContent).not.toContain("search.naver.com");
    expect(
      builtIn.querySelector('button[aria-label^="Actions for"]'),
    ).toBeNull();
    // An administrator's skill stays where it was, and the package's is not among them.
    const workspace = view.section("Workspace skills");
    expect(workspace.textContent).toContain("Standup notes");
    expect(workspace.textContent).not.toContain("네이버 블로그");
    expect(ko["Built-in skills"]).toBe("기본 스킬");
    await view.unmount();
  });
});

describe("writing one", () => {
  test("happens in the panel beside the list, with its save kept on screen", async () => {
    /*
     * The list stays behind the form, which is what a panel is for: the usual reason to write a
     * skill is to make a variant of one already there. And 지시문 is a `min-h-40` textarea at the
     * bottom of a 400px panel, so on a laptop 스킬 저장 was below the fold of the panel's own
     * scroller until the footer was made sticky.
     */
    const view = await skillsPage(
      () => json({ catalogue: [], servers: [], skills: [] }),
      "/skills?new=true",
    );
    expect(
      view.main.querySelector('a[href="/skills?new=true"]'),
    ).not.toBeNull();
    expect(view.section("Your skills")).toBeDefined();
    expect(view.main.querySelectorAll("form")).toHaveLength(1);
    const save = view.main.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(save?.textContent).toBe("Save skill");
    const footer = save?.closest(".sticky");
    expect(footer?.className).toContain("bottom-0");
    await view.unmount();
  });

  test("Routines opens its form the same way, so the sibling pages agree", async () => {
    // Skills was already a panel; Routines was inline and is a panel now. The reasoning is written
    // down at the top of `NewRoutine`, and this is what keeps the two agreeing.
    const view = await mountApp({
      path: "/routines?new=true",
      api: ({ pathname }) => {
        if (pathname === "/api/routines") return json({ routines: [] });
        if (pathname === "/api/routines/suggestions") {
          return json({ suggestions: [] });
        }
        return undefined;
      },
    });
    const main = view.main();
    expect(main?.querySelector('a[href="/routines?new=true"]')).not.toBeNull();
    expect(main?.querySelectorAll("form")).toHaveLength(1);
    await view.unmount();
  });
});
