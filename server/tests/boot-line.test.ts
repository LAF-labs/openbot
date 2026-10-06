import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sayBooted } from "../src/boot/announce";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * THE BOOT LINE SAYS HOW MANY BOTS CAME HOME — A NUMBER, AND NEVER AN ADDRESS.
 *
 * A hosted deployment takes no endpoint of a person's own for a Bot, and dials every Bot at its own
 * agent whatever its row holds (`agents/runtime-agents.ts`). A Bot that was pointed elsewhere before
 * the upgrade therefore changes where it runs at the restart, with nothing on any screen saying so:
 * the page that showed its address is no longer drawn. The first lines of the boot are where an
 * operator looks after an upgrade, so the count is said there.
 *
 * A count, because that is all the line is for. The address a person once typed is theirs, and a
 * log is read by whoever runs the fleet.
 */
describe("the boot line, of Bots whose rows hold another address", () => {
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
  const booted = (botsBroughtHome: number | undefined) => {
    watching = [
      spyOn(console, "log").mockImplementation(keep),
      spyOn(console, "info").mockImplementation(keep),
      spyOn(console, "warn").mockImplementation(keep),
    ];
    sayBooted({
      config: loadConfig(testEnvironment()),
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
    return lines.filter((line) => line.event === "boot").at(-1);
  };

  test("says the count where there is one to say, zero included", () => {
    expect(booted(2)?.botsBroughtHome).toBe(2);
    // None is said too: "no Bot changed where it runs" is the news an operator wants most.
    expect(booted(0)?.botsBroughtHome).toBe(0);
    expect(raw.join("\n")).not.toContain("http");
  });

  test("says nothing of it where no Bot is brought anywhere, or the rows could not be read", () => {
    const line = booted(undefined);
    expect(line).toBeDefined();
    expect(line && "botsBroughtHome" in line).toBe(false);
  });
});
