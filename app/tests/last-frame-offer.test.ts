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

beforeEach(() => {
  puts.length = 0;
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/control")) return new Response("{}", { status: 200 });
    if (url.includes("/screenshot")) {
      return Response.json({
        base64: JPEG,
        mime: "image/jpeg",
        url: "https://news.daum.net/",
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
});
