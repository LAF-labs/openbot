import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeFrame,
  paintFrame,
} from "../src/components/computer/frame-bitmap";

/**
 * The one place a frame from the Bot's computer becomes pixels.
 *
 * Both views of the same computer decode here now — the socket the full-size view runs on and the
 * poll the inline card runs on. What that is NOT is a speed-up, and the module comment carries the
 * measurement rather than the claim: over 48 distinct 1280x800 PNG frames in Chrome, the `<img>`
 * plus data URL path this replaced ran at 1.2–1.7ms a frame against 3.6–3.9ms here, and a
 * requestAnimationFrame ticker recorded no gap over 32ms on either. What it buys is one decode path
 * and no 90KB picture of somebody's screen sitting in a DOM attribute.
 *
 * The conversion is worth its own test because the obvious spelling is the slow one:
 * `Uint8Array.from(atob(s), c => c.charCodeAt(0))` calls back into JS once per byte and measured
 * 5.9–6.5ms a frame — 39% more than the plain loop, at screencast rates, on the main thread.
 */

type Stub = { close: () => void; width: number; height: number };

const original = (globalThis as { createImageBitmap?: unknown })
  .createImageBitmap;

afterEach(() => {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = original;
});

/** Stand in for the browser's decoder and record exactly what it was handed. */
function stubDecoder(
  onBlob: (blob: Blob) => void,
  result: Stub | Error = { close: () => {}, width: 1280, height: 800 },
) {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (
    blob: Blob,
  ) => {
    onBlob(blob);
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("decoding a frame", () => {
  test("hands the decoder the bytes, not the base64 text", async () => {
    const bytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128,
    ]);
    const base64 = btoa(String.fromCharCode(...bytes));
    let seen: Blob | null = null;
    stubDecoder((blob) => {
      seen = blob;
    });

    await decodeFrame(base64, "image/png");

    expect(seen).not.toBeNull();
    const blob = seen as unknown as Blob;
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test("keeps the type it was given, because the two views send different ones", async () => {
    // The socket sends JPEG and the poll sends PNG; a hardcoded type here decodes one of them wrong.
    let seen: Blob | null = null;
    stubDecoder((blob) => {
      seen = blob;
    });
    await decodeFrame(btoa("whatever"), "image/jpeg");
    expect((seen as unknown as Blob).type).toBe("image/jpeg");
  });

  test("a frame that is not an image is null, not a thrown poll loop", async () => {
    // One corrupt frame is a frame to drop. The loop that fetches the next one must keep running.
    stubDecoder(() => {}, new Error("The source image could not be decoded."));
    expect(await decodeFrame(btoa("not an image"), "image/png")).toBeNull();
  });

  test("bytes that are not base64 at all are null too", async () => {
    stubDecoder(() => {});
    expect(await decodeFrame("!!!! not base64 !!!!", "image/png")).toBeNull();
  });
});

describe("painting a frame", () => {
  test("sizes the canvas to the frame so nothing is scaled twice", () => {
    const drawn: unknown[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]) => drawn.push(args),
      }),
    };

    paintFrame(
      canvas as unknown as HTMLCanvasElement,
      {
        width: 1280,
        height: 800,
      } as unknown as ImageBitmap,
    );

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(800);
    expect(drawn).toHaveLength(1);
    // Top left, unscaled: the CSS `object-contain` on the element does the fitting.
    expect((drawn[0] as unknown[]).slice(1)).toEqual([0, 0]);
  });

  test("a canvas with no 2d context is survivable", () => {
    const canvas = { width: 0, height: 0, getContext: () => null };
    expect(() =>
      paintFrame(
        canvas as unknown as HTMLCanvasElement,
        {
          width: 10,
          height: 10,
        } as unknown as ImageBitmap,
      ),
    ).not.toThrow();
  });
});

const DIR = join(import.meta.dir, "../src/components/computer");
const strip = (name: string) =>
  readFileSync(join(DIR, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("both views of one computer decode the same way", () => {
  test("neither builds a data URL of a screenshot any more", () => {
    expect(strip("computer-view.tsx")).not.toContain("data:image/png;base64,");
    expect(strip("live-screen.tsx")).not.toContain("data:image");
  });

  test("both go through this module", () => {
    for (const file of ["computer-view.tsx", "live-screen.tsx"]) {
      expect(strip(file)).toContain("./frame-bitmap");
      expect(strip(file)).toContain("decodeFrame(");
      expect(strip(file)).toContain("paintFrame(");
    }
  });

  test("the per-byte callback conversion stays gone", () => {
    // Measured at 5.9–6.5ms a frame against 3.6–3.9ms for the loop below it.
    const module = strip("frame-bitmap.ts");
    expect(module).not.toContain("Uint8Array.from(");
    expect(module).toContain("charCodeAt(i)");
  });

  test("the inline card paints before it says there is a screenshot", () => {
    // Otherwise the canvas is mounted empty for a whole poll interval where the picture is about
    // to be — the same blank the old code used `preloadFrame` to avoid.
    const view = strip("computer-view.tsx");
    expect(view.indexOf("paintFrame(canvas, bitmap)")).toBeLessThan(
      view.indexOf("setShot(next)"),
    );
  });
});
