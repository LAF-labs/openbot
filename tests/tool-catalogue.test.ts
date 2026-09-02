import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTER_TOOLS,
  type ComputerTool,
  computerTool,
} from "../shared/tools/computer";
import { asStandardSchema } from "../shared/tools/standard-schema";
import * as evalTools from "../evals/tools";

/**
 * One catalogue, three consumers, and this is what says so.
 *
 * IDENTITY, NOT A MIRROR. There used to be three hand-copied lists — the browser's registrations,
 * the server's unattended loop, and the eval pack — with a banner in each asking whoever changed
 * one to change the others. They had already drifted: `computer_snapshot` read differently in the
 * eval than in the product, and `computer_read_file` told a Bot its workspace survives "between
 * conversations" in one place and "between runs" in another. So a Bot behaved differently at six
 * in the morning than at noon for no reason anybody could point to, and the eval certified words
 * nobody was ever sent.
 *
 * A mirror test — "these two strings are equal" — is what `mcp-check-mirror.test.ts` does for a
 * contract this repository does not own. This one can be stronger, because we own both ends: the
 * assertion is that the consumers hold THE SAME OBJECT.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Every `description:` in a file whose value is a literal rather than a forward. */
function descriptionLiteralsIn(source: string): string[] {
  return [...source.matchAll(/description:\s*("|`)/g)].map((match) => match[0]);
}

/** The catalogue entry for a name, refusing to compare against a lookup that found nothing. */
function tool(name: string): ComputerTool {
  const found = computerTool(name);
  if (!found) throw new Error(`The catalogue has no tool named ${name}.`);
  return found;
}

describe("the computer tool catalogue", () => {
  test("the eval pack holds the catalogue's own objects", () => {
    // `toBe`, not `toEqual`: a copy with identical fields is exactly the failure being prevented.
    expect(evalTools.NAVIGATE).toBe(tool("computer_navigate"));
    expect(evalTools.SNAPSHOT).toBe(tool("computer_snapshot"));
    expect(evalTools.READ_FILE).toBe(tool("computer_read_file"));
    expect(evalTools.ALL_COMPUTER_TOOLS).toBe(COMPUTER_TOOLS);
  });

  /*
   * The other two consumers are asserted through their source, because one is a React hook that
   * needs a DOM and the other needs a gateway. What matters is the same thing either way: neither
   * writes a name, a description or a schema of its own.
   */
  test("the surface registers from the catalogue and describes nothing itself", () => {
    const source = read("app/src/lib/copilot/computer-tools.tsx");
    expect(source).toContain('from "@shared/tools/computer"');
    /*
     * One registration per tool, each naming a catalogue entry. Counted rather than matched
     * shape-by-shape: the formatter wraps a long generic argument onto its own line, so a check
     * that expected `fromCatalogue<…>("name")` on one line broke on a `bun run format`.
     */
    const registered = [
      ...source.matchAll(/fromCatalogue<[\s\S]*?>\(\s*"([a-z_]+)"/g),
    ].map((match) => match[1]);
    expect(registered.sort()).toEqual(
      COMPUTER_TOOLS.map((tool) => tool.name).sort(),
    );
    /*
     * Not one description WRITTEN here. `description: tool.description` is a forward; a string
     * literal beside that key would be a second set of words, which is the drift this ends.
     */
    expect(descriptionLiteralsIn(source)).toEqual([]);
  });

  test("the unattended loop imports the catalogue rather than repeating it", () => {
    const source = read("server/src/runner/unattended.ts");
    expect(source).toContain('from "../../../shared/tools/computer"');
    expect(descriptionLiteralsIn(source)).toEqual([]);
  });

  /**
   * A person-only tool is excluded by a property, not by a hand-kept list.
   *
   * The exclusion used to be a comment and a copied array, and the prompt disagreed with it — the
   * base prompt told every Bot to call `computer_request_help` when it got stuck, in runs that are
   * never given it.
   */
  test("the tools that need a person are the ones a routine does not get", async () => {
    const { UNATTENDED_COMPUTER_TOOLS } = await import(
      "../shared/tools/computer"
    );
    const excluded = COMPUTER_TOOLS.filter(
      (tool) => !UNATTENDED_COMPUTER_TOOLS.includes(tool),
    ).map((tool) => tool.name);
    expect(excluded.sort()).toEqual([
      "computer_request_help",
      "computer_request_secret",
    ]);
  });

  /** Registered nowhere, and now in no contract either. */
  test("does not name a tool nothing implements", () => {
    expect(computerTool("computer_screenshot")).toBeUndefined();
    expect(computerTool("report_refusal")).toBeUndefined();
  });

  test("every tool has a name, a description and an object schema", () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(tool.name).toMatch(/^computer_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe("object");
    }
  });

  /**
   * The schema goes to the model as JSON, so nothing may ride along on it.
   *
   * The surface's registration hook takes a Standard Schema and the wire takes JSON Schema; the
   * adapter wraps rather than decorates, precisely so a `~standard` key cannot end up serialised
   * into the contract the model reads.
   */
  test("the surface adapter leaves the wire schema untouched", () => {
    for (const tool of COMPUTER_TOOLS) {
      const wrapped = asStandardSchema(tool.parameters);
      expect(wrapped.toJSONSchema()).toBe(tool.parameters);
      expect(JSON.parse(JSON.stringify(tool.parameters))).not.toHaveProperty(
        "~standard",
      );
    }
  });
});
