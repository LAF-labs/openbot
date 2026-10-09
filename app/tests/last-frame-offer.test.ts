import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  isFrameHeld,
  keepHeldFrames,
  keepLastFrame,
  offerFrame,
} from "@/lib/computer/last-frame";
import { stubFetch } from "./support/fetch";

/**
 * A TASK'S PICTURE THAT IS EARLY IS HELD, NOT RETRIED INTO THE CONSOLE.
 *
 * Stopping the Bot while its step was in this window left the step's result here and nowhere else
 * until the next turn, and the picture was offered five times a step apart — five 404s in the console
 * after every such Stop (0.5.4 final QA). The server now says early (202) for a call it holds without
 * its result, and the picture waits in this window for the turn that carries the result.
 */

const realFetch = globalThis.fetch;
const JPEG = "/9j/4AAQSkZJRg";
let answers: number[] = [];
const puts: string[] = [];
/** What the computer says of the Bot's browser: on its control state, and on the picture itself. */
let control: Record<string, unknown> = {};
let picture: Record<string, unknown> = {};
let pictures = 0;

beforeEach(() => {
  puts.length = 0;
  control = {};
  picture = {};
  pictures = 0;
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/control")) return Response.json(control);
    if (url.includes("/screenshot")) {
      pictures += 1;
      return Response.json({
        base64: JPEG,
        mime: "image/jpeg",
        url: "https://news.daum.net/",
        ...picture,
      });
    }
    puts.push(`${init?.method} ${url}`);
    const status = answers.shift() ?? 500;
    return new Response(status === 204 ? null : "{}", { status });
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("offering a task's last picture", () => {
  test("kept at once is kept, with one PUT", async () => {
    answers = [204];
    expect(await offerFrame("ch-1", "call-now", JPEG, 1)).toBe(true);
    expect(puts).toEqual(["PUT /api/channels/ch-1/frames/call-now"]);
    expect(isFrameHeld("call-now")).toBe(false);
  });

  test("early a moment is offered again and kept", async () => {
    answers = [202, 204];
    expect(await offerFrame("ch-1", "call-soon", JPEG, 1)).toBe(true);
    expect(puts).toHaveLength(2);
    expect(isFrameHeld("call-soon")).toBe(false);
  });

  test("still early is held for the conversation's next turn, which keeps it", async () => {
    answers = [202, 202, 202];
    expect(await offerFrame("ch-1", "call-stopped", JPEG, 1)).toBe(false);
    expect(puts).toHaveLength(3);
    expect(isFrameHeld("call-stopped")).toBe(true);

    // Another conversation's turn does not offer it.
    answers = [];
    keepHeldFrames("ch-2");
    await Bun.sleep(5);
    expect(puts).toHaveLength(3);

    answers = [204];
    keepHeldFrames("ch-1");
    await Bun.sleep(5);
    expect(puts.at(-1)).toBe("PUT /api/channels/ch-1/frames/call-stopped");
    expect(isFrameHeld("call-stopped")).toBe(false);
  });

  test("a call the thread does not hold is asked about once and forgotten", async () => {
    answers = [404, 204];
    expect(await offerFrame("ch-1", "call-none", JPEG, 1)).toBe(false);
    expect(puts).toHaveLength(1);
    expect(isFrameHeld("call-none")).toBe(false);
  });

  /*
   * A TASK THE PERSON STOPPED: a run stopped on the wire keeps its words and not the call it was
   * making (measured), so asking now could only be a 404. The picture is taken and held until the
   * next turn has carried the step's result to the server.
   */
  test("a task its turn was cut off in is pictured now and offered only after the next turn", async () => {
    answers = [];
    expect(
      await keepLastFrame({
        channelId: "ch-3",
        botId: "bot-1",
        toolCallId: "call-cut",
        isCutOff: true,
      }),
    ).toBe(false);
    expect(puts).toEqual([]);
    expect(isFrameHeld("call-cut")).toBe(true);

    answers = [204];
    keepHeldFrames("ch-3");
    await Bun.sleep(5);
    expect(puts).toEqual(["PUT /api/channels/ch-3/frames/call-cut"]);
    expect(isFrameHeld("call-cut")).toBe(false);
  });

  /*
   * A VALUE PUT INTO THE BOT'S BROWSER FOR A PERSON (2026-10-10, record §6). The computer takes it
   * out of every word it answers for the rest of that run, and a picture is not words: a page that
   * shows a sign-in name back shows it in the JPEG that would be kept on the message. So for that
   * long no picture is kept — neither offered, nor held to be offered later.
   */
  test("while a person's value is held in the browser, no picture is asked for", async () => {
    control = { valuesHeld: true };
    answers = [204];
    for (const isCutOff of [false, true]) {
      expect(
        await keepLastFrame({
          channelId: "ch-4",
          botId: "bot-1",
          toolCallId: `call-held-${isCutOff}`,
          isCutOff,
        }),
      ).toBe(false);
      expect(isFrameHeld(`call-held-${isCutOff}`)).toBe(false);
    }
    expect(pictures).toBe(0);
    expect(puts).toEqual([]);
  });

  test("a picture that says a value went in after the control state was read is dropped, not kept and not held", async () => {
    // The state read a moment earlier said nothing: the value went in between the two.
    picture = { valuesHeld: true };
    answers = [204];
    for (const isCutOff of [false, true]) {
      expect(
        await keepLastFrame({
          channelId: "ch-5",
          botId: "bot-1",
          toolCallId: `call-late-${isCutOff}`,
          isCutOff,
        }),
      ).toBe(false);
      expect(isFrameHeld(`call-late-${isCutOff}`)).toBe(false);
    }
    expect(pictures).toBe(2);
    expect(puts).toEqual([]);

    // And the same task without it is kept, so the two above were refused for the reason given.
    picture = {};
    expect(
      await keepLastFrame({
        channelId: "ch-5",
        botId: "bot-1",
        toolCallId: "call-clear",
      }),
    ).toBe(true);
    expect(puts).toEqual(["PUT /api/channels/ch-5/frames/call-clear"]);
  });
});
