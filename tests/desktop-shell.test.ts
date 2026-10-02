import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  create?: boolean;
  dragDropEnabled?: boolean;
  url?: string;
  minWidth?: number;
  titleBarStyle?: string;
};
type TauriConfig = {
  app?: {
    windows?: WindowConfig[];
    security?: { csp?: string | null; capabilities?: string[] };
  };
  plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
};
type Capability = {
  identifier: string;
  windows: string[];
  remote: { urls: string[] };
  permissions: string[];
};

const RELEASE_CONFIG = "desktop/src-tauri/tauri.conf.json";
const DEV_CONFIG = "desktop/src-tauri/tauri.dev.conf.json";

function windowOrigins(path: string): string[] {
  const windows = json<TauriConfig>(path).app?.windows ?? [];
  return windows
    .map((window) => window.url)
    .filter((url): url is string => !!url);
}

function capability(identifier: string): Capability {
  return json<Capability>(`desktop/src-tauri/capabilities/${identifier}.json`);
}

/**
 * The capabilities a build embeds, which is the config's list and not the directory.
 *
 * `tauri dev` merges `tauri.dev.conf.json` over `tauri.conf.json` (RFC 7396: an object merges, an
 * array is replaced), and tauri-codegen embeds exactly the identifiers `app.security.capabilities`
 * names — or, when that list is empty, EVERY file in `capabilities/`. Read the same way here.
 */
function embeddedCapabilities(build: "release" | "dev"): Capability[] {
  const release = json<TauriConfig>(RELEASE_CONFIG).app?.security?.capabilities;
  const dev = json<TauriConfig>(DEV_CONFIG).app?.security?.capabilities;
  const named = (build === "dev" ? (dev ?? release) : release) ?? [];
  // Asserted rather than assumed: an empty list is not "none", it is all of them.
  expect(named.length).toBeGreaterThan(0);
  return named.map(capability);
}

function grantOf(build: "release" | "dev"): string[] {
  return embeddedCapabilities(build).flatMap((granted) => granted.remote.urls);
}

function devOrigin(): string {
  const found = read("desktop/src-tauri/src/lib.rs").match(
    /const DEV_ORIGIN: &str = "([^"]+)"/,
  );
  expect(found?.[1]).toBeTruthy();
  return found?.[1] ?? "";
}

/**
 * The shell's origin is two values, and changing one without the other fails silently.
 *
 * `tauri.conf.json` says where the window goes. The capabilities it embeds say whether the page
 * there may ask the shell for anything. Move the first alone and the window still loads, the app
 * still works, and notifications and the badge stop — the bridge feature-detects, so nothing
 * errors. `lib.rs` warns about this in prose at the top of the file; this is the same warning in a
 * form that fails a build. Each config is read against the grant IT embeds: the development window
 * against the development set, the deployed one against what people install.
 */
test("every origin the shell can open is granted the shell's capabilities", () => {
  const pairs = [
    ...windowOrigins(RELEASE_CONFIG).map(
      (origin) => [origin, "release"] as const,
    ),
    ...windowOrigins(DEV_CONFIG).map((origin) => [origin, "dev"] as const),
  ];

  // The deployed origin and the development one. Asserted so an empty read cannot pass as agreement.
  expect(pairs.length).toBeGreaterThanOrEqual(2);

  for (const [origin, build] of pairs) {
    expect(grantOf(build)).toContain(origin);
    expect(grantOf(build)).toContain(`${origin}/*`);
  }
});

/**
 * WHAT PEOPLE INSTALL TRUSTS NOTHING ON THEIR OWN MACHINE.
 *
 * `http://localhost:3010` used to sit in `capabilities/default.json` and in the csp, so every
 * installed app would have treated whatever listened on that port as the person's deployment and
 * let it call the badge, the notices and the link opener. It is now the development build's alone:
 * `DEV_ORIGIN` exists only under `debug_assertions`, its grant is `capabilities/dev.json`, and only
 * `tauri.dev.conf.json` names that file. Measured 2026-09-24: `strings` on a `cargo build
 * --release` binary finds no `localhost:3010`; a debug build with the development config merged in
 * carries the dev grant.
 */
