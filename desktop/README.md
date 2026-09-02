# desktop — the installable shell

A Tauri 2 window onto the deployed origin. The product's engine runs on the
server; this process exists for what a browser tab cannot give a person — a
dock icon, a window of their own, notifications with the window behind other
apps, and updates that install themselves. It holds no product logic.

## The origin is a setting

The app is same-origin by construction (cookie auth, relative `/api`, a
socket built from `window.location`). Loading it from `tauri://` would break
all of that at once, so the window's `url` in `src-tauri/tauri.conf.json` IS
the origin and the app runs there exactly as in a browser. Since 0.2.0 that is
the product's entry page, `https://agent.laf-co.com`: the person signs in
there once and is walked to their own deployment, so one build opens every
store instead of a binary per customer. `tauri.dev.conf.json` points the same
window at `http://localhost:3010` for development.

Changing it is TWO values, and they must move together: the window's `url`,
and `remote.urls` in `capabilities/default.json`. Change only the first and
everything appears to work — the window loads, the app runs — while the badge,
the notifications and outward links silently stop, because the bridge
feature-detects and finds nothing. The grant carries the wildcard
`https://*.agent.laf-co.com` for the deployments the entry hands people to,
plus `sajuhook.com`, which predates the product domain and lives on an apex of
its own. A phone build will use the same address.

`withGlobalTauri` is on: the page is not bundled, so it cannot `import`
`@tauri-apps/api` — the global is the only way the SPA can ask the shell for
what a webview cannot do itself (a dock badge, a native notification). The
SPA feature-detects `window.__TAURI__` and stays a plain web app without it.

`csp` is `null` deliberately: the page is served by the origin, which is the
one that must set a CSP. A shell CSP of `'self'` — what the previous, local
shell had — would block the origin's own scripts.

## What the shell adds

Three things, each reached from the SPA through the global and each with a
web fallback: the dock badge (`set_badge`, a Rust command — WKWebView has no
`setAppBadge`), OS notifications (the notification plugin — the webview's own
`Notification` is unsupported there), and links out (`open_external` — every
link a Bot writes is `target="_blank"`, and a webview has no second window to
put one in, so without this every link in every message did nothing).
Everything else the page does in a browser it does here unchanged.

Since 2026-09 there is a fourth: **notices** (`post_notice`). The page used to
call the notification plugin's own binding; it comes through a command of the
shell's so that the tray's mute cannot be routed around, and so the notice's
destination is recorded somewhere the shell can act on it.

**All four are declared twice, and both declarations are load-bearing.**
`build.rs` names them in the app manifest, and `capabilities/default.json`
grants the resulting `allow-*` permissions. Tauri refuses an app command
arriving from a **remote** origin unless it is in both — and this window's URL
is always a remote origin. Measured 2026-09 in a real bundle: without the app
manifest the dock badge and `open_external` were rejected on every call, the
bridge caught the rejection and answered "no shell", and the two things this
process exists for had never once run. Nothing errors, nothing logs. A command
added to `generate_handler!` and not to those two lists behaves the same way.

`open_external` takes http and https and refuses every other scheme, and the
opener plugin is NOT granted to the origin. Neither is the updater, nor the
process plugin: the shell checks for updates from Rust, on release builds
only, and installs them for the next launch rather than restarting an app
somebody is using. So a page running somebody else's script cannot make this
process install software, restart itself, or hand an arbitrary scheme to the
operating system.

## Awake when the window is not

Closing the window used to end the process, which meant "a Bot is waiting for
you" could only be said by a page already on screen — the one moment nobody
needs telling. So:

- **A tray icon**, with 열기 / 알림 받기 / 로그인할 때 자동 실행 / 종료. Its four
  strings are Korean and live in `lib.rs`, because a tray menu is drawn by the
  operating system out of strings this process holds: there is no page to ask.
- **Closing hides.** Quit is the tray's 종료 or the platform's own Quit, and both
  really end the process. On macOS the app hides with its window, so the
  foreground goes back to whatever the person was using, and `RunEvent::Reopen`
  brings it back from the dock.
- **Autostart**, off until somebody ticks it, remembered by the operating system
  itself — `is_enabled()` reads the LaunchAgent plist or the Run key, so the tick
  cannot disagree with the behaviour and there is no second copy to lose.
- **Deep links.** `lafagent://approve/<id>` and `lafagent://channel/<id>` become
  `/approve/<id>` and `/channel/<id>` **on the current origin**. The allowlist in
  `link_target` is the whole of what this process knows about the product's
  paths, and it is an allowlist rather than a passthrough because a scheme
  handler is reachable by anything on the machine that can call `open`: a shell
  that forwarded an arbitrary path would let any program point this window, which
  holds this person's session, at any address on their deployment.
  `plugins.deep-link.desktop.schemes` in `tauri.conf.json` is what registers the
  scheme — the bundler turns it into `CFBundleURLTypes` and an NSIS registry key,
  so **a link only works from a bundled app**: `tauri dev` on macOS runs a bare
  binary that LaunchServices knows nothing about.
