import { GlobalRegistrator } from "@happy-dom/global-registrator";
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
import { focusRing } from "../src/components/ui/focus";
import type { Recording } from "../src/lib/computer/demonstration";
import type { ControlState } from "../src/components/computer/take-the-wheel";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * The card that shows the Bot's screen: one left rule, one rounded picture, and a ring on every
 * control a keyboard can reach.
 *
 * MEASURED IN A BROWSER AT 1440x900, IN BOTH THEMES, AND NONE OF IT WAS VISIBLE FROM A GREEN GATE.
 * In the 287px column the pane leaves, `getBoundingClientRect().left` reported three different
 * starts inside one card: the picture at 1138, every row's words at 1150, and the recorded-steps
 * list at 1162 with its text at 1173. They are all 1146 now. The picture also had square bottom
 * corners inside a rounded, clipped card, so the panel under it cut straight across where the
 * screen's shape should have continued; it is its own complete `rounded-xl` box now, inset from the
 * card, and nothing can cross a corner it no longer shares.
 *
 * RENDERED, IN EVERY STATE THE CARD HAS. The first version of this file grepped the source with
 * its comments stripped, and a grep for `list-inside` passes on a file where the list is never
 * drawn. So `ComputerView` is mounted against a stub computer — a frame, a 503, a blank browser,
 * a Bot asking for help, a Bot asking for a password, a finished recording — and the classes are
 * read off the elements that actually carry them. The pixel offsets above are what a browser adds
 * on top; this holds the facts a later edit could quietly undo.
 *
 * One fact stays a source walk, and is marked as such below: WHERE the ring comes from. A copy of
 * the house ring and an import of it render the same class list, so the DOM cannot tell them apart.
 */

const DIR = join(import.meta.dir, "../src/components/computer");

/** A 1x1 PNG. What the computer answers with, and what `decodeFrame` is handed. */
const ONE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {
    this.onclose?.();
  }
}

