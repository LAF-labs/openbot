import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")) as T;
}

type WindowConfig = { label: string; url?: string };
type TauriConfig = { app?: { windows?: WindowConfig[] } };

function windowOrigins(path: string): string[] {
  const windows = json<TauriConfig>(path).app?.windows ?? [];
  return windows
    .map((window) => window.url)
    .filter((url): url is string => !!url);
}

/**
 * The shell's origin is two values, and changing one without the other fails silently.
 *
 * `tauri.conf.json` says where the window goes. `capabilities/default.json` says whether the page
 * there may ask the shell for anything. Move the first alone and the window still loads, the app
 * still works, and notifications and the badge stop — the bridge feature-detects, so nothing
 * errors. `lib.rs` warns about this in prose at the top of the file; this is the same warning in a
 * form that fails a build.
 */
test("every origin the shell can open is granted the shell's capabilities", () => {
  const granted = json<{ remote: { urls: string[] } }>(
    "desktop/src-tauri/capabilities/default.json",
  ).remote.urls;

  const origins = [
    ...windowOrigins("desktop/src-tauri/tauri.conf.json"),
    ...windowOrigins("desktop/src-tauri/tauri.dev.conf.json"),
  ];

  // The deployed origin and the development one. Asserted so an empty read cannot pass as agreement.
  expect(origins.length).toBeGreaterThanOrEqual(2);

  for (const origin of origins) {
    expect(granted).toContain(origin);
    expect(granted).toContain(`${origin}/*`);
  }
});

/**
 * The development override repeats the whole window because Tauri replaces arrays when it merges
 * configs. A partial window would merge cleanly and open at the wrong size, which is the kind of
 * wrong nobody files a bug about.
 */
test("the development window differs from the deployed one only in its origin", () => {
  const deployed = json<TauriConfig>("desktop/src-tauri/tauri.conf.json").app
    ?.windows?.[0];
  const development = json<TauriConfig>("desktop/src-tauri/tauri.dev.conf.json")
    .app?.windows?.[0];

  expect(deployed).toBeDefined();
  expect(development).toBeDefined();
  expect(development?.url).not.toBe(deployed?.url);

  const withoutUrl = (window?: WindowConfig) => {
    const { url: _url, ...rest } = window ?? { label: "" };
    return rest;
  };
  expect(withoutUrl(development)).toEqual(withoutUrl(deployed));
});
