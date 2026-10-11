/**
 * LOADS `vite.config.ts` AS VITE WOULD, IN A PROCESS OF ITS OWN, and says what it found.
 *
 * Run by `vite-dev-runtime.test.ts` through `Bun.spawn`, as the Korean render is
 * (`preview-render.tsx`), because the config cannot be imported inside the gate's app worker:
 * Vite's config chunk builds its error types at load with `Error.captureStackTrace`, and a file
 * that ran earlier in the same worker may have registered happy-dom's globals over `Error` —
 * measured 2026-10-12, "TypeError: First argument must be an Error object" between tests, which
 * took every test in the file with it. Alone, or beside a file that only mounts, it loads.
 *
 * Prints one line, `VITE_CONFIG ` and JSON: the names of every plugin in the config's list, and
 * what the runtime plugin's `config` hook does under four runtimes — the refusal's message, or
 * null where it let the command through.
 */
import type { Plugin, PluginOption } from "vite";
import config, { devRuntime } from "../../vite.config";

/** Every plugin in the list, however the list nests them (a preset is an array of plugins). */
function flatten(options: PluginOption[]): Plugin[] {
  const plugins: Plugin[] = [];
  for (const option of options) {
    if (Array.isArray(option)) plugins.push(...flatten(option));
    else if (option && typeof option === "object" && "name" in option) {
      plugins.push(option as Plugin);
    }
  }
  return plugins;
}

/** The hook, called as Vite calls it; the refusal's message, or null where it let the command through. */
function hook(
  bunVersion: string | undefined,
  command: "serve" | "build",
): string | null {
  const plugin = devRuntime(() => bunVersion);
  const run = plugin.config as (
    userConfig: object,
    env: { command: "serve" | "build"; mode: string },
  ) => unknown;
  try {
    run({}, { command, mode: "development" });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const plugins = flatten((config as { plugins: PluginOption[] }).plugins);
const guard = plugins.find((plugin) => plugin.name === "laf:dev-runtime");

console.log(
  `VITE_CONFIG ${JSON.stringify({
    plugins: plugins.map((plugin) => plugin.name),
    guardHasConfigHook: typeof guard?.config === "function",
    hooks: {
      "bun 1.3.14 serve": hook("1.3.14", "serve"),
      "bun 1.3.14 build": hook("1.3.14", "build"),
      "node serve": hook(undefined, "serve"),
      "bun 1.4.0 serve": hook("1.4.0", "serve"),
    },
  })}`,
);