beforeAll(() => {
  // A real origin: the full-size view builds its socket URL from `window.location.host`.
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
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

type Screen = "hold" | "frame" | "blank" | "down";

/** A stub computer at `/api/computers/c1`, in whichever state a test needs. */
function computer(options: {
  screen?: Screen;
  control?: Partial<ControlState>;
  recording?: Recording | null;
}) {
  const decoded: Blob[] = [];
  const requests: string[] = [];
  const control: ControlState = {
    holder: "bot",
    since: "2026-09-10T09:00:00.000Z",
    requested: false,
    ...options.control,
  };
  /*
   * `decodeFrame` hands the bytes to `createImageBitmap`. Bun exposes one, but what it does with a
   * PNG under happy-dom is not this test's business; what is, is that the frame path was taken.
   */
  globalThis.createImageBitmap = (async (blob: Blob) => {
    decoded.push(blob);
    return { width: 1, height: 1, close() {} } as ImageBitmap;
  }) as typeof createImageBitmap;

  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/computers/c1/screenshot") {
      const screen = options.screen ?? "frame";
      if (screen === "hold") return new Promise<Response>(() => {});
      if (screen === "down") {
        return json(
          {
            code: "laf:computer_unreachable",
            error: "The assistant's computer is not running.",
          },
          503,
        );
      }
      return json({
        base64: ONE_PIXEL,
        width: 1,
        height: 1,
        capturedAt: "2026-09-10T09:00:01.000Z",
        url: screen === "blank" ? "about:blank" : "https://nid.naver.com/",
      });
    }
    if (url === "/api/computers/c1/control") return json(control);
    if (url === "/api/computers/c1/demonstration") {
      return json({ demonstration: options.recording ?? null });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { decoded, requests };
}

async function card(options: Parameters<typeof computer>[0] = {}) {
  const stub = computer(options);
  const { ComputerView } = await import(
    "../src/components/computer/computer-view"
  );
  // A long interval: the first frame is always fetched, and this card is not here to poll.
  const view = await mount(
    <ComputerView computerId="c1" intervalMs={60_000} teachable />,
  );
  const figure = view.host.querySelector("figure") as HTMLElement;
  const picture = figure.querySelector("button") as HTMLButtonElement;
  return {
    ...view,
    ...stub,
    figure,
    picture,
    /**
     * Every block below the picture, each starting on the card's own left rule.
     *
     * Not a live region waiting to speak: the picture's own line is mounted with the card and is
     * visually hidden while it has nothing to say (`LiveRegion`), and hidden is not a row.
     */
    rows: () =>
      ([...figure.children].slice(1) as HTMLElement[]).filter(
        (child) => !child.classList.contains("sr-only"),
      ),
    focusable: () =>
      [
        ...figure.querySelectorAll<HTMLElement>(
          "button, input, textarea, a[href]",
        ),
      ].filter((element) => !element.hasAttribute("disabled")),
    buttonNamed: (label: string) =>
      [...figure.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      ),
  };
}

const classes = (element: Element | null | undefined) =>
  (element?.className ?? "").split(/\s+/);

const FINISHED: Recording = {
  finished: true,
  steps: [
    { kind: "opened", url: "https://nid.naver.com" },
    { kind: "pressed", element: { role: "button", name: "로그인" } },
  ],
};

/** The Bot has asked for help and for a password, and a recording waits: every row at once. */
const EVERY_ROW = {
  control: {
    requested: true,
    reason: "로그인이 필요해요.",
    secretWanted: "Naver password",
    secretInto: {
      host: "nid.naver.com",
      element: { role: "textbox", name: "비밀번호" },
    },
  },
  recording: FINISHED,
};

describe("one left rule", () => {
  test("the card carries the padding, once, for everything inside it", async () => {
    const view = await card(EVERY_ROW);
    expect(classes(view.figure)).toContain("p-2");
    expect(classes(view.figure)).toContain("rounded-2xl");
    // `px-3` on a full-bleed row is what put its words 12px right of the picture above them.
    for (const element of view.figure.querySelectorAll("*")) {
      expect(classes(element)).not.toContain("px-3");
    }
  });

  test("no row pads itself away from the card's own padding", async () => {
    const view = await card(EVERY_ROW);
    const rows = view.rows();
    // The password form, the Bot's request, and the recording: three rows, one rule.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(classes(row)).toContain("border-t");
      expect(classes(row).some((cls) => /^-?px-/.test(cls))).toBe(false);
    }
  });

  test("the recorded steps put their numbers on the rule rather than in a padding well", async () => {
    const view = await card({ recording: FINISHED });
    const list = view.figure.querySelector("ol");
    expect(classes(list)).toContain("list-inside");
    expect(classes(list)).toContain("list-decimal");
    expect(classes(list)).not.toContain("px-6");
    expect(
      [...(list?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual(["Opened https://nid.naver.com", "Pressed 로그인"]);
  });
});

describe("the picture is a complete rectangle", () => {
  test("it rounds and clips itself instead of borrowing the card's corners", async () => {
    const view = await card();
    expect(classes(view.picture)).toContain("overflow-hidden");
    expect(classes(view.picture)).toContain("rounded-xl");
    expect(classes(view.picture)).toContain("w-full");
  });

  test("the card no longer clips its children, so nothing is cut across", async () => {
    // `overflow-hidden` on the figure is what made a panel's straight top edge read as the end of
    // the screen's shape.
    const view = await card(EVERY_ROW);
    expect(classes(view.figure)).not.toContain("overflow-hidden");
  });
});

describe("what a keyboard sees", () => {
  test("every control in the card that a keyboard can reach asks for the house ring", async () => {
    // Before: the browser's own `outline: auto 1px`, in the colour the base layer sets to 20%-alpha
    // black — which on the full-size view's black scrim is nothing at all.
    const view = await card(EVERY_ROW);
    const controls = view.focusable();
    expect(controls.length).toBeGreaterThanOrEqual(5);
    const bare = controls
      .filter((control) =>
        focusRing.split(" ").some((cls) => !classes(control).includes(cls)),
      )
      .map((control) => `${control.tagName} ${control.textContent}`);
    expect(bare).toEqual([]);
  });

  test("the ring has a border box to recolour, which is half of the house ring", async () => {
    // `focus-visible:border-ring` recolours a border; on the picture there was none to recolour.
    const view = await card();
    for (const cls of ["border", "border-transparent", "bg-clip-padding"]) {
      expect(classes(view.picture)).toContain(cls);
    }
  });

  test("the full-size view's backdrop rings inside itself, in white, through cn", async () => {
    /*
     * It is the whole viewport: an outward ring is drawn past its edges and clipped away. And the
     * scrim is black in both themes, while `--ring` in the light theme is 40%-alpha black.
     *
     * THE OVERRIDE HAS TO GO THROUGH `cn`. Measured with the two put in one template string: the
     * computed ring came back `oklab(0.19 … / 0.2) 2px inset`, the house colour, because Tailwind
     * orders its output by utility rather than by the order classes appear in the attribute. With
     * `cn` — which is `tailwind-merge` — it measures white at 70%. And that is visible here: the
     * merge DROPS the losing colour, so a class list still carrying `ring-ring/50` is a class list
     * that was concatenated.
     */
    const view = await card();
    expect(view.picture.disabled).toBe(false);
    await view.press(view.picture);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const backdrop = dialog?.querySelector(
      'button[aria-label="Close the Bot\'s screen"]',
    );
    expect(classes(backdrop)).toContain("bg-black/80");
    expect(classes(backdrop)).toContain("focus-visible:ring-inset");
    expect(classes(backdrop)).toContain("focus-visible:ring-2");
    expect(classes(backdrop)).toContain("focus-visible:ring-white/70");
    expect(classes(backdrop)).not.toContain("focus-visible:ring-ring/50");

    // Escape is bound to the window, so it closes the view whatever holds focus.
    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test("the pill controls are the shared primitive rather than more bespoke buttons", async () => {
    const view = await card(EVERY_ROW);
    const pills = [...view.figure.querySelectorAll("button")].filter(
      (button) => button !== view.picture,
    );
    expect(pills.length).toBeGreaterThanOrEqual(3);
    for (const pill of pills) {
      expect(pill.dataset.slot).toBe("button");
    }
    // Every filled control that used to be a hand-rolled `bg-primary` pill.
    for (const element of view.figure.querySelectorAll("*")) {
      expect(element.className).not.toContain(
        "rounded-md bg-primary px-3 py-1",
      );
    }
  });

  test("the ring is the house one, imported rather than copied — a source walk, because a copy renders identically", () => {
    /*
     * THE ONE ASSERTION LEFT ON THE SOURCE. `ui/focus.ts` exists so that the ring is spelled once;
     * this card wrote the three classes by hand when it was fixed and `focus.ts` landed the same
     * afternoon to stop exactly that. A copy left behind here renders the same class list as the
     * import does, so the DOM cannot see it — only the file can. Comments are stripped first,
     * because they are where the old spelling is recorded.
     */
    const strip = (name: string) =>
      readFileSync(join(DIR, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const name of ["computer-view.tsx", "teach-a-task.tsx"]) {
      const source = strip(name);
      expect(
        `${name}: ${source.includes('from "@/components/ui/focus"')}`,
      ).toBe(`${name}: true`);
      expect(source).not.toContain("focus-visible:ring-ring/50");
      expect(source).not.toContain("focus-visible:ring-3");
    }
  });
});

describe("waiting looks like everything else that is loading", () => {
  test("the first frame is a Skeleton inside the reserved frame, not a plain grey rectangle", async () => {
    const view = await card({ screen: "hold" });
    const skeleton = view.picture.querySelector("[data-slot=skeleton]");
    expect(classes(skeleton)).toContain("absolute");
    expect(classes(skeleton)).toContain("inset-0");
    expect(view.picture.disabled).toBe(true);
    // The frame is sized from the ratio, never from the payload, so nothing reflows when it lands.
    expect(view.picture.style.minWidth).toBe("320px");
    expect(view.picture.style.minHeight).toBe("200px");
    expect(view.picture.getAttribute("style")).toContain("aspect-ratio");
  });

  test("a person reading the page rather than looking at it is still told", async () => {
    const view = await card({ screen: "hold" });
    expect(view.picture.querySelector(".sr-only")?.textContent).toBe(
      "Waiting for the Bot's screen…",
    );
    const canvas = view.picture.querySelector("canvas");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  });

  test("waiting is only ever the state with nothing and no problem", async () => {
    // A failed read is not a load: it says so in words instead of pulsing forever.
    const view = await card({ screen: "down" });
    expect(view.picture.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(view.picture.textContent).toContain(
      "You cannot see the screen right now",
    );
    expect(view.picture.textContent).toContain(
      "The Bot's computer could not be reached.",
    );
    // The server's own sentence is a fact code's companion, never the words on screen.
    expect(view.host.textContent).not.toContain("assistant's computer");
    expect(view.picture.disabled).toBe(true);
  });

  test("a frame that lands is decoded, shown, and can be opened", async () => {
    const view = await card({ screen: "frame" });
    expect(view.decoded).toHaveLength(1);
    expect(view.decoded[0]?.type).toBe("image/png");
    expect(view.picture.querySelector("[data-slot=skeleton]")).toBeNull();
    const canvas = view.picture.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("false");
    expect(classes(canvas)).toContain("opacity-100");
    expect(view.picture.disabled).toBe(false);
    expect(classes(view.picture)).toContain("bg-muted");
  });

  test("a blank browser says so in words and is not offered full size", async () => {
    const view = await card({ screen: "blank" });
    expect(view.picture.textContent).toBe("The Bot has not opened a page yet.");
    expect(view.picture.disabled).toBe(true);
    expect(
      view.picture.querySelector("canvas")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
