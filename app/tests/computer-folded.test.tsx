import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { ControlState } from "../src/components/computer/take-the-wheel";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * THE CARD WITH NO PICTURE, AND THE PAGE THAT WAS THERE A MOMENT AGO.
 *
 * Two things the owner hit, rendered rather than reasoned about.
 *
 * A CLOSED PAGE LEFT A BLANK SQUARE. MEASURED 2026-09-21 by driving the shipping `agent-computer`
 * image directly: `POST /computers/stop` (the Bot's tabs closed), then `GET /screenshot` answers
 * **200**, a white PNG and `url: "about:blank"` — the same 6,288 base64 characters, the same
 * sha256, as a browser that has never been sent anywhere. Nothing 404s and no socket drops. So the
 * card is driven here the same way: a page, then `about:blank`, and it has to change its sentence.
 *
 * AND IT COULD NOT BE MADE SMALLER. Folded, the card keeps one line saying where the Bot is and
 * gives up the picture — but not the password the Bot is waiting for, and not the wheel.
 */

const ONE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
const realCreateImageBitmap = globalThis.createImageBitmap;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
  globalThis.createImageBitmap = realCreateImageBitmap;
});

/**
 * A stub computer whose screen walks through `urls`, one per poll, and then stops answering.
 *
 * A list and not a single answer, because the whole point here is the TRANSITION: one frame with a
 * page on it, the next one blank. A card handed only the blank frame cannot tell the difference,
 * which is the bug.
 *
 * It goes quiet after the last one so the poll has nothing left to resolve. A card still polling
 * when its test has finished asserting updates React outside `act`, which is a warning per tick on
 * everybody else's output as well as this file's.
 */
function computer(urls: string[], control?: Partial<ControlState>) {
  const decoded: Blob[] = [];
  const asked = { control: false };
  let at = 0;
  globalThis.createImageBitmap = (async (blob: Blob) => {
    decoded.push(blob);
    return { width: 1, height: 1, close() {} } as ImageBitmap;
  }) as typeof createImageBitmap;

  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/computers/c1/screenshot") {
      const showing = urls[at];
      if (showing === undefined) return new Promise<Response>(() => {});
      at += 1;
      return json({
        base64: ONE_PIXEL,
        width: 1,
        height: 1,
        capturedAt: "2026-09-21T09:00:01.000Z",
        url: showing,
      });
    }
    if (url === "/api/computers/c1/control") {
      // Once, then silence, for the reason the screenshot goes quiet: the wheel's loop is shared
      // between every card watching a computer and runs at 1 Hz for as long as one is live.
      if (asked.control) return new Promise<Response>(() => {});
      asked.control = true;
      return json({
        holder: "bot",
        since: "2026-09-21T09:00:00.000Z",
        requested: false,
        ...control,
      } satisfies ControlState);
    }
    if (url === "/api/computers/c1/demonstration") {
      return json({ demonstration: null });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { decoded, polls: () => at };
}

async function card(options: {
  urls: string[];
  isFolded?: boolean;
  control?: Partial<ControlState>;
}) {
  const stub = computer(options.urls, options.control);
  const { ComputerView } = await import(
    "../src/components/computer/computer-view"
  );
  const view = await mount(
    <ComputerView
      computerId="c1"
      intervalMs={10}
      isFolded={options.isFolded ?? false}
      teachable
    />,
  );
  // Enough ticks for every url in the list to have been the current one — a folded card looks
  // once every `intervalMs * FOLDED_INTERVAL_RATIO`, which is the whole point of folding it.
  await view.settle((options.isFolded ? 160 : 40) * options.urls.length + 80);
  const figure = view.host.querySelector("figure") as HTMLElement;
  return {
    ...view,
    ...stub,
    figure,
    picture: figure.querySelector(
      'button[aria-label="Open the Bot\'s screen full size"]',
    ) as HTMLButtonElement | null,
    /** The line the card speaks with: mounted with the card, `sr-only` while it has nothing. */
    line: () => figure.querySelector('p[role="status"]'),
  };
}

