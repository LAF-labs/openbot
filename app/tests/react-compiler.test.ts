import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  formatCoverage,
  type Module,
  measureCompilerCoverage,
  measureModule,
} from "./support/compiler-coverage";

/**
 * A CEILING ON WHAT THE REACT COMPILER LEAVES UNCOMPILED — THE TEST FLOORS, UPSIDE DOWN.
 *
 * The build runs every component and hook through `babel-plugin-react-compiler`, and a function the
 * compiler cannot prove follows the rules of React is left exactly as written. Nothing says so: the
 * build passes, the screen works, and that component goes on re-rendering everything under it the
 * way the whole app did before the compiler. So the number is counted here, over every module the
 * build compiles, and it may only go down.
 *
 * `bun test app/tests/react-compiler.test.ts` prints the count and every skipped function with the
 * compiler's own reason. A skip that is a real violation — a ref read while rendering, a value
 * mutated after it was handed to JSX — is fixed. A skip the code means, or one the compiler cannot
 * yet handle, stays, with a comment beside it saying which. Lower the ceiling in the change that
 * removes a skip; raising it is a skip nobody decided to keep.
 *
 * WHAT THIS DOES NOT SEE. The app's tests run under `bun test`, which never applies the compiler:
 * every component a test renders is the uncompiled one. What the compiler does to a component is
 * seen only in `vite dev` and `vite build`.
 */

/**
 * MEASURED 2026-09-18, with the compiler first turned on: 305 of 332 components and hooks compiled.
 * The 27 left were twelve rule violations (ten reading or writing a ref while rendering, two
 * mutating a value after render) and fifteen things the compiler does not handle yet (`try` with
 * no `catch` or with a `finally`, `??=`, a conditional inside a `try`).
 */
const SKIPPED_CEILING = 17;

const APP = join(import.meta.dir, "..");

/** Every module under `src` the build hands to the compiler: sources, not tests or declarations. */
async function appModules(): Promise<Module[]> {
  const modules: Module[] = [];
  for await (const path of new Glob("src/**/*.{ts,tsx}").scan({ cwd: APP })) {
    if (/\.d\.ts$|\.(test|spec)\.tsx?$/.test(path)) continue;
    modules.push({ path, source: readFileSync(join(APP, path), "utf8") });
  }
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

describe("how much of the app the React Compiler compiles", () => {
  test("no more functions are skipped than the ceiling allows", async () => {
    const coverage = await measureCompilerCoverage(await appModules());
    console.log(formatCoverage(coverage));

    // A compiler that logged nothing would sit under any ceiling by measuring nothing.
    expect(coverage.modules).toBeGreaterThan(0);
    expect(coverage.compiled).toBeGreaterThan(0);

    // "use no memo" is allowed, and never silently: the comment above it is the decision.
    expect(
      coverage.skipped
        .filter((skip) => skip.unexplained)
        .map((skip) => `${skip.path}:${skip.line} ${skip.name}`),
    ).toEqual([]);

    const skipped = coverage.skipped.length;
    if (skipped > SKIPPED_CEILING) {
      throw new Error(
        `${skipped} functions were left uncompiled, and the ceiling is ${SKIPPED_CEILING}. The list is ` +
          "above. Fix the new one, or, if the code means it, say why beside it — and only then raise " +
          "SKIPPED_CEILING in app/tests/react-compiler.test.ts.",
      );
    }
    if (skipped < SKIPPED_CEILING) {
      console.log(
        `Only ${skipped} skipped: lower SKIPPED_CEILING to ${skipped} in the change that fixed the rest.`,
      );
    }
  }, 120_000);
});

describe("the check itself", () => {
  test("names a function that breaks a rule, and says which rule", async () => {
    const result = await measureModule({
      path: "fixture.tsx",
      source: [
        'import { useRef } from "react";',
        "export const Label = ({ text }: { text: string }) => <span>{text}</span>;",
        "export const Counter = () => {",
        "  const renders = useRef(0);",
        "  renders.current += 1;",
        "  return <span>{renders.current}</span>;",
        "};",
      ].join("\n"),
    });
    expect(result.compiled).toBe(1);
    expect(result.skipped.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: "Counter", line: 3 },
    ]);
    expect(result.skipped[0]?.reasons[0]).toStartWith(
      "Refs: Cannot access refs during render",
    );
  });

  test("counts a function that opts out as skipped, and notices when it does not say why", async () => {
    const result = await measureModule({
      path: "fixture.tsx",
      source: [
        "export function Explained() {",
        "  // The list below is mutated in place by a library, so nothing here may be cached.",
        '  "use no memo";',
        "  return <span />;",
        "}",
        "export const Unexplained = () => {",
        '  "use no memo";',
        "  return <span />;",
        "};",
      ].join("\n"),
    });
    expect(result.compiled).toBe(0);
    expect(result.skipped).toEqual([
      {
        path: "fixture.tsx",
        line: 1,
        name: "Explained",
        reasons: ["It opts out with 'use no memo'."],
      },
      {
        path: "fixture.tsx",
        line: 6,
        name: "Unexplained",
        reasons: [
          "It opts out with 'use no memo', and no comment above it says why.",
        ],
        unexplained: true,
      },
    ]);
  });

  test("counts a whole module that opts out as skipped, though the compiler logs it compiled", async () => {
    const result = await measureModule({
      path: "fixture.tsx",
      source: [
        "// Measured slower compiled; see the profile in the commit that added this.",
        '"use no memo";',
        'import { useState } from "react";',
        "export const First = () => <span />;",
        "export const useSecond = () => useState(0)[0];",
      ].join("\n"),
    });
    expect(result.compiled).toBe(0);
    expect(result.skipped.map(({ name, reasons }) => [name, reasons])).toEqual([
      ["First", ["The module opts out with 'use no memo'."]],
      ["useSecond", ["The module opts out with 'use no memo'."]],
    ]);
  });
});
