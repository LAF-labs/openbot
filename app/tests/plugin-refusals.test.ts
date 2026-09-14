import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import { COMPONENT_ADMIN_REFUSALS } from "../src/lib/components/queries";
import { ko } from "../src/lib/i18n-ko";
import { callPluginTool } from "../src/lib/plugins/queries";
import {
  PLUGIN_ADMIN_REFUSALS,
  SKILL_REFUSALS,
} from "../src/lib/plugins/refusals";
import { ACCESS_REFUSALS, refusalFrom, refusalText } from "../src/lib/refusals";
import { PLAYGROUND_REFUSALS } from "../src/lib/sandboxed/queries";
import { stubFetch } from "./support/fetch";

/**
 * The rest of the server's refusals, on the screens that print them.
 *
 * Until 2026-09-14 everything outside the six directories wave 1 walked still answered English: the
 * guard's "Authentication required." on every protected route, the plugin routes' thirty-three
 * sentences, the component and playground routes' fourteen. The skill form, a skill's Bot list, the
 * skills page, 스킬로 저장, the admin Plugins, Components and Playground pages printed them as they
 * came. The server sends codes now and these tables own the sentences.
 *
 * `t()` on a variable is invisible to `i18n-coverage.test.ts`, so each table is walked here — against
 * the server's own source, read as text, so a code added there fails here until somebody decides what
 * it says in Korean. Which file each table is held to is the list below; a code a screen never draws
 * is named, with the reason, rather than left out of the count.
 */

const server = (path: string) =>
  Bun.file(new URL(`../../server/src/${path}`, import.meta.url)).text();

/** `export const NAME = "laf:…"`, by name, from one file. */
async function constants(path: string): Promise<Map<string, string>> {
  const source = await server(path);
  return new Map(
    [
      ...source.matchAll(
        /export const ([A-Z_]+)(?::[^=]+)? =\s*"(laf:[a-z_]+)"/g,
      ),
    ].map((match) => [match[1] as string, match[2] as string]),
  );
}

const codesOf = (found: Map<string, string>, except: string[] = []) =>
  [...found.entries()]
    .filter(([name]) => !except.includes(name))
    .map(([, code]) => code);

const missingFrom = (table: Record<string, string>, codes: string[]) =>
  codes.filter((code) => !(code in table) && !(code in ACCESS_REFUSALS));

const TABLES = {
  ACCESS_REFUSALS,
  SKILL_REFUSALS,
  PLUGIN_ADMIN_REFUSALS,
  PLAYGROUND_REFUSALS,
  COMPONENT_ADMIN_REFUSALS,
};