describe("a page the Bot closed", () => {
  test("says the Bot closed it, and that nothing went wrong", async () => {
    const view = await card({
      urls: ["https://nid.naver.com/", "about:blank"],
    });
    expect(view.picture?.textContent).toContain(
      "The Bot closed the page it was looking at.",
    );
    // The half that says this is not a fault. It was lost the first time this state was drawn,
    // because the card only rendered `advice` for a `problem`.
    expect(view.picture?.textContent).toContain(
      "Nothing has gone wrong. It opens another when it needs one.",
    );
    // Not "wait for an administrator to check the computer": the computer answered, twice.
    expect(view.host.textContent).not.toContain("administrator");
  });

  test("a browser that was never used says the other thing", async () => {
    const view = await card({ urls: ["about:blank"] });
    expect(view.picture?.textContent).toBe(
      "The Bot has not opened a page yet.",
    );
  });

  test("a page opened again after one was closed goes back to being a picture", async () => {
    const view = await card({
      urls: ["https://nid.naver.com/", "about:blank", "https://naver.com/"],
    });
    expect(view.picture?.disabled).toBe(false);
    expect(view.picture?.textContent).toBe("");
  });
});

describe("the folded card", () => {
  test("has no picture, and one line saying where the Bot is", async () => {
    const view = await card({
      urls: ["https://nid.naver.com/"],
      isFolded: true,
    });
    expect(view.picture).toBeNull();
    expect(view.figure.querySelector("canvas")).toBeNull();
    expect(view.line()?.textContent).toBe("The Bot is on nid.naver.com.");
  });

  test("the line is the card's own live region, in the same slot it speaks from unfolded", async () => {
    /*
     * `docs/laf/dialogs.md`: a region a screen reader is told about only when it has something to
     * say arrives together with its first sentence, and most readers announce nothing. Folding must
     * not mint a new region — it is the same `<p role="status">` the stale-picture line uses.
     */
    const folded = await card({
      urls: ["https://nid.naver.com/"],
      isFolded: true,
    });
    expect(folded.line()?.getAttribute("aria-live")).toBe("polite");
    // Unfolded, the same element is there and holding its tongue.
    const open = await card({ urls: ["https://nid.naver.com/"] });
    expect(open.line()?.className).toContain("sr-only");
  });

  test("says a closed page the same way the picture does", async () => {
    const view = await card({
      urls: ["https://nid.naver.com/", "about:blank"],
      isFolded: true,
    });
    expect(view.line()?.textContent).toBe(
      "The Bot closed the page it was looking at.",
    );
  });

  test("decodes nothing: there is no canvas for a frame to be painted onto", async () => {
    const folded = await card({
      urls: ["https://nid.naver.com/"],
      isFolded: true,
    });
    expect(folded.decoded).toHaveLength(0);
    // The unfolded card does decode, so the line above is measuring something.
    const open = await card({ urls: ["https://nid.naver.com/"] });
    expect(open.decoded.length).toBeGreaterThan(0);
  });

  test("still asks for the password the Bot is waiting for", async () => {
    /*
     * Folding is a decision about how much room a PICTURE may have. A fold that also swallowed the
     * Bot's request for a password would be a fold nobody could safely leave on — and the request
     * is the one thing on this card that a person has to answer.
     */
    const view = await card({
      urls: ["https://nid.naver.com/"],
      isFolded: true,
      control: {
        requested: true,
        reason: "로그인이 필요해요.",
        secretWanted: "Naver password",
      },
    });
    expect(view.figure.querySelector('input[type="password"]')).not.toBeNull();
    expect(view.figure.textContent).toContain("Naver password");
    expect(view.figure.textContent).toContain("로그인이 필요해요.");
  });
});
