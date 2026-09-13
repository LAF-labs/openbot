import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * `/channel/new` asks who a conversation is for exactly once, and a press on a face is an answer.
 *
 * It used to ask twice: a combobox in the header and a row of faces in the middle, answering the
 * same question through two controls that could not agree — only the combobox could add several,
 * only the faces could show who was chosen, and a face already chosen did nothing when pressed.
 *
 * RENDERED, NOT WALKED. The earlier version of this file read the route's source and looked for
 * identifiers: `selectedIds`, `removeRecipient`, one `<RosterStrip`. A source walk passes when the
 * word exists anywhere in the file — it would have stayed green on a `removeRecipient` that was
 * imported and never called, which is exactly the add-only bug it was written against. So this
 * mounts the route and presses the faces. One walk survives, for the one fact that is about
 * absence: the second control has not come back.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const roster = [
  agentFixture({ id: "bot-1", name: "초롱" }),
  agentFixture({ id: "bot-2", name: "조약돌" }),
  agentFixture({ id: "bot-3", name: "단풍" }),
];

async function composeScreen(path = "/channel/new") {
  const view = await mountApp({
    path,
    api: ({ pathname }) =>
      pathname === "/api/agents" ? json({ agents: roster }) : undefined,
  });
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  return {
    ...view,
    main,
    /** The faces: every toggle in the pane. The + tile is not one, and says so by having no state. */
    faces: () => [
      ...main.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ],
    face: (name: string) => {
      const found = [
        ...main.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ].find((button) => button.textContent?.trim() === name);
      if (!found) throw new Error(`no face on screen for ${name}`);
      return found;
    },
    pressedNames: () =>
      [...main.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent?.trim()),
    removeButton: (name: string) =>
      main.querySelector<HTMLButtonElement>(
        `button[aria-label="Remove ${name}"]`,
      ),
    /** The `To:` row at the top, where the chips live. */
    header: () => {
      const label = [...main.querySelectorAll("span")].find(
        (span) => span.textContent === "To:",
      );
      if (!label?.parentElement) throw new Error("the To: row is not drawn");
      return label.parentElement;
    },
  };
}

describe("the compose screen's recipient picker", () => {
  test("has one picker, and it is the faces", async () => {
    const view = await composeScreen();
    const faces = view.faces();
    expect(faces.map((face) => face.textContent?.trim())).toEqual([
      "초롱",
      "조약돌",
      "단풍",
    ]);
    // Nothing chosen yet, and every face says so rather than saying nothing.
    expect(faces.map((face) => face.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(
      view.main.querySelector('[role="combobox"], [aria-autocomplete]'),
    ).toBeNull();
    // The header holds the answer and the placeholder, and no control of its own.
    expect(view.header().querySelector("input, [role='combobox']")).toBeNull();
    expect(view.header().textContent).toContain("Pick a Bot below");
    await view.unmount();
  });

  test("no longer carries a second picker in the header", async () => {
    /*
     * The one source walk kept. A render proves the surviving picker works; it cannot prove that a
     * second one has not quietly come back behind a condition the fixture never trips.
     */
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/_authed/_app/channel/new.tsx"),
      "utf8",
    );
    expect(source).not.toContain("<Combobox");
    expect(source).not.toContain('from "@/components/ui/combobox"');
    const view = await composeScreen();
    expect(view.header().querySelectorAll("button")).toHaveLength(0);
    await view.unmount();
  });

  test("can show several chosen at once, which is what a room is", async () => {
    const view = await composeScreen();
    await view.click(view.face("초롱"));
    await view.click(view.face("조약돌"));

    expect(view.pressedNames()).toEqual(["초롱", "조약돌"]);
    expect(view.removeButton("초롱")).not.toBeNull();
    expect(view.removeButton("조약돌")).not.toBeNull();
    expect(view.removeButton("단풍")).toBeNull();
    expect(view.header().textContent).not.toContain("Pick a Bot below");
    await view.unmount();
  });

  test("lets a press take a Bot back out", async () => {
    // Add-only faces were the reason a chosen tile did nothing when pressed.
    const view = await composeScreen();
    await view.click(view.face("초롱"));
    expect(view.pressedNames()).toEqual(["초롱"]);

    await view.click(view.face("초롱"));
    expect(view.pressedNames()).toEqual([]);
    expect(view.removeButton("초롱")).toBeNull();
    expect(view.header().textContent).toContain("Pick a Bot below");
    await view.unmount();
  });

  test("keeps the chosen recipients as chips with a way to remove each", async () => {
    const view = await composeScreen();
    await view.click(view.face("단풍"));
    const chip = view.removeButton("단풍");
    if (!chip) throw new Error("the chip has no remove button");
    expect(chip.closest("span")?.textContent).toContain("단풍");
    expect(ko["Remove {name}"]).toBeString();

    // The × on the chip and the face agree: pressing one is the same answer as pressing the other.
    await view.click(chip);
    expect(view.removeButton("단풍")).toBeNull();
    expect(view.face("단풍").getAttribute("aria-pressed")).toBe("false");
    await view.unmount();
  });

  test("asks the question in a way a room does not contradict", async () => {
    const heading = "Who should be in this conversation?";
    const view = await composeScreen();
    expect(view.main.textContent).toContain(heading);
    expect(ko[heading]).toBeString();
    // The singular one it replaced asked to SEND to one person.
    expect(view.main.textContent).not.toContain("Who is this for?");
    await view.unmount();
  });

  test("the URL seeds the room and then stops deciding it", async () => {
    /*
     * The chips used to be a reading of `?agent=`, so their × changed nothing about what the screen
     * would send. Here the URL still names the Bot after the chip is gone, and the screen no longer
     * listens to it.
     */
    const view = await composeScreen("/channel/new?agent=bot-2");
    expect(view.pressedNames()).toEqual(["조약돌"]);
    const chip = view.removeButton("조약돌");
    if (!chip) throw new Error("the seeded recipient has no chip");

    await view.click(chip);
    expect(view.pressedNames()).toEqual([]);
    expect(view.router.state.location.search).toEqual({ agent: "bot-2" });
    await view.unmount();
  });
});
