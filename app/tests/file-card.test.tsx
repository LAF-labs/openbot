import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { ReactNode } from "react";
import { GALLERY_CONFIRMATIONS } from "@shared/tools/gallery";
import { COMPUTER_CODES } from "../../agent-computer/src/codes";
import { ko } from "../src/lib/i18n-ko";
import { FILE_CARD_SAID, fileAddress } from "../src/lib/computer/files";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * THE FILE CARD (phase 8, first slice, 2026-10-02): a file from the Bot's folder, handed to the
 * person in the conversation.
 *
 * Rendered rather than read, for what a DOM can answer: that the button is a link to the download
 * route and nothing else, that only a picture is drawn, and — the rule this card exists under —
 * that a file which is not there gets a sentence and NO button. A control that does nothing is not
 * drawn.
 *
 * What this cannot say is said in the report that came with it: that the desktop shell saves what
 * the link points at, and how the card looks. `bun test` never compiles a component either
 * (CLAUDE.md), so the compiled card has only been seen by `react-compiler.test.ts`'s count.
 */

beforeAll(() => {
  // At an address, as the app always is: the card's picture is `/api/…`, and a document with no
  // address cannot resolve that — the DOM would report the picture broken before anything drew it.
  GlobalRegistrator.register({ url: "http://app.test/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

/** What the server's `files/info` door answers, by path. */
type Folder = Record<string, () => Response>;

function folder(files: Folder) {
  const asked: string[] = [];
  globalThis.fetch = stubFetch(async (input) => {
    const url = new URL(String(input), "http://app.test");
    if (!url.pathname.endsWith("/files/info")) {
      // The file itself is never fetched by the card: a link points at it and an <img> draws it.
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    const path = url.searchParams.get("path") ?? "";
    asked.push(`${url.pathname} ${path}`);
    const answer = files[path];
    return answer
      ? answer()
      : json({ error: "laf:file_not_found", code: "laf:file_not_found" }, 404);
  });
  return asked;
}

const there = (bytes: number) => () => json({ kind: "file", bytes });
const refused = (status: number, code: string) => () =>
  json({ error: code, code }, status);

async function card(
  props: { path?: string; note?: string },
  options: { bot?: string | null } = {},
) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createElement } = await import("react");
  const { FileCard } = await import("../src/components/gallery/file");
  const { ActiveBotProvider, useActiveBot } = await import(
    "../src/lib/copilot/active-bot"
  );
  const bot = options.bot === undefined ? "bot-1" : options.bot;
  /** The conversation the card is drawn in: it is what says whose folder this is. */
  function Conversation({ children }: { children: ReactNode }) {
    useActiveBot(bot ?? undefined);
    return children;
  }
  // The card's own one retry, without the second it waits before taking it.
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const drawn = (next: { path?: string; note?: string }) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        ActiveBotProvider,
        null,
        createElement(Conversation, null, createElement(FileCard, next)),
      ),
    );
  const mounted = await mount(drawn(props));
  return {
    ...mounted,
    redraw: (next: typeof props) => mounted.render(drawn(next)),
  };
}

const linkOf = (host: HTMLElement) =>
  host.querySelector<HTMLAnchorElement>("a[data-file-download]");

/** Lets the card settle until `seen` is true, for as long as an answer could reasonably take. */
async function eventually(
  settle: (ms?: number) => Promise<void>,
  seen: () => boolean,
) {
  for (let waited = 0; waited < 3_000 && !seen(); waited += 50) {
    await settle(50);
  }
}

describe("a file that is there", () => {
  test("is its name, its size, and a link that downloads it", async () => {
    const asked = folder({ "보고서/9월 정산내역 (2).csv": there(12_345) });

    const { host } = await card({
      path: "보고서/9월 정산내역 (2).csv",
      note: "이번 달 정산 내역이에요",
    });

    // The name and not the path; what the Bot said about it; how big.
    expect(host.textContent).toContain("9월 정산내역 (2).csv");
    expect(host.textContent).not.toContain("보고서/");
    expect(host.textContent).toContain("이번 달 정산 내역이에요");
    expect(host.textContent).toContain("12KB");

    const link = linkOf(host);
    expect(link?.textContent).toContain("Download");
    expect(link?.getAttribute("href")).toBe(
      fileAddress("bot-1", "보고서/9월 정산내역 (2).csv"),
    );
    expect(link?.getAttribute("download")).toBe("9월 정산내역 (2).csv");
    /*
     * A plain link in this window. `_blank` is what the desktop shell hands to the person's own
     * browser (`shell-links.ts`), which has no session here — the download would be a sign-in
     * refusal.
     */
    expect(link?.hasAttribute("target")).toBe(false);
    // A sheet is not drawn, and was asked about once, as this Bot's.
    expect(host.querySelector("img")).toBeNull();
    expect(asked).toEqual([
      "/api/computers/bot-1/files/info 보고서/9월 정산내역 (2).csv",
    ]);
  });

  test("a picture is also shown, asked for as a picture and still downloaded as a file", async () => {
    folder({ "charts/매출.png": there(48_000) });

    const { host } = await card({ path: "charts/매출.png" });

    const picture = host.querySelector("img");
    expect(picture?.getAttribute("src")).toBe(
      fileAddress("bot-1", "charts/매출.png", { inline: true }),
    );
    expect(picture?.getAttribute("alt")).toBe("매출.png");
    expect(linkOf(host)?.getAttribute("href")).toBe(
      fileAddress("bot-1", "charts/매출.png"),
    );
  });

  test("only the four pictures are: an SVG, a page and a PDF are a name and a button", async () => {
    for (const path of ["logo.svg", "page.html", "report.pdf", "notes.md"]) {
      folder({ [path]: there(900) });
      const { host, unmount } = await card({ path });
      expect([path, host.querySelector("img")]).toEqual([path, null]);
      expect(linkOf(host)?.getAttribute("href")).toBe(
        fileAddress("bot-1", path),
      );
      await unmount();
    }
  });

  test("a picture the server would not draw is taken down, not left broken", async () => {
    folder({ "disguised.png": there(900) });
    const { host, settle } = await card({ path: "disguised.png" });
    const picture = host.querySelector("img");
    expect(picture).not.toBeNull();

    const { act } = await import("react");
    await act(async () => {
      picture?.dispatchEvent(new Event("error"));
    });
    await settle();

    expect(host.querySelector("img")).toBeNull();
    // It is still a file, and still downloads.
    expect(linkOf(host)).not.toBeNull();
  });
});

describe("a file that is not there", () => {
  test("gets a sentence and no button, and is not asked about again", async () => {
    const asked = folder({});

    const { host, settle } = await card({ path: "보고서/없는 파일.csv" });
    await eventually(
      settle,
      () => host.querySelector('[data-file-state="missing"]') !== null,
    );
    // And a little longer: a second asking, if there were one, would have gone by now.
    await settle(100);

    expect(host.querySelector('[data-file-state="missing"]')?.textContent).toBe(
      "This file is no longer in the Bot's folder.",
    );
    // Still named: the person is told WHICH file is gone.
    expect(host.textContent).toContain("없는 파일.csv");
    expect(linkOf(host)).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    // An answer, not a failure: one asking, no retry.
    expect(asked).toHaveLength(1);
  });

  test("a folder and a path outside each say which, and neither has a button", async () => {
    folder({
      보고서: refused(400, "laf:file_wrong_kind"),
      "../.env": refused(403, "laf:file_path_refused"),
    });
    const first = await card({ path: "보고서" });
    expect(first.host.textContent).toContain("This is a folder, not a file.");
    expect(linkOf(first.host)).toBeNull();
    await first.unmount();

    const second = await card({ path: "../.env" });
    expect(second.host.textContent).toContain(
      "This path cannot be used in the Bot's folder.",
    );
    expect(linkOf(second.host)).toBeNull();
  });

  test("one too large to download says how big it is, and has no button either", async () => {
    folder({ "big.zip": there(6_000_000), "photo.png": there(6_000_000) });

    const { host } = await card({ path: "big.zip" });
    const line = host.querySelector('[data-file-state="too_large"]');
    expect(line?.textContent).toContain("5.7MB");
    expect(line?.textContent).toContain(
      "This file is too large to download from here.",
    );
    expect(linkOf(host)).toBeNull();

    // Nor a picture of it: the route that would draw it refuses the same file.
    const picture = await card({ path: "photo.png" });
    expect(picture.host.querySelector("img")).toBeNull();
  });
});

describe("a file that could not be checked", () => {
  test("says so and offers to ask again — never that it is gone, and never a button to it", async () => {
    let up = false;
    const asked = folder({
      "notes.md": () =>
        up
          ? json({ kind: "file", bytes: 2_048 })
          : json(
              {
                error: "laf:computer_unreachable",
                code: "laf:computer_unreachable",
              },
              503,
            ),
    });

    const { host, settle, press } = await card({ path: "notes.md" });
    await eventually(
      settle,
      () => host.querySelector('[data-file-state="unchecked"]') !== null,
    );

    const unchecked = host.querySelector('[data-file-state="unchecked"]');
    expect(unchecked?.textContent).toContain(
      "The file could not be checked just now.",
    );
    expect(host.textContent).not.toContain("no longer in the Bot's folder");
    expect(linkOf(host)).toBeNull();
    // Asked, and once more by itself: a computer that was restarting is back by then.
    expect(asked).toHaveLength(2);

    up = true;
    const again = host.querySelector("button");
    expect(again?.textContent).toBe("Try again");
    if (!again) throw new Error("no retry button");
    await press(again);
    await eventually(settle, () => linkOf(host) !== null);

    expect(linkOf(host)?.getAttribute("href")).toBe(
      fileAddress("bot-1", "notes.md"),
    );
    expect(host.textContent).toContain("2KB");
  });

  test("where no Bot is in front of the person, nothing is asked and no button is drawn", async () => {
    const asked = folder({ "notes.md": there(10) });
    const { host } = await card({ path: "notes.md" }, { bot: null });
    expect(asked).toEqual([]);
    expect(linkOf(host)).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain(
      "The file could not be checked just now.",
    );
  });
});

describe("a card whose call is still being written", () => {
  test("asks about the path it ends up with, not about every piece of it on the way", async () => {
    const asked = folder({ "reports/sales.csv": there(4_096) });

    // No arguments yet: nothing to ask about.
    const { host, redraw, settle } = await card({});
    expect(host.textContent).toContain("Finding the file…");
    expect(asked).toEqual([]);

    // The path arrives a few characters at a time, faster than it settles.
    for (const piece of [
      "re",
      "reports/",
      "reports/sal",
      "reports/sales.csv",
    ]) {
      await redraw({ path: piece });
      await settle(40);
    }
    // Mid-way it is named and nothing is claimed about it: neither there nor gone.
    expect(host.textContent).toContain("sales.csv");
    expect(host.textContent).toContain("Checking the file…");
    expect(linkOf(host)).toBeNull();
    expect(asked).toEqual([]);

    await eventually(settle, () => linkOf(host) !== null);

    expect(asked).toEqual([
      "/api/computers/bot-1/files/info reports/sales.csv",
    ]);
    expect(linkOf(host)?.getAttribute("download")).toBe("sales.csv");
  });
});

describe("the file's address", () => {
  test("carries the path as a parameter, so a Korean name and a slash are just characters", () => {
    expect(fileAddress("bot-1", "보고서/9월 정산 (2).csv")).toBe(
      `/api/computers/bot-1/files/download?path=${encodeURIComponent("보고서/9월 정산 (2).csv").replaceAll("%20", "+").replaceAll("(", "%28").replaceAll(")", "%29")}`,
    );
    const address = new URL(
      fileAddress("bot-1", "a b/c&d=e.png", { inline: true }),
      "http://app.test",
    );
    expect(address.searchParams.get("path")).toBe("a b/c&d=e.png");
    expect(address.searchParams.get("inline")).toBe("1");
    // And never a second parameter smuggled in by the name.
    expect([...address.searchParams.keys()]).toEqual(["path", "inline"]);
  });
});

/**
 * THE CARD'S WORDS, WALKED. `fileCardSaid` reads its table through `t(variable)`, which
 * `i18n-coverage.test.ts` cannot see.
 */
describe("the card's words", () => {
  test("every sentence it can say has Korean", () => {
    const said = [
      ...Object.values(FILE_CARD_SAID),
      "The file could not be checked just now.",
      "Checking the file…",
      "Finding the file…",
      "File",
      "Download",
      "Try again",
      "Save {name}",
    ];
    expect(said.filter((sentence) => !ko[sentence])).toEqual([]);
    expect(ko.File).toBe("파일");
    expect(ko.Download).toBe("내려받기");
  });

  test("every answer the folder gives about a path has a sentence of the card's own", () => {
    /*
     * The computer's workspace answers (`agent-computer/src/codes.ts`) are a Bot's by the table's
     * own word, and the person meets them here. The disk failing is the one left to the general
     * sentence: nothing about the file was learned, and asking again may work.
     *
     * AND ONE IS NO ANSWER TO ANYTHING A CARD ASKS. A card asks whether a file is there and asks
     * for it; `laf:file_exists` is what a put is told about a path that is taken, and no screen
     * puts a file. A sentence for it here would be one nobody could be shown — named, like the
     * disk's, so that the next workspace answer still has to be decided on this line.
     */
    const NOT_THE_CARDS = ["laf:file_failed", "laf:file_exists"];
    const WORKSPACE = Object.keys(COMPUTER_CODES).filter((code) =>
      code.startsWith("laf:file_"),
    );
    expect(WORKSPACE.length).toBeGreaterThanOrEqual(5);
    expect(
      WORKSPACE.filter(
        (code) => !NOT_THE_CARDS.includes(code) && !(code in FILE_CARD_SAID),
      ),
    ).toEqual([]);
    // Each of the two is still something the computer sends, and neither has crept into the table.
    expect(NOT_THE_CARDS.filter((code) => !WORKSPACE.includes(code))).toEqual(
      [],
    );
    expect(NOT_THE_CARDS.filter((code) => code in FILE_CARD_SAID)).toEqual([]);
    // And the table names nothing the computer does not send.
    expect(
      Object.keys(FILE_CARD_SAID).filter((code) => !WORKSPACE.includes(code)),
    ).toEqual([]);
  });

  test("the model is told the card is on screen, and not to paste the file again", () => {
    const told = GALLERY_CONFIRMATIONS.showFile ?? "";
    expect(told).toContain("on screen");
    expect(told).toContain("Do not paste the file's contents");
  });
});
