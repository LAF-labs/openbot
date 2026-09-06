import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")) as T;
}

function read(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

type WindowConfig = {
  label: string;
  url?: string;
  minWidth?: number;
  titleBarStyle?: string;
};
type TauriConfig = {
  app?: { windows?: WindowConfig[] };
  plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
};

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
 * The window no longer only opens the address it was compiled with.
 *
 * One build opens the whole fleet, so a person installs it, signs in at the front door and is
 * walked to their own `<name>.agent.laf-co.com` — and `remember_origin` in `lib.rs` writes that
 * down so the next launch goes straight there. Which means the set of addresses this window can end
 * up at is now a RULE IN RUST rather than a literal in a config file, and an origin outside the
 * grant fails the same silent way as ever: the page loads, the badge and the notices are refused,
 * and nothing is logged anywhere. So the rule's two constants are read here against the grant.
 */
test("every domain the shell may reopen is granted the shell's capabilities", () => {
  const granted = json<{ remote: { urls: string[] } }>(
    "desktop/src-tauri/capabilities/default.json",
  ).remote.urls;

  const shell = read("desktop/src-tauri/src/lib.rs");
  const constant = (name: string): string => {
    const found = shell.match(new RegExp(`const ${name}: &str = "([^"]+)"`));
    // Asserted rather than assumed: a renamed constant would otherwise leave nothing to compare,
    // and a test that compares nothing passes.
    expect(found?.[1]).toBeTruthy();
    return found?.[1] ?? "";
  };
  const domain = constant("FLEET_DOMAIN");
  const development = constant("DEV_ORIGIN");

  for (const origin of [
    `https://${domain}`,
    `https://*.${domain}`,
    development,
  ]) {
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

/**
 * The window cannot be made smaller than the layout inside it.
 *
 * `minWidth` was 800 against a layout whose own minimum is the roster plus the detail pane plus a
 * conversation — 1024. Between the two the app did not break; it just could not be used, because
 * the pane laid over a conversation that had nowhere left to go. The two numbers are written down
 * in different files in different languages, so this is the one place they are read together.
 */
test("the window cannot be dragged smaller than the layout it holds", () => {
  const styles = read("app/src/styles.css");
  const px = (name: string) => {
    const found = styles.match(new RegExp(`--sand-${name}:\\s*(\\d+)px`));
    expect(found).not.toBeNull();
    return Number(found?.[1]);
  };
  const layoutMinimum =
    px("sidebar-width") + px("info-pane-width") + px("chat-min-width");
  // Asserted rather than assumed: a variable renamed to nothing would otherwise make this pass.
  expect(layoutMinimum).toBeGreaterThan(900);

  for (const path of [
    "desktop/src-tauri/tauri.conf.json",
    "desktop/src-tauri/tauri.dev.conf.json",
  ]) {
    const window = json<TauriConfig>(path).app?.windows?.[0];
    expect(window?.minWidth).toBeGreaterThanOrEqual(layoutMinimum);
  }
});

/**
 * An overlay title bar takes away the bar the window was dragged by.
 *
 * `titleBarStyle: "Overlay"` is what makes the 44px `--sand-titlebar-block` reservation mean
 * something — the traffic lights land in it rather than above it — and in the same move it removes
 * the only part of the window a person could grab. Every row that reserves that height has to carry
 * `data-tauri-drag-region`, or the installed app is one whose window cannot be moved.
 */
test("every row that reserves the title bar's height can move the window", () => {
  const style = json<TauriConfig>("desktop/src-tauri/tauri.conf.json").app
    ?.windows?.[0]?.titleBarStyle;
  expect(style).toBe("Overlay");

  for (const path of [
    "app/src/components/app-sidebar/bot-sidebar.tsx",
    "app/src/routes/_authed/_app/channel/$channelId.tsx",
  ]) {
    // The reservation and the handle on the same element: the attribute has to sit inside the tag
    // that opened with that height, before that tag closes.
    const opened = read(path).match(
      /<div[^>]*h-\[var\(--sand-titlebar-block\)\][^>]*>/,
    );
    expect(opened?.[0]).toContain("data-tauri-drag-region");
  }
});

/**
 * The scheme is named in two files and has to be the same word in both.
 *
 * `plugins.deep-link.desktop.schemes` is what the bundler turns into macOS's `CFBundleURLTypes` and
 * the Windows registry key — it decides which links the operating system hands over. `lib.rs`
 * decides which ones are accepted. Name one `lafagent` and the other anything else and every link
 * opens the app and then goes nowhere, silently, which looks exactly like a link that was wrong.
 */
test("the scheme the shell registers is the scheme it answers", () => {
  const registered = json<TauriConfig>("desktop/src-tauri/tauri.conf.json")
    .plugins?.["deep-link"]?.desktop?.schemes;
  expect(registered).toEqual(["lafagent"]);

  const answered = read("desktop/src-tauri/src/lib.rs").match(
    /const SCHEME: &str = "([^"]+)"/,
  );
  expect(answered?.[1]).toBe(registered?.[0]);
});
