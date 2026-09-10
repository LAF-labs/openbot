import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The concepts `server/src/plugins` implements once, held to once.
 *
 * The audit of 2026-09-10 (A9 §1) counted the copies: the empty-result sentence three times, the
 * unknown-tool sentence six times, the health type twice, the mall-id reader twice, five timeout
 * constants at eight `fetch` sites, four lengths for cutting a vendor's sentence. Each copy was
 * written because the previous one was out of sight, and each drifted on exactly the detail that
 * mattered — Drive's copy of the request helper followed redirects, the one beside it did not.
 *
 * A source walk rather than a type, because a second copy typechecks perfectly. The same shape
 * `mcp-check-mirror.test.ts` uses against the contract document.
 */

const root = join(import.meta.dir, "../src/plugins");

function walk(directory: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
    } else if (entry.endsWith(".ts")) {
      found.push({
        name: relative(root, path),
        text: readFileSync(path, "utf8"),
      });
    }
  }
  return found;
}

const sources = walk(root);

/** Which files say this, so a failure names the copy rather than counting it. */
const filesSaying = (needle: string | RegExp): string[] =>
  sources
    .filter(({ text }) =>
      typeof needle === "string" ? text.includes(needle) : needle.test(text),
    )
    .map(({ name }) => name)
    .sort();

describe("one shape for the plugins directory", () => {
  test("the sentence for an empty result is written once, for every transport", () => {
    expect(filesSaying("The tool returned no content")).toEqual(["mcp.ts"]);
  });

  test("the sentence for a tool an adapter does not implement is written once", () => {
    expect(filesSaying("is not a tool this connector implements")).toEqual([
      "rest-support.ts",
    ]);
  });

  test("no fetch site spells its own timeout", () => {
    // Every bound lives in `timeouts.ts` and is read from there by name.
    expect(filesSaying(/AbortSignal\.timeout\(\s*\d/)).toEqual([]);
    expect(filesSaying(/TIMEOUT_MS\s*=\s*\d/)).toEqual([]);
  });

  test("a vendor's sentence is cut to one length, in one place", () => {
    expect(filesSaying(/\.slice\(0,\s*(300|400)\)/)).toEqual([]);
    expect(filesSaying("VENDOR_DETAIL_CHARS =")).toEqual(["mcp.ts"]);
  });

  test("the health of a connection is one type and one judgement", () => {
    expect(filesSaying(/export type ConnectionHealth\b/)).toEqual(["store.ts"]);
    // What `invalid_grant` MEANS is decided here and nowhere else.
    expect(filesSaying(/=== "invalid_grant"/)).toEqual([
      "connection-health.ts",
    ]);
    expect(filesSaying(/needsReconnect\s*=|function needsReconnect/)).toEqual([
      "connection-health.ts",
    ]);
  });

  test("the mall id is read back by one function", () => {
    expect(filesSaying(/function instanceNameOf|const instanceNameOf/)).toEqual(
      ["catalogue.ts"],
    );
  });

  test("no adapter carries a private request helper", () => {
    // The shape Drive kept from before `rest-support.ts` existed: its own `fetch`, its own
    // `asResult`, its own `failure`. The transports that speak HTTP themselves are named.
    expect(filesSaying(/\bawait fetch\(/)).toEqual([
      "alimtalk/solapi.ts",
      "connections.ts",
      "mcp.ts",
      "oauth-client.ts",
      "oauth.ts",
      "rest-support.ts",
    ]);
    expect(filesSaying(/^function asResult\(|^const failure = /m)).toEqual([]);
  });
});
