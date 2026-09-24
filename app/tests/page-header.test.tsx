import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  pageDescriptionClass,
  pageHeaderClass,
  pageTitleClass,
  pageTitleRowClass,
  sectionTitleClass,
} from "../src/components/ui/page-header";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { mount, unmountAll } from "./support/mount";

/**
 * BOTS, ROUTINES AND SKILLS ARE THREE NEIGHBOURS IN THE RAIL, AND THEY HAD THREE HEADINGS.
 *
 * Not three designs — nobody designed them — three accretions. Bots put a `<div>` on the title's
 * baseline (a column holding a ghost button and a paragraph, which made its title row taller than
 * the other two); Routines put a filled `<Button>` there; Skills had no header action at all and
 * pushed 새 스킬 down into a section heading, drawn quietly, where the eye does not look for the
 * thing a page is for.
 *
 * RENDERED. `PageShell` is drawn with a title, a description and an action, and what is asserted
 * is what a person gets: one `h1`, the sentence under it, the verb on the title's own row, and the
 * classes on those elements being the tokens `ui/page-header.ts` exports — not the strings
 * `text-2xl` and `gap-2` respelled. A previous version read the source of `page-header.tsx` for
 * the token names, which a file that imported them and used none of them would have passed.
 *
 * And the three sibling ROUTES are mounted too, through the real route tree, so that "they all
 * reach this component" is something seen on their screens rather than a word found in their files.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);

afterAll(async () => {
  await removeAppDom();
});

afterEach(unmountAll);

async function shell(options: {
  action?: boolean;
  description?: boolean;
  width?: "prose" | "wide";
}) {
  const { PageShell } = await import("../src/components/layout/page-shell");
  const view = await mount(
    <PageShell
      action={
        options.action === false ? undefined : (
          <button type="button">New routine</button>
        )
      }
      description={
        options.description === false ? undefined : "What runs on a clock."
      }
      title="Routines"
      width={options.width}
    >
      <p>the list</p>
    </PageShell>,
  );
  return {
    ...view,
    header: () => view.host.querySelector("header"),
    h1s: () => [...view.host.querySelectorAll("h1")],
  };
}

const classes = (value: string | undefined) => (value ?? "").split(/\s+/);

describe("the page header, drawn", () => {
  test("draws exactly one h1, and it is the title", async () => {
    const view = await shell({});
    expect(view.h1s().map((h1) => h1.textContent)).toEqual(["Routines"]);
    expect(view.h1s()[0]?.closest("header")).toBe(view.header());
  });

  test("the description is the paragraph under the title row", async () => {
    const view = await shell({});
    const header = view.header();
    const paragraph = header?.querySelector("p");
    expect(paragraph?.textContent).toBe("What runs on a clock.");
    // Under, not beside: the row holds the title and the verb, and the sentence follows the row.
    expect(paragraph?.parentElement).toBe(header as HTMLElement);
    expect(header?.lastElementChild).toBe(paragraph as Element);
  });

  test("with no description there is no empty paragraph", async () => {
    const view = await shell({ description: false });
    expect(view.header()?.querySelector("p")).toBeNull();
    expect(view.header()?.children).toHaveLength(1);
  });

  test("the action sits on the title row, beside the h1", async () => {
    /*
     * This is the row that was three different heights on three pages. The verb shares the h1's
     * parent — the row — so the shell decides the baseline, not whatever the page handed in.
     */
    const view = await shell({});
    const h1 = view.h1s()[0];
    const action = view.host.querySelector("button");
    expect(action?.textContent).toBe("New routine");
    expect(action?.parentElement).toBe(h1?.parentElement as HTMLElement);
    expect(h1?.nextElementSibling).toBe(action as Element);
  });

  test("the header spends the shared tokens instead of respelling them", async () => {
    /*
     * `ui/page-header.ts` is where "how big is a page title" is answered, once, for the whole app.
     * Every class in each token is on the element that token is for, so a header that hard-coded
     * `text-2xl` would agree with it today and drift the first time the scale moves.
     */
    const view = await shell({});
    const header = view.header();
    const row = view.h1s()[0]?.parentElement;
    const paragraph = header?.querySelector("p");
    for (const cls of classes(pageHeaderClass)) {
      expect(classes(header?.className)).toContain(cls);
    }
    for (const cls of classes(pageTitleRowClass)) {
      expect(classes(row?.className)).toContain(cls);
    }
    expect(view.h1s()[0]?.className).toBe(pageTitleClass);
    expect(paragraph?.className).toBe(pageDescriptionClass);
  });

  test("the shell owns the scrolling and keeps the measure inside it", async () => {
    // A scroll container that is also the max-width column puts its scrollbar mid-page.
    const view = await shell({});
    const scroller = view.host.firstElementChild;
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller?.firstElementChild?.className).toContain("max-w-2xl");
    const wide = await shell({ width: "wide" });
    expect(wide.host.firstElementChild?.firstElementChild?.className).toContain(
      "max-w-5xl",
    );
  });

  test("a section's title is an h2, never a second h1", async () => {
    const { PageSection } = await import("../src/components/layout/page-shell");
    const view = await mount(
      <PageSection title="Every routine">
        <p>rows</p>
      </PageSection>,
    );
    expect(view.host.querySelector("h1")).toBeNull();
    const h2 = view.host.querySelector("h2");
    expect(h2?.textContent).toBe("Every routine");
    expect(h2?.className).toBe(sectionTitleClass);
  });

  test("the tokens are the ones the design record documents", () => {
    // docs/laf/design-tokens.md §10 prints this table. If a value changes, the doc is now wrong.
    expect(pageHeaderClass).toBe("flex flex-col gap-2");
    expect(pageTitleRowClass).toBe(
      "flex flex-row items-center justify-between gap-4",
    );
    expect(pageTitleClass).toBe("font-semibold text-2xl");
    expect(pageDescriptionClass).toContain("max-w-prose");
  });
});

describe("the three sibling pages", () => {
  /*
   * RENDERED THROUGH THE ROUTE TREE. This was a walk of the three route files — `<PageShell` present,
   * no `<h1` of their own — on the argument that a render could not see it. It can: a page that drew
   * its own title beside a correct shell has two headings on screen, and one that stopped reaching
   * the shell has a heading without the shell's token.
   */
  for (const [name, path] of [
    // The Bot's profile since 2026-09-24; it was "Bots", a gallery of several.
    ["Bot profile", "/agents"],
    ["Routines", "/routines"],
    ["Skills", "/skills"],
  ] as const) {
    test(`${name} has one title, and it is the shell's`, async () => {
      const view = await mountApp({
        path,
        // A person with their Bot: with none, every screen sends them to make one.
        api: ({ pathname }) =>
          pathname === "/api/agents"
            ? json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] })
            : undefined,
      });
      try {
        const main = view.main();
        const titles = [...(main?.querySelectorAll("h1") ?? [])];
        expect({ name, titles: titles.length }).toEqual({ name, titles: 1 });
        expect(titles[0]?.className).toBe(pageTitleClass);
        expect(titles[0]?.textContent).toBe(name);
      } finally {
        await view.unmount();
      }
    });
  }
});
