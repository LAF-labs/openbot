import { describe, expect, test } from "bun:test";
import {
  applyThemePreference,
  parseThemePreference,
  resolveDark,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("an unrecognised or absent stored value means no choice was made", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("chartreuse")).toBe("system");
  });

  test("an explicit choice overrides the machine, both ways", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
  });

  test("following the system is following the system", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });

  test("persists the choice, not the outcome it happened to resolve to", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const effects = {
      setStoredValue: (key: string, value: string) => writes.push([key, value]),
      toggleRootClass: (name: string, force: boolean) =>
        toggles.push([name, force]),
    };

    applyThemePreference("system", true, effects);

    // "system", so a machine that flips tomorrow still moves the app with it.
    expect(writes).toEqual([[THEME_STORAGE_KEY, "system"]]);
    expect(toggles).toEqual([["dark", true]]);
  });

  test("persists and applies an explicit choice", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];

    applyThemePreference("dark", false, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
  });
});