test("a release build grants nothing on the person's own machine, and a development build still reaches its server", () => {
  const release = grantOf("release");
  expect(release.length).toBeGreaterThan(0);
  for (const url of release) {
    expect(url.startsWith("https://")).toBe(true);
    expect(url).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]/);
  }
  expect(
    embeddedCapabilities("release").map((granted) => granted.identifier),
  ).not.toContain("dev");

  const development = devOrigin();
  expect(grantOf("dev")).toContain(development);
  expect(grantOf("dev")).toContain(`${development}/*`);

  // The constant is compiled out of a release build, so any release path still reading it is a
  // compile error — the compiler holds the rest of this, as long as the attribute stays on it.
  expect(read("desktop/src-tauri/src/lib.rs")).toMatch(
    /#\[cfg\(debug_assertions\)\]\s*const DEV_ORIGIN: &str/,
  );

  // The release workflow builds with the deployed config and nothing merged over it.
  expect(read(".github/workflows/release.yml")).not.toContain("tauri.dev.conf");
});

/**
 * The development grant is the deployed one pointed somewhere else, or a development launch is not
 * testing what people install: a command that works in `bun run dev` and is refused in the bundle
 * is exactly the silent failure `build.rs` describes.
 */
test("the development capability grants what the deployed one does, to the development server alone", () => {
  const deployed = capability("default");
  const development = capability("dev");
  const origin = devOrigin();

  expect(development.permissions).toEqual(deployed.permissions);
  expect(development.windows).toEqual(deployed.windows);
  expect([...development.remote.urls].sort()).toEqual(
    [origin, `${origin}/*`].sort(),
  );
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
  const shell = read("desktop/src-tauri/src/lib.rs");
  const found = shell.match(/const FLEET_DOMAIN: &str = "([^"]+)"/);
  // Asserted rather than assumed: a renamed constant would otherwise leave nothing to compare, and
  // a test that compares nothing passes.
  expect(found?.[1]).toBeTruthy();
  const domain = found?.[1] ?? "";

  // The fleet in what people install; the development server only where `fleet_origin` can say yes
  // to it, which is a development build.
  for (const [origin, build] of [
    [`https://${domain}`, "release"],
    [`https://*.${domain}`, "release"],
    [devOrigin(), "dev"],
  ] as const) {
    expect(grantOf(build)).toContain(origin);
    expect(grantOf(build)).toContain(`${origin}/*`);
  }
});

/**
 * A DEVELOPMENT LAUNCH IS NOT THE INSTALLED APP.
 *
 * The development config named no identifier, so `bun run dev` ran as `com.lafco.lafagent` — the
 * app people install. Measured 2026-10-02 on a machine that has both: a development launch wrote
 * `{"origin": "http://localhost:3010"}` to `~/Library/Application Support/com.lafco.lafagent/
 * shell.json`, the installed app's own settings. A release build refuses that origin and falls
 * back to the front door, so nothing broke — but it runs the other way too, by the code: a
 * developer whose installed app remembers their deployment gets a development window that opens
 * that deployment instead of localhost (`launch_origin`), and, the single-instance lock being
 * taken by identifier, a development launch beside a running installed app is "a second launch"
 * and exits. An identity of its own ends all three, and a name of its own says which of the two
 * a tray's first line belongs to.
 */
