import { describe, expect, test } from "bun:test";
import {
  createDownloadLimit,
  type DownloadVerdict,
} from "../src/download-limit";

/**
 * The limit a download is held to while it arrives, without a browser: the tab's events and
 * Playwright's `download` are two strings and some numbers here. The real browser, and the disk, are
 * in download-bound.test.ts.
 */

const LIMIT = 1_000_000;

const named = (url: string, name: string) => ({
  url: () => url,
  suggestedFilename: () => name,
});

/** What the verdict is by now, or "running" when it has not settled. */
async function verdictOf(
  verdict: Promise<DownloadVerdict>,
): Promise<DownloadVerdict | "running"> {
  return Promise.race([
    verdict,
    new Promise<"running">((resolve) =>
      setTimeout(() => resolve("running"), 20),
    ),
  ]);
}

describe("a download held to the workspace's limit", () => {
  test("is stopped once the bytes that arrived pass it", async () => {
    const limit = createDownloadLimit({ limitBytes: LIMIT });
    limit.progress({
      guid: "g1",
      url: "https://a.test/dl",
      suggestedFilename: "x.pdf",
    });
    const held = limit.watch(named("https://a.test/dl", "x.pdf"));
    limit.progress({ guid: "g1", receivedBytes: 400_000, state: "inProgress" });
    expect(await verdictOf(held.verdict)).toBe("running");
    limit.progress({
      guid: "g1",
      receivedBytes: 1_200_000,
      state: "inProgress",
    });
    expect(await verdictOf(held.verdict)).toBe("too_large");
  });

  test("is stopped at once when the size it announced is already too much", async () => {
    const limit = createDownloadLimit({ limitBytes: LIMIT });
    const held = limit.watch(named("https://a.test/big.zip", "big.zip"));
    // Playwright's event first, the tab's after: the two arrive in either order.
    limit.progress({
      guid: "g2",
      url: "https://a.test/big.zip",
      suggestedFilename: "big.zip",
    });
    limit.progress({ guid: "g2", totalBytes: 2_000_000_000, receivedBytes: 0 });
    expect(await verdictOf(held.verdict)).toBe("too_large");
  });

  test("is let alone under the limit, and let go once it is done", async () => {
    const limit = createDownloadLimit({ limitBytes: LIMIT });
    limit.progress({
      guid: "g3",
      url: "https://a.test/a.csv",
      suggestedFilename: "a.csv",
    });
    const held = limit.watch(named("https://a.test/a.csv", "a.csv"));
    limit.progress({
      guid: "g3",
      totalBytes: 5_000,
      receivedBytes: 5_000,
      state: "completed",
    });
    held.done();
    expect(await verdictOf(held.verdict)).toBe("running");
  });

  test("is stopped when it is still going at its time, however slowly it trickles", async () => {
    const limit = createDownloadLimit({ limitBytes: LIMIT, maxMs: 30 });
    limit.progress({
      guid: "g4",
      url: "https://a.test/slow",
      suggestedFilename: "slow",
    });
    const held = limit.watch(named("https://a.test/slow", "slow"));
    limit.progress({ guid: "g4", receivedBytes: 10 });
    await Bun.sleep(60);
    expect(await verdictOf(held.verdict)).toBe("too_slow");
  });

  test("one download's bytes are never another's", async () => {
    const limit = createDownloadLimit({ limitBytes: LIMIT });
    limit.progress({
      guid: "small",
      url: "https://a.test/a.csv",
      suggestedFilename: "a.csv",
    });
    limit.progress({
      guid: "huge",
      url: "https://a.test/b.iso",
      suggestedFilename: "b.iso",
    });
    const small = limit.watch(named("https://a.test/a.csv", "a.csv"));
    const huge = limit.watch(named("https://a.test/b.iso", "b.iso"));
    limit.progress({ guid: "huge", receivedBytes: 50_000_000 });
    expect(await verdictOf(huge.verdict)).toBe("too_large");
    expect(await verdictOf(small.verdict)).toBe("running");
    small.done();
  });
});
