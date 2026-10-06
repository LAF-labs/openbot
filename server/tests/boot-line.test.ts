import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sayBooted } from "../src/boot/announce";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * THE BOOT LINE SAYS WHICH KIND OF DEPLOYMENT THIS IS, AND HOW MANY BOTS CAME HOME — A NUMBER, AND
 * NEVER AN ADDRESS.
 *
 * A hosted deployment takes no endpoint of a person's own for a Bot, and dials every Bot at its own
 * agent whatever its row holds (`agents/runtime-agents.ts`). A Bot that was pointed elsewhere before
 * the upgrade therefore changes where it runs at the restart, with nothing on any screen saying so:
 * the page that showed its address is no longer drawn. The first lines of the boot are where an
 * operator looks after an upgrade, so the count is said there.
 *
 * A count, because that is all the line is for. The address a person once typed is theirs, and a
 * log is read by whoever runs the fleet.
 *
 * AND THE SWITCH ITSELF, ALWAYS (the independent read of #121). The line said the count on a hosted
 * deployment and nothing on a developer's stack — and nothing, too, when the count could not be
 * read. So a line without the field was a developer's stack or a hosted deployment that failed a
 * query, and an API started outside compose with the opt-in in its environment looked like either.
 * Now `botEndpoints` is on every boot, by the name `/api/me` gives the app; and the count is there
 * exactly when it is false — a number, or `null` for a read that failed. Absent means one thing.
 */
describe("the boot line, of where Bots run", () => {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const keep = (line: unknown) => {
    raw.push(String(line));
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Not one of the log's own lines.
    }
  };
  let watching: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of watching) spy.mockRestore();
    watching = [];
    lines.length = 0;
    raw.length = 0;
  });
  /** No opt-in: what compose starts. */
  const HOSTED = {};
  /** The private-host opt-in, read under a computer's configuration: a laptop. */
  const DEVELOPERS = {
    AGENT_COMPUTER_URL: "http://localhost:4100",
    AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
  };
  const booted = (
    environment: Record<string, string>,
    botsBroughtHome?: number | null,
  ) => {
    watching = [
      spyOn(console, "log").mockImplementation(keep),
      spyOn(console, "info").mockImplementation(keep),
      spyOn(console, "warn").mockImplementation(keep),
    ];
    sayBooted({
      config: loadConfig(testEnvironment(environment)),
      model: {
        defaultModel: "test/model",
        reviewModel: "test/review",
        supportsEffort: true,
      } as Parameters<typeof sayBooted>[0]["model"],
      port: 3001,
      fleetWebhook: false,
      ...(botsBroughtHome === undefined ? {} : { botsBroughtHome }),
    });
    // The line this call wrote: a case may boot twice.
    const line = lines.filter((entry) => entry.event === "boot").at(-1);
    // And as it was written, since `null` and "not there" are told apart only in the bytes.
    const written = raw.filter((entry) => entry.includes('"event":"boot"'));
    return { line, written: written.at(-1) ?? "" };
  };

  test("says the switch itself on every boot, by the name the app is told", () => {
    expect(booted(HOSTED, 0).line?.botEndpoints).toBe(false);
    expect(booted(DEVELOPERS).line?.botEndpoints).toBe(true);
    // The opt-in with no computer to read it under is no opt-in, here as in `/api/me`.
    expect(
      booted({ AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true" }, 0).line
        ?.botEndpoints,
    ).toBe(false);
    // A computer and no opt-in: what a VM is.
    expect(
      booted({ AGENT_COMPUTER_URL: "http://agent-computer:4100" }, 0).line
        ?.botEndpoints,
    ).toBe(false);
  });

  test("on a hosted deployment says the count, zero included", () => {
    expect(booted(HOSTED, 2).line?.botsBroughtHome).toBe(2);
    // None is said too: "no Bot changed where it runs" is the news an operator wants most.
    const none = booted(HOSTED, 0);
    expect(none.line?.botsBroughtHome).toBe(0);
    expect(none.written).toContain('"botsBroughtHome":0');
    expect(raw.join("\n")).not.toContain("http");
  });

  test("a count that could not be read is said as null: there, and not a number", () => {
    // Handed nothing, and handed null: either way the field is on the line of a hosted boot.
    for (const unread of [undefined, null]) {
      const { line, written } = booted(HOSTED, unread);
      expect(line && "botsBroughtHome" in line).toBe(true);
      expect(line?.botsBroughtHome).toBeNull();
      expect(written).toContain('"botsBroughtHome":null');
      expect(line?.botEndpoints).toBe(false);
    }
  });

  test("on a developer's stack says no count at all, whatever it is handed", () => {
    // No Bot is brought anywhere there: each runs where its row says. Absent means this, only.
    for (const handed of [undefined, null, 0, 3]) {
      const { line, written } = booted(DEVELOPERS, handed);
      expect(line).toBeDefined();
      expect(line && "botsBroughtHome" in line).toBe(false);
      expect(written).not.toContain("botsBroughtHome");
      expect(line?.botEndpoints).toBe(true);
    }
  });
});