test("a development launch has an identity of its own", () => {
  type Identity = { identifier?: string; productName?: string };
  const installed = json<Identity>(RELEASE_CONFIG);
  const development = json<Identity>(DEV_CONFIG);
  // Asserted rather than assumed: two absent identifiers would differ from nothing.
  expect(installed.identifier).toBeTruthy();
  expect(installed.productName).toBeTruthy();
  expect(development.identifier).toBe(`${installed.identifier}.dev`);
  expect(development.productName).toBe(`${installed.productName} Dev`);
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
 * THE SHELL BUILDS ITS WINDOW, FROM THE CONFIG, BECAUSE A CONFIG CANNOT HOLD A HANDLER.
 *
 * A webview saves a file and draws nothing, so the shell listens for a download ending and tells
 * the page (`note_download`). A download handler is a closure and can only be given to a window
 * still being built — so both configs mark the window `create: false` and `build_window` builds it
 * with the same call Tauri would have made. Three ways that comes apart without an error anywhere:
 *
 *  - `create` left out of one config: Tauri builds the window itself, the shell's own build is
 *    refused for the label, and the window that appears has no handler — downloads still save
 *    (wry lets every one through by default) and the app goes back to saying nothing about them;
 *  - a second window in the config: `build_window` builds the first and no other;
 *  - the build moved after the place `setup` looks the window up: "no main window at setup".
 */
test("the shell builds the one window its config describes, and hears its downloads", () => {
  for (const path of [RELEASE_CONFIG, DEV_CONFIG]) {
    const windows = json<TauriConfig>(path).app?.windows ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.label).toBe("main");
    expect(windows[0]?.create).toBe(false);
  }

  const shell = read("desktop/src-tauri/src/lib.rs");
  const build = shell.slice(
    shell.indexOf("fn build_window("),
    shell.indexOf("/// The number of rooms waiting"),
  );
  expect(build).toMatch(
    /WebviewWindowBuilder::from_config\(app, &config\)\?\s*\.on_download\(\|webview, event\| note_download\(webview\.app_handle\(\), event\)\)\s*\.build\(\)\?/,
  );

  const setup = shell.slice(shell.indexOf(".setup(|app|"));
  const built = setup.indexOf("build_window(app.handle())");
  expect(built).toBeGreaterThan(-1);
  expect(built).toBeLessThan(setup.indexOf('get_webview_window("main")'));

  // The first download makes macOS ask about the Downloads folder; this is the reason it shows.
  expect(read("desktop/src-tauri/Info.plist")).toMatch(
    /<key>NSDownloadsFolderUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
  );
});

/**
 * A FILE DROPPED ON THE WINDOW IS THE PAGE'S.
 *
 * Tauri's own file-drop handler is on unless a config turns it off, and where it is on the page
 * never hears a drop: tauri-runtime-wry 2.11.4 installs a wry handler that answers `true` to every
 * drag event, and wry 0.55.1's `performDragOperation:` then returns YES without handing the drop
 * to WebKit (`wkwebview/drag_drop.rs`), so no `drop` reaches the DOM. Tauri offers the file's PATH
 * through an event of its own instead, which this page — a remote origin with no file-system
 * grant — could do nothing with. The composer takes files the way a web page does, so the window
 * leaves drops to the webview.
 *
 * Read from the two libraries' source, not measured: a drop needs a hand on the pointer.
 */
test("a file dropped on the window is left to the page", () => {
  for (const path of [RELEASE_CONFIG, DEV_CONFIG]) {
    const window = json<TauriConfig>(path).app?.windows?.[0];
    expect(window?.dragDropEnabled).toBe(false);
  }
  // And the page is listening for it, on the document, wherever in the window the file lands.
  const composer = read("app/src/components/channels/composer/composer.tsx");
  expect(composer).toContain(
    'document.addEventListener("drop", handleDropped)',
  );
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

  // The reservation and the handle on the same element: the attribute has to sit inside the tag
  // that opened with that height, before that tag closes. The sidebar's row is `h-titlebar` — the
  // 44px as a name since 2026-09-24, where it used to be spelled `h-[var(--sand-titlebar-block)]`.
  const sidebarRow = read(
    "app/src/components/app-sidebar/bot-sidebar.tsx",
  ).match(/<div[^>]*\bh-titlebar\b[^>]*>/);
  expect(sidebarRow?.[0]).toContain("data-tauri-drag-region");

  /*
   * The conversation's header is the Bot's presence now (`bot-header.tsx`), 56px rather than 44 —
   * and Tauri drags only from an element that carries the attribute ITSELF, not from its children,
   * so the header, the face-and-name group and the name each carry it. Both conversation screens
   * draw that header.
   */
  const header = read("app/src/components/channels/bot-header.tsx");
  expect(header.match(/<header[^>]*>/)?.[0]).toContain(
    "data-tauri-drag-region",
  );
  expect(header.match(/<h1[^>]*>/)?.[0]).toContain("data-tauri-drag-region");
  for (const path of [
    "app/src/routes/_authed/_app/channel/$channelId.tsx",
    "app/src/routes/_authed/_app/channel/new.tsx",
  ]) {
    expect(read(path)).toContain("<BotHeader");
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

/**
 * The shell's version lives in two files that have to agree, and in a third that is not one.
 *
 * `Cargo.toml` is what the crate says it is; `tauri.conf.json` is what the bundle says, and
 * release.yml stamps the tag over it on the runner (never committed). At any commit the two must
 * be one number, or the About line the tray draws (`package_info()`, read from the config) and the
 * crate's own metadata disagree with nothing to say which is right. `desktop/package.json` is a
 * workspace manifest nothing reads for a version, and says so rather than carrying a third copy.
 */
test("the shell's two version files agree, and the manifest does not pretend to be a third", () => {
  const cargo = read("desktop/src-tauri/Cargo.toml").match(
    /^version = "([^"]+)"/m,
  );
  const config = json<{ version?: string }>(
    "desktop/src-tauri/tauri.conf.json",
  ).version;

  // Asserted rather than assumed: a config without a version would compare undefined to undefined.
  expect(cargo?.[1]).toBeTruthy();
  expect(config).toBeTruthy();
  expect(config).toBe(cargo?.[1]);

  expect(json<{ version?: string }>("desktop/package.json").version).toBe(
    "0.0.0-workspace",
  );
});

/**
 * The tray says which shell this is.
 *
 * macOS draws an About item on its own; Windows draws nothing, and the Settings footer can only
 * say the server's build. The tray line reads `package_info()`, which is the stamped version the
 * updater compares against — the same number, from the same place, or it is not an About.
 */
test("the tray's first line is the shell's own name and version, and is not a button", () => {
  const shell = read("desktop/src-tauri/src/lib.rs");
  const tray = shell.slice(shell.indexOf("fn build_tray("));
  expect(tray).toContain("app.package_info()");
  expect(tray).toMatch(
    /MenuItem::with_id\(\s*app,\s*"about",\s*format!\("\{\} \{\}", info\.name, info\.version\),\s*false,/,
  );
  // First in the menu, so it reads as a title rather than as one more thing to click — and the
  // Bot's status right under it, the other fact the menu states before anything to press.
  expect(tray).toMatch(
    /&\[\s*&about,\s*&status,\s*&PredefinedMenuItem::separator/,
  );
  expect(tray).toMatch(
    /MenuItem::with_id\(\s*app,\s*"status",\s*BotStatus::Idle\.words\(\),\s*false,/,
  );
});

/**
 * WHAT THE SHELL HANDLES, WHAT IT DECLARES AND WHAT IT GRANTS ARE ONE LIST, READ THREE TIMES.
 *
 * A command in `generate_handler!` that is missing from `build.rs`'s app manifest, or whose
 * `allow-*` is missing from the capability, is refused at runtime for a remote origin — which this
 * window always is — with no error at build time and a rejected promise the bridge reads as "no
 * shell". That is how the dock badge and the link opener were dead for a release (build.rs). And
 * an `allow-*` for a command the shell does not handle is a grant nobody reviewed. So the three
 * are read here and must be the same set.
 */
test("every command the shell handles is declared and granted, and nothing else is", () => {
  const shell = read("desktop/src-tauri/src/lib.rs");
  const handled = shell
    .match(/generate_handler!\[([^\]]*)\]/)?.[1]
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const declared = read("desktop/src-tauri/build.rs")
    .match(/\.commands\(&\[([^\]]*)\]\)/)?.[1]
    ?.split(",")
    .map((name) => name.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const granted = capability("default")
    .permissions.filter((permission) => permission.startsWith("allow-"))
    .map((permission) => permission.slice("allow-".length).replace(/-/g, "_"));

  // Asserted rather than assumed: three empty reads would agree with each other.
  expect(handled?.length).toBeGreaterThanOrEqual(8);
  expect([...(declared ?? [])].sort()).toEqual([...(handled ?? [])].sort());
  expect([...granted].sort()).toEqual([...(handled ?? [])].sort());
});

/**
 * THE PAGE IS NEVER HANDED A PLUGIN THAT ACTS ON THE MACHINE.
 *
 * The shell updates itself, restarts itself, registers its summon shortcut, starts with the login
 * and opens links from Rust, and offers the page narrow commands of its own for each — a restart
 * only into the update it fetched, a shortcut only from its list. Granting the plugin instead would
 * hand a page running somebody else's script the general version: install anything, restart at
 * will, take Cmd+C from every other program. Checked in both capabilities, since a development
 * grant that differs is not testing what people install.
 */
test("no capability grants the updater, the process, the global shortcut or any other plugin that acts on the machine", () => {
  for (const identifier of ["default", "dev"]) {
    for (const permission of capability(identifier).permissions) {
      expect(permission).not.toMatch(
        /^(updater|process|global-shortcut|autostart|store|deep-link|opener|shell|fs):/,
      );
    }
  }
});

/**
 * A HIDDEN WINDOW KEEPS ITS PAGE RUNNING.
 *
 * Closing the window hides it, and every notice the shell posts comes from that page. tauri-utils
 * 2.9.3 documents WebKit's default for a view that is not on screen as a suspend policy, which
 * would make "a Bot needs you" go quiet exactly when the window is away. So the policy is set to
 * `disabled` rather than left to a default. What was measured on macOS 26.6 is in desktop/README.md
 * ("And the hidden page keeps running"); the setting reaches macOS 14 and later only.
 */
test("the window is not suspended when it is put away", () => {
  for (const path of [RELEASE_CONFIG, DEV_CONFIG]) {
    const window = json<{
      app?: { windows?: { backgroundThrottling?: string }[] };
    }>(path).app?.windows?.[0];
    expect(window?.backgroundThrottling).toBe("disabled");
  }
});

/**
 * THE SHELL'S OWN POLICY HOLDS THE DEPLOYMENT'S FLOOR.
 *
 * The window shows the deployment, whose pages carry the front door's headers (app/Caddyfile); the
 * one page the shell serves itself is `public/index.html`, shown when the deployment cannot be
 * reached, and Tauri's `csp` is what governs that page. It was `null` — no policy at all (measured
 * 2026-09-10). Its inline script probes the deployment, so it is named by hash, and the two policies
 * share a floor: nothing frames either page, no plugin runs, nothing is evaluated, and no script
 * loads from another origin. The shell's is the stricter of the two on inline script — the front
 * door allows it for the sandboxed components that inherit its policy, and this page has none.
 * Measured 2026-09-13 in Chromium with this policy as the page's header: no violation probing a
 * fleet origin or the development one, and a foreign origin refused.
 */
test("the shell's csp names its own page's script by hash and holds the front door's floor", () => {
  const shell = json<{ app?: { security?: { csp?: string | null } } }>(
    "desktop/src-tauri/tauri.conf.json",
  ).app?.security?.csp;
  expect(typeof shell).toBe("string");
  const caddy = /Content-Security-Policy "([^"]+)"/.exec(
    read("app/Caddyfile"),
  )?.[1];
  expect(caddy).toBeDefined();

  const directivesOf = (policy: string) =>
    new Map(
      policy
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values] as const),
    );
  const shellPolicy = directivesOf(shell as string);
  const caddyPolicy = directivesOf(caddy as string);

  const scripts = [
    ...read("desktop/public/index.html").matchAll(
      /<script>([\s\S]*?)<\/script>/g,
    ),
  ].map((match) => match[1] ?? "");
  expect(scripts).toHaveLength(1);
  const hash = `'sha256-${createHash("sha256")
    .update(scripts[0] as string)
    .digest("base64")}'`;
  expect(shellPolicy.get("script-src")).toEqual(["'self'", hash]);

  // The page's one job is to reach the deployment: the fleet's entry, every deployment under it,
  // and Tauri's own bridge. The development server only in a development launch, whose config
  // carries the same policy with that one source added — merged over this one, since a string
  // cannot be patched, so the copy is held to it here rather than by hand.
  const reaches = shellPolicy.get("connect-src") ?? [];
  const shellOrigin = json<TauriConfig>(RELEASE_CONFIG).app?.windows?.[0]
    ?.url as string;
  const developmentOrigin = json<TauriConfig>(DEV_CONFIG).app?.windows?.[0]
    ?.url as string;
  expect(reaches).toContain(shellOrigin);
  expect(reaches).toContain("ipc:");
  expect(reaches).not.toContain(developmentOrigin);

  const developmentCsp = json<TauriConfig>(DEV_CONFIG).app?.security?.csp;
  expect(typeof developmentCsp).toBe("string");
  const developmentPolicy = directivesOf(developmentCsp as string);
  expect(developmentPolicy.get("connect-src")).toEqual([
    ...reaches,
    developmentOrigin,
  ]);
  expect(
    new Map([...developmentPolicy].filter(([name]) => name !== "connect-src")),
  ).toEqual(
    new Map([...shellPolicy].filter(([name]) => name !== "connect-src")),
  );

  // The same floor in both places.
  for (const policy of [shellPolicy, caddyPolicy]) {
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
    expect(
      (policy.get("script-src") ?? []).filter((source) =>
        /^(https?:|\*)/.test(source),
      ),
    ).toEqual([]);
  }
  // And the shell's page, which embeds nothing, runs no inline script it did not name.
  expect(shellPolicy.get("script-src")).not.toContain("'unsafe-inline'");
});