describe("the refusal copy", () => {
  test("every sentence in every table has Korean, and none of them is a code", () => {
    for (const [name, table] of Object.entries(TABLES)) {
      expect(Object.keys(table).length).toBeGreaterThan(2);
      for (const [code, sentence] of Object.entries(table)) {
        expect({ name, code, korean: sentence in ko }).toEqual({
          name,
          code,
          korean: true,
        });
        expect(sentence).not.toContain("laf:");
      }
    }
  });

  test("the three every route can answer are exactly the session guard's", async () => {
    const guards = await constants("auth/guards.ts");
    const facts = ["UNAUTHENTICATED", "NO_ACCESS", "ADMIN_REQUIRED"].map(
      (name) => guards.get(name),
    );
    expect(facts.every(Boolean)).toBe(true);
    expect(Object.keys(ACCESS_REFUSALS).sort()).toEqual(
      (facts as string[]).sort(),
    );
  });

  test("the skill screens name every refusal writing, deleting or granting a skill can meet", async () => {
    const routes = await constants("plugins/routes.ts");
    const codes = [...routes.entries()]
      .filter(([name]) => /^(SKILL_|GRANT_|BOT_NOT_OWNED)/.test(name))
      .map(([, code]) => code);
    expect(codes.length).toBeGreaterThan(5);
    // The body names a Bot, and a Bot that is not this person's is answered as one that is not there.
    expect(
      missingFrom(SKILL_REFUSALS, [...codes, "laf:bot_not_found"]),
    ).toEqual([]);
  });

  test("the admin Plugins page names every refusal adding, refreshing or granting a server can meet", async () => {
    const catalogue = await server("plugins/catalogue.ts");
    const union = catalogue.match(/export type CustomUrlRefusal =([^;]+);/);
    if (!union?.[1]) throw new Error("CustomUrlRefusal is not where it was.");
    const addressRefusals = [...union[1].matchAll(/"(laf:[a-z_]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(addressRefusals.length).toBeGreaterThan(6);

    const codes = [
      // The two the Bot's own tool call answers, in the model's words (below), never on this page.
      ...codesOf(await constants("plugins/routes.ts"), [
        "CALL_INCOMPLETE",
        "TOOL_SERVER_FAILED",
      ]),
      ...codesOf(await constants("plugins/servers.ts")),
      ...codesOf(await constants("plugins/oauth-client.ts")),
      ...codesOf(await constants("plugins/store.ts"), ["TOOL_NEEDS_REVIEW"]),
      ...addressRefusals,
      // Written in place on `POST /servers`, for an entry this machine holds no key for.
      "laf:deployment_key_missing",
    ];
    expect(missingFrom(PLUGIN_ADMIN_REFUSALS, codes)).toEqual([]);
  });

  test("the playground names every refusal saving, publishing or deleting can meet", async () => {
    const codes = [
      ...codesOf(await constants("components/sandboxed-routes.ts")),
      ...codesOf(await constants("components/sandboxed.ts")),
      // Not found, said the way a compiled component's absence is (`COMPONENT_UNKNOWN`).
      "laf:component_unknown",
    ];
    expect(codes.length).toBeGreaterThan(2);
    expect(missingFrom(PLAYGROUND_REFUSALS, codes)).toEqual([]);
  });

  test("the admin Components page names every refusal its changes can meet", async () => {
    const codes = [
      // The browser announcing its own build sends the list, and ignores a refusal of it.
      ...codesOf(await constants("components/routes.ts"), [
        "COMPONENT_LIST_REQUIRED",
      ]),
      "laf:component_unknown",
      "laf:function_unknown",
    ];
    expect(missingFrom(COMPONENT_ADMIN_REFUSALS, codes)).toEqual([]);
  });

  test("every code the tool-call door answers has words for the model", async () => {
    const routes = await constants("plugins/routes.ts");
    const store = await constants("plugins/store.ts");
    const guards = await constants("auth/guards.ts");
    const codes = [
      routes.get("CALL_INCOMPLETE"),
      routes.get("TOOL_SERVER_FAILED"),
      store.get("SERVER_UNKNOWN"),
      store.get("TOOL_UNKNOWN"),
      store.get("TOOL_NEEDS_REVIEW"),
      guards.get("UNAUTHENTICATED"),
      guards.get("NO_ACCESS"),
    ];
    expect(codes.every(Boolean)).toBe(true);
    expect(
      (codes as string[]).filter((code) => !(code in TOOL_RESULT_KO)),
    ).toEqual([]);
  });

  test("a code with no words gets the screen's own sentence, and the guard's three reach every screen", async () => {
    // Under a test runner `t()` answers in English, handing back its own key.
    expect(refusalText(SKILL_REFUSALS, "laf:something_new", "fallback")).toBe(
      "fallback",
    );
    expect(refusalText(SKILL_REFUSALS, undefined, "fallback")).toBe("fallback");
    expect(
      refusalText(PLAYGROUND_REFUSALS, "laf:admin_required", "fallback"),
    ).toBe("Only an administrator can do that.");
    // Read off a body, and never its `error`: that is the code itself.
    await expect(
      refusalFrom(
        new Response(
          JSON.stringify({
            error: "laf:skill_not_yours",
            code: "laf:skill_not_yours",
          }),
          { status: 403 },
        ),
        SKILL_REFUSALS,
        "fallback",
      ),
    ).resolves.toBe(SKILL_REFUSALS["laf:skill_not_yours"] as string);
    await expect(
      refusalFrom(
        new Response("<html>", { status: 502 }),
        SKILL_REFUSALS,
        "fallback",
      ),
    ).resolves.toBe("fallback");
  });
});

describe("a Bot's tool call that was refused or failed", () => {
  let realFetch: typeof fetch;
  let reply: () => Response = () => new Response("{}", { status: 200 });

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => reply());
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const answered = (status: number, body: Record<string, unknown>) => () =>
    new Response(JSON.stringify(body), { status });

  test("a vendor's failure is a failure, in the model's words, and not a refusal", async () => {
    reply = answered(502, {
      error: "laf:tool_server_failed",
      code: "laf:tool_server_failed",
      failed: true,
      status: 403,
    });

    const outcome = await callPluginTool("notion/search", {}, "agent_1");

    expect(outcome).toEqual({
      ok: false,
      refused: false,
      reason: TOOL_RESULT_KO["laf:tool_server_failed"] as string,
    });
  });

  test("a server that is gone, and a definition waiting for review, are refusals in the model's words", async () => {
    for (const [status, code] of [
      [404, "laf:server_unknown"],
      [403, "laf:tool_needs_review"],
    ] as const) {
      reply = answered(status, { error: code, code, rule: null });
      const outcome = await callPluginTool("notion/search", {}, "agent_1");
      expect(outcome).toEqual({
        ok: false,
        refused: true,
        reason: TOOL_RESULT_KO[code] as string,
        rule: null,
      });
    }
  });
});
