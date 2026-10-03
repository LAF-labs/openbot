/**
 * THE APP RUNS IN A WEBVIEW BEFORE IT RUNS IN A BROWSER, and the webview's engine is whatever the
 * person's system ships. The page asks it for one thing before it starts — a pattern that looks
 * behind, which is Safari 16.4 (`lib/engine-floor.ts`) — and an engine that has that can still be
 * without what is listed here. A call an engine does not have throws where it is evaluated — and
 * inside a `try` around a request, that reads as the request failing. A property it does not have
 * reads as nothing, and says nothing at all.
 *
 * Two changes in a row bounded a request with `AbortSignal.timeout` (Safari 16): every read of the
 * conversation's history, and an answer typed to a card. On a system webview without it the first
 * never drew the conversation and the second never sent the answer (review, 2026-10-03). The
 * bound is `deadline` (`lib/deadline.ts`) — a timer and a controller.
 *
 * Looking for the rest of the kind found `URLSearchParams.size` (Safari 17) deciding whether a
 * request had a query at all: without it the cursor was left off every read of the page above,
 * and the page a Bot reads lost its options. This keeps both out.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE = join(import.meta.dir, "..", "src");

/** What is newer than the oldest engine the page starts on, and what stands in for it. */
const NOT_THERE: [pattern: RegExp, instead: string][] = [
  [/AbortSignal\s*\.\s*timeout\s*\(/, "deadline() in lib/deadline.ts"],
  [
    /AbortSignal\s*\.\s*any\s*\(/,
    "one AbortController, aborted from each cause",
  ],
  // By the names a query goes by here; what a `Map` or a `Set` is called is not among them.
  [
    /\b(query|search|searchParams|params)\s*\.\s*size\b/,
    "its toString(), which is empty where it holds nothing",
  ],
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("what the app calls", () => {
  test("is there on the system's webview: nothing a request depends on is newer than some of them", () => {
    const files = sourceFiles(SOURCE);
    // A walk that found nothing would pass by reading nothing.
    expect(files.length).toBeGreaterThan(300);
    const used: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, at) => {
        // Said in a comment is not called.
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
        for (const [pattern, instead] of NOT_THERE) {
          if (pattern.test(line)) {
            used.push(`${relative(SOURCE, file)}:${at + 1} — use ${instead}`);
          }
        }
      });
    }
    expect(used).toEqual([]);
  });

  test("a read of the page above carries its cursor where a query has no `size`", async () => {
    const size = Object.getOwnPropertyDescriptor(
      URLSearchParams.prototype,
      "size",
    );
    const fetched = globalThis.fetch;
    const asked: string[] = [];
    Object.defineProperty(URLSearchParams.prototype, "size", {
      configurable: true,
      get: () => undefined,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      const { readHistory } = await import("../src/lib/turns/client");
      await readHistory("thread-1", 470);
      await readHistory("thread-1", null);
    } finally {
      globalThis.fetch = fetched;
      if (size) Object.defineProperty(URLSearchParams.prototype, "size", size);
    }
    expect(asked).toEqual([
      "/api/turns/thread-1/history?before=470",
      "/api/turns/thread-1/history",
    ]);
  });
});