- **One instance.** On Windows and Linux a deep link IS a second launch, with the
  URL as the only argument; the plugin forwards it to the running app rather than
  opening a second signed-in copy beside the first.

**What a click on a native notification does, measured.** Nothing that can be
observed from here. In `tauri-plugin-notification` 2.3.3 the desktop
implementation builds a `notify_rust::Notification`, spawns `show()` and drops
the handle (`src/desktop.rs`); `on_action` and `register_action_types` exist only
in `src/mobile.rs`. So there is no click callback to hang a navigation on. What
the shell does instead is remember where the newest notice pointed and follow it
the next time the window is brought forward — from the tray, from 열기, from the
dock — within ten minutes. Clicking the banner on macOS activates the app and
reports nothing, so what a person sees is the window, and then the app's own
routing. The deep link is the path that really does carry a destination.

Three more measured limits worth writing down. The plugin's `silent` is iOS-only
on this platform (`models.rs` holds the flag, `desktop.rs` never reads it), so a
Bot that merely finished still makes the system's sound. `permission_state()`
always answers `Granted` on desktop, so the app's "turn on notifications" control
never has anything to ask for in the shell. And **the plugin defines
`window.Notification` itself** (`src/init-iife.js`), mapping it onto
`plugin:notification|notify` — so the repeated claim in this codebase that
"WKWebView has no `Notification`" is no longer true wherever this plugin is
loaded. That polyfill is what silently caught the notices while `post_notice` was
being refused by the ACL, which is the only reason the breakage above was visible
at all: something appeared, from the wrong path, and the shell's log stayed
empty. It also sets its `permission` from an async round trip a moment after
every load, which is a window in which a page reading it synchronously is told
"default".

A notification that reaches `notify_rust` is not the same as one a person sees:
on macOS it goes out through `NSUserNotification`, and an ad-hoc-signed build
(every build until Developer ID secrets exist — see Releasing) can have it
dropped without an error. The shell's log says what it sent; the operating system
decides the rest.

Plus the one page the shell serves itself, `public/index.html`: the
connection page. An app whose whole UI lives on a server has exactly one
failure it must explain on its own. The shell probes the origin (a TCP
connect) before showing the window; if nothing answers, the window is sent
to this page, which keeps probing and replaces itself with the origin the
moment the server is back. Without it WKWebView shows a blank window and
WebView2 its own error page.

## Running

```bash
bun install
cd desktop && bun run dev       # needs the app on :3010 and the API on :3001
cd desktop && bun run bundle    # .app + .dmg on macOS, .exe (NSIS) on Windows
```

The script is `bundle`, not `build`, on purpose: the root `bun run build`
runs every workspace's `build`, and CI runs that on a Linux runner where a
Tauri bundle cannot be produced. `bun run typecheck` is `cargo check` wherever
that can run and says out loud when it cannot — on Linux, and on a machine with
no Rust toolchain. It used to be an `echo`.

`dev` passes `src-tauri/tauri.dev.conf.json`, which points the window at
`localhost:3010` instead of the deployed origin. It repeats the whole window
object rather than only the URL because Tauri replaces arrays when it merges
configs — a partial window would build fine and open at the wrong size. The
two files are the one place in this shell where a value is duplicated on
purpose; change the window's shape in both or neither.

The updater's endpoint is this repository's latest release, which publishes
`latest.json` beside the installers. The pubkey in `tauri.conf.json` is the
pair generated 2026-08-25 (key id `3E9A4235FEC7D535`); its private half and
password live in this repository's Actions secrets and with the owner, outside
any repository. Lose both and no installed app will ever accept another
update — the recovery is a new pair, a new pubkey commit, and every user
reinstalling by hand. (The previous pubkey came from the retired prime shell
with its private half already unrecoverable, which is why the first release
rotated it: nothing signed by that key was ever published.)

## Releasing

`.github/workflows/release.yml` builds a universal macOS dmg and a Windows
x64 installer (NSIS, per-user) and publishes them as a **draft** release
when a `v*` tag is pushed:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

A manual run of the workflow only builds and keeps the installers as
workflow artifacts. The updater reads
`releases/latest/download/latest.json`, which serves published releases
only — publishing the draft is what offers the update to installed apps.

The workflow needs `TAURI_SIGNING_PRIVATE_KEY` (the private half of the
updater pubkey in `tauri.conf.json`, as the base64 file `tauri signer
generate` writes) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the
repository secrets, entered by a person. Both are set (2026-08-25) and match
the pubkey committed here. Rotating is a pair, two secrets and a pubkey commit
in one change, or the release builds signed updates that installed apps will
reject. Apple Developer ID secrets are optional; without them the dmg is
ad-hoc signed, which Gatekeeper accepts only on the Mac that built it. Windows
code signing is not set up; SmartScreen will warn until it is.
