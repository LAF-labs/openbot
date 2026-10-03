import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE APP IS DRAWN IN A FACE IT SHIPS.
 *
 * The stack named Pretendard first for a year and shipped none of it: a machine that happened to
 * have it installed drew the app in it (the owner's Mac), and everybody else got the platform's
 * own Hangul — on Windows 맑은 고딕, 16% wider and with no weight between Regular and Bold
 * (measured for the design spec, 2026-10-03). Nothing in the gate could see that: the name was in
 * the stylesheet either way. These hold the face to be imported, to be first, and to be the
 * package's own files.
 */

const app = resolve(import.meta.dir, "..");
const sheet = readFileSync(resolve(app, "src/styles.css"), "utf8");
const manifest = JSON.parse(
  readFileSync(resolve(app, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

/** Every source file of the app, for a walk. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:tsx?|css|html)$/.test(entry.name) ? [path] : [];
  });
}

describe("the typeface", () => {
  test("is the package's own dynamic subset, imported by the stylesheet", () => {
    expect(sheet).toContain(
      '@import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";',
    );
    expect(manifest.dependencies?.pretendard).toBeString();
    // The files a build copies are the package's, by the paths its own stylesheet names.
    const packaged = resolve(
      app,
      "node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css",
    );
    expect(existsSync(packaged)).toBe(true);
    const faces = readFileSync(packaged, "utf8");
    expect(faces.match(/@font-face/g)?.length).toBeGreaterThan(80);
    // The name the stack asks for is the name the package registers.
    expect(faces).toContain("font-family: 'Pretendard Variable'");
    // Text is drawn at once in the next face and swapped: never invisible while a slice is fetched.
    expect(faces).not.toMatch(/font-display:\s*(?:block|auto)/);
  });

  test("is first in the one stack, and the face it replaced is gone from every source", () => {
    const stack = /--font-sans:\s*([^;]+);/.exec(sheet)?.[1] ?? "";
    const families = stack.split(",").map((family) => family.trim());
    expect(families[0]).toBe('"Pretendard Variable"');
    expect(families).not.toContain('"Inter Variable"');
    // Hangul on Windows until the slices arrive, at Pretendard's width; then the platform's own.
    expect(families.indexOf('"LAF Hangul Fallback"')).toBeGreaterThan(0);
    expect(families.indexOf('"LAF Hangul Fallback"')).toBeLessThan(
      families.indexOf('"Malgun Gothic"'),
    );

    expect(
      manifest.dependencies?.["@fontsource-variable/inter"],
    ).toBeUndefined();
    const stillInter = sources(resolve(app, "src")).filter((path) =>
      readFileSync(path, "utf8").includes("@fontsource"),
    );
    expect(stillInter).toEqual([]);
  });

  test("the Windows fallback is 맑은 고딕 at Pretendard's width, for Hangul only", () => {
    const face =
      /@font-face \{\s*font-family: "LAF Hangul Fallback";([^}]+)\}/.exec(
        sheet,
      )?.[1] ?? "";
    expect(face).toContain('local("Malgun Gothic")');
    // 0.864 em against 1.000 em, the two faces' own Hangul advances.
    expect(face).toContain("size-adjust: 86%");
    expect(face).toContain("U+AC00-D7A3");
    expect(face).not.toContain("url(");
  });

  test("is named where the licence asks it to be: the name is reserved, the files are unmodified", () => {
    const notices = readFileSync(
      resolve(app, "../THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    expect(notices).toContain("Pretendard");
    expect(notices).toContain("SIL Open Font License, Version 1.1");
    expect(notices).toContain("Reserved Font Name Pretendard");
  });
});
