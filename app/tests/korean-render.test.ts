import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * WHAT A KOREAN SCREEN SAYS, READ OFF A KOREAN SCREEN.
 *
 * `bun test` runs every file in one process, and the locale is decided once, when the dictionary is
 * first loaded — by some other file, in English. So the facts below, which exist only in Korean, were
 * either not tested or tested by walking source. `support/korean-render.tsx` renders them in a
 * process of its own, with Korean chosen before anything loads, and hands back what was shown.
 *
 * A BOT'S NAME TAKES THE PARTICLE ITS LAST SOUND ASKS FOR — ON THE LOCK SCREEN, IN THE ROOM, AND ON
 * THE PAGE THE NOTICE OPENS.
 *
 * MEASURED 2026-09-10 (audit A4, finding 7): "닻이(가) 기다립니다" went to the OS notification centre,
 * the first sentence a person reads from this product outside its window, and "{name}이(가) 답을
 * 기다리고 있어요" sat on a room's approval card. `lib/josa.ts` had existed since W3b for exactly this;
 * the two entries carrying a Bot's name were left out of it.
 *
 * Read: the titles the real notification hook raised from the outbox, the room's approval cards,
 * and the heading of `/approve/:id`.
 *
 * AND THE ROSTER'S TIMES ARE KOREAN ON A MACHINE THAT IS NOT. `toLocaleTimeString()` with no
 * argument answers in the machine's locale, so a Korean app on an en-US machine printed "Sat" and
 * "9/6" down a column of Korean names (`sidebar-rail.test.tsx` walked the call sites for this; the
 * render is the fact).
 */

/** Ten names, and the particle each one's last sound asks for. */
const NAMES: [name: string, particle: "이" | "가"][] = [
  ["닻", "이"], // ㄺ
  ["초롱", "이"], // ㅇ
  ["조약돌", "이"], // ㄹ
  ["단풍", "이"],
  ["나비", "가"],
  ["김비서", "가"],
  ["Amy", "가"], // read as ㅣ
  ["Slack", "이"], // read as ㄱ
  ["3번 창고", "가"], // 고
  ["비서7", "이"], // 칠
];

let rendering: Promise<Rendered> | undefined;

type Rendered = {
  notices: string[];
  cards: string[];
  headings: string[];
  times: string[];
};

/** One Korean process for the whole file: it mounts the route tree several times over. */
function renderedInKorean(): Promise<Rendered> {
  rendering ??= render();
  return rendering;
}

async function render(): Promise<Rendered> {
  const script = join(import.meta.dir, "support/korean-render.tsx");
  const child = Bun.spawn(
    ["bun", script, JSON.stringify(NAMES.map(([name]) => name))],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("KOREAN_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the Korean render did not finish (exit ${status}):\n${stderr.slice(-2000)}`,
    );
  }
  return JSON.parse(line.slice("KOREAN_RENDER ".length)) as Rendered;
}

describe("a Bot's name in Korean", () => {
  test("takes 이 or 가 by its last sound, everywhere a waiting Bot is announced", async () => {
    const shown = await renderedInKorean();

    const titles = NAMES.map(
      ([name, particle]) => `${name}${particle} 기다립니다`,
    );
    // The notices arrive oldest first; which name comes first is not the point.
    expect([...shown.notices].sort()).toEqual([...titles].sort());
    expect(shown.headings).toEqual(titles);
    expect(shown.cards).toHaveLength(NAMES.length);
    NAMES.forEach(([name, particle], index) => {
      expect(
        shown.cards[index]?.startsWith(
          `${name}${particle} 답을 기다리고 있어요:`,
        ),
      ).toBe(true);
    });

    // And nothing anywhere still spells the form letter, or leaves a slot unfilled.
    for (const text of [...shown.notices, ...shown.cards, ...shown.headings]) {
      expect(text).not.toContain("(가)");
      expect(text).not.toContain("{josa}");
    }
  }, 120_000);
});

describe("the roster's times on a machine whose own locale is English", () => {
  test("are written the Korean way: today's clock, this week's weekday, an older date", async () => {
    const { times } = await renderedInKorean();
    const [today, thisWeek, older] = times;
    expect(today).toMatch(/^(오전|오후) \d{1,2}:\d{2}$/);
    expect(thisWeek).toMatch(/^[월화수목금토일]$/);
    expect(older).toMatch(/^\d{1,2}\. \d{1,2}\.$/);
  }, 120_000);
});
