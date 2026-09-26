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

That address exists in a development build only. A release build trusts
nothing on the person's own machine: `DEV_ORIGIN` in `lib.rs` is compiled out
without `debug_assertions`, the csp in `tauri.conf.json` does not name it, and
its grant is `capabilities/dev.json`, which `tauri.conf.json` leaves out of
`app.security.capabilities` and only `tauri.dev.conf.json` adds. Keep that list
explicit — an empty one means every file in `capabilities/`, the dev grant
included. Until 2026-09-24 the grant sat in `default.json`, so any process
listening on port 3010 would have been treated as the person's deployment.

Changing it is TWO values, and they must move together: the window's `url`,
and `remote.urls` in `capabilities/default.json`. Change only the first and
everything appears to work — the window loads, the app runs — while the badge,
the notifications and outward links silently stop, because the bridge
feature-detects and finds nothing. The grant carries the wildcard
`https://*.agent.laf-co.com` for the deployments the entry hands people to, and
nothing else: every deployment is `<name>.agent.laf-co.com`, so one build opens
the whole fleet. The apex exception that used to sit here — a customer on a
domain of their own — was retired on 2026-09-03 and is not coming back; a
deployment outside the wildcard is a binary of its own, which is the thing this
grant exists to avoid. A phone build will use the same address.

### And the shell remembers where you were

The front door is the right FIRST launch and the wrong tenth: it has to be up,
and it walks the person to their deployment again every single time. So
whatever fleet origin the window is on when it is put away — closed, quit from
the tray, quit from the platform's menu — is written to `shell.json` beside the
notices switch, and the next launch opens there instead. Signing out lands back
on the front door, which is a fleet origin too, so nothing has to unwind it.

Three things follow, and each is a bug that existed before it:

- **`origin()` is where the window IS**, not what the build was compiled with.
  One build opens the whole fleet, so those stopped being the same address: an
  approval raised on `mystore.agent.laf-co.com` used to resolve to
  `https://agent.laf-co.com/approve/<id>` — the front door, which knows nothing
  about that approval. Deep links and notices both go through it.
- **A remembered address is validated on the way out as well as the way in**
  (`fleet_origin`), against the same shape `capabilities/default.json` grants:
  the domain itself or ONE name under it, https, no port. A suffix check would
  have said yes to `evil-agent.laf-co.com`, and an origin the capability does
  not grant is a window where the badge and the notices silently stop.
- **The connection page offers the front door** when the remembered address is
  the one that did not answer. This window has no address bar; without it, a
  customer whose deployment moved is looking at an app retrying a dead host
  forever, unable to reach the one page that would tell them the new one.

`withGlobalTauri` is on: the page is not bundled, so it cannot `import`
`@tauri-apps/api` — the global is the only way the SPA can ask the shell for
what a webview cannot do itself (a dock badge, a native notification). The
SPA feature-detects `window.__TAURI__` and stays a plain web app without it.

`csp` governs only the one page the shell serves itself, `public/index.html`,
shown when the deployment cannot be reached; the origin's pages carry the front
door's own policy (`app/Caddyfile`). It names that page's inline script by hash
and holds the front door's floor — nothing frames the page, no plugin runs,
nothing is evaluated. It was `null` until 2026-09-13, which left that page with
no policy at all.

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

Since 2026-09-26, five more, each for keeping the app awake and reachable with
its window put away: **`set_status`** (the tray's line — one of three codes,
never text), **`summon_shortcut`** and **`set_summon_shortcut`** (the settings
row for the summon keys — an id from the shell's list, never a key
combination), and **`update_ready`** and **`restart_to_update`** (the update
notice — the second refuses unless the shell is holding an update it fetched
and verified itself).

**The shell's own commands — `set_badge`, `open_external`, `post_notice` and
the five above — are declared twice, and both declarations are
load-bearing.** The notification plugin, which the page still asks for
permission, is a plugin and is granted by `notification:default` alone.
`build.rs` names them in the app manifest, and `capabilities/default.json`
grants the resulting `allow-*` permissions; `tests/desktop-shell.test.ts` reads
`generate_handler!`, the manifest and the grant and fails when they differ.
Tauri refuses an app command arriving from a **remote** origin unless it is in
both — and this window's URL is always a remote origin. Measured 2026-09 in a real bundle: without the app
manifest the dock badge and `open_external` were rejected on every call, the
bridge caught the rejection and answered "no shell", and the two things this
process exists for had never once run. Nothing errors, nothing logs. A command
added to `generate_handler!` and not to those two lists behaves the same way.

`open_external` takes http and https and refuses every other scheme, and the
opener plugin is NOT granted to the origin. Neither is the updater, the process
plugin, nor the global-shortcut plugin. The shell checks for updates from Rust,
on release builds only, and never restarts an app somebody is using on its own:
the page shows one quiet 새 버전이 준비됐어요 card with 지금 다시 시작, withheld
while the Bot is working or waiting on the person — the window drives the turn,
so a restart would end it. So a page running somebody else's script cannot make
this process install software, restart itself into anything but the signed
update it already holds, take a key combination from the rest of the machine,
or hand an arbitrary scheme to the operating system.

**On Windows the update waits for that press, and until 2026-09-26 it did not.**
The updater's Windows `install()` launches the NSIS installer and then calls
`std::process::exit(0)` (tauri-plugin-updater 2.10.1, `updater.rs`), so the
`download_and_install` the shell ran at launch ended the app a minute after
somebody opened it whenever there was an update. Now Windows downloads and
verifies at launch and installs only on 지금 다시 시작; macOS installs at once
(`install()` there replaces the bundle and the process runs on), so it applies
on the next launch whether or not the person presses anything. A development
build never checks; `LAF_SHELL_PRETEND_UPDATE=<version>` makes it hold a pretend
update so the card and the restart can be seen outside a release.

## Awake when the window is not

Closing the window used to end the process, which meant "a Bot is waiting for
you" could only be said by a page already on screen — the one moment nobody
needs telling. So:

- **A tray icon**, with 열기 / 알림 받기 / 로그인할 때 자동 실행 / 종료. Its
  strings are Korean and live in `lib.rs`, because a tray menu is drawn by the
  operating system out of strings this process holds: there is no page to ask.
- **The Bot's status in the tray**: 일하는 중 / 사장님 차례 / 쉬는 중, as a line
  under the version, in the tooltip, and as a dot on the icon (amber for the
  person's turn, green while working, none at rest). The page derives it — the
  same answer as the pill under the Bot's face (`app/src/lib/agents/presence.ts`)
  — and sends one of three codes; the words stay here for the reason above, and a
  page cannot put text of its own into a native menu. Every page load starts it
  at 쉬는 중, so a page that went away cannot leave it saying the Bot is busy.
- **A summon shortcut**, ⌃⌥L (Ctrl+Alt+L) unless the person picks another or
  turns it off on Settings. Registered from Rust through the official
  global-shortcut plugin, from a fixed list (`SUMMON_CHOICES`, with why each
  one), and brings the window forward the way 열기 does. The settings row says
  when the operating system refused the keys rather than reading as on.
- **Closing hides.** Quit is the tray's 종료 or the platform's own Quit, and both
  really end the process. On macOS the app hides with its window, so the
  foreground goes back to whatever the person was using, and `RunEvent::Reopen`
  brings it back from the dock.
- **And the hidden page keeps running** — `backgroundThrottling: "disabled"` on
  the window, in both configs. Every notice comes from the page, and WKWebView's
  default policy suspends a web view that is off screen after about five
  minutes, so "a Bot needs you" could go quiet exactly when the window was away.
  **Measured 2026-09-26** on macOS 26.6, a development build against a local
  stack, the window closed to the tray (`hide()` and `app.hide()`), a routine
  answering in the Bot's conversation, sampling the web content process's CPU
  time every 30 s:
  - *Without the setting*, the page was still awake at 7 min 31 s hidden and the
    notice came in the same second the routine finished. But the web content
    process stopped using any CPU 8 min 13 s after the window was hidden, and at
    12 min 34 s the routine's answer produced **no notice at all — and no outbox
    row either**: the page's socket stayed open while the page slept, so the
    server believed somebody was listening and wrote nothing for later.
    (The machine's display went to sleep about a minute after the page stopped,
    so an idle Mac may be part of it; the page stopped first.)
  - *With the setting*, the notice came in the same second at 7 min 28 s, 12 min
    24 s and 20 min 33 s hidden, and the web content process kept running
    throughout, the display going to sleep in the middle of it included.
  - Not covered: a window left OPEN on a locked screen. In one run like that a
    40-second routine produced no notice and no tray change while the web content
    process sat nearly idle. The setting governs a view that is off screen, not
    one that is on screen behind a lock; this was not pursued.
  - The first run of the "without" measurement was thrown away: files the dev
    server was serving were edited while the window was hidden, and each edit
    reloaded the hidden page, which woke it. Measure a hidden page with the
    source left alone.

  It reaches macOS 14 and later only: wry sets `inactiveSchedulingPolicy` when
  `os_major_version >= 14` and does nothing below, and the bundle's minimum is
  12.0, so on macOS 12 and 13 the gap remains and was not measured here. WebView2
  has no such setting (tauri-utils names it unsupported on Windows); the page
  holds a Web Lock (`holdShellAwake`), the workaround tauri-utils points to.
  Unmeasured — there is no Windows machine here. The lasting fix for both is a
  notice that does not depend on the page, which waits for the server-owned turn.
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

The updater's endpoint is the fleet's front door,
`https://agent.laf-co.com/desktop/latest.json` — not a GitHub release. It was
this repository's `releases/latest/download/latest.json` until the repository
went private on 2026-09-10, after which that URL answered 404 to every installed
app (anonymously, which is how an app asks) and no app could update. The
repository is public again since 2026-09-16; the door stays, so that a
visibility change can never again stop updates. Apps built
before the move still ask GitHub and never will update; they are reinstalled
once from the door (docs/laf/installing.md). The pubkey in `tauri.conf.json` is the
pair generated 2026-08-25 (key id `3E9A4235FEC7D535`); its private half and
password live in this repository's Actions secrets and with the owner, outside
any repository. Lose both and no installed app will ever accept another
update — the recovery is a new pair, a new pubkey commit, and every user
reinstalling by hand. (The previous pubkey came from the retired prime shell
with its private half already unrecoverable, which is why the first release
rotated it: nothing signed by that key was ever published.)

## Releasing

`.github/workflows/release.yml` builds a universal macOS dmg and a Windows
x64 installer (NSIS, per-user), and when a `v*` tag is pushed its `door` job —
once BOTH builds are green — carries them with their signed updater files to
`https://agent.laf-co.com/desktop/<version>/` and moves the stable names
(`LAF-Agent-mac.dmg`, `LAF-Agent-windows.exe`, `latest.json`) onto them:

```bash
git tag v0.5.0 && git push origin v0.5.0
```

**The tag is the release.** There is no draft to publish any more: the moment
the door job succeeds, every installed app is offered the version on its next
launch. `scripts/front-door.ts` refuses, before any connection, an updater
signature from any key but the pubkey here or over any bytes but the build's —
the two ways a release is silently refused by every app. The door itself (an
account whose only key is forced into a receiver, the Caddy route, the key as
GitHub secrets) is laf-control's `laf desktop door`; it keeps the newest three
versions and refuses a version lower than the one it serves, the same number
with different bytes, and a release without a feed over one that has it.

**A push to `main` builds both installers and publishes nothing.** They are
kept as workflow artifacts on the run — `darwin-universal-dmg` and
`windows-x64-nsis`, one file each, downloadable for ninety days — which is how
anybody gets an installer without cutting a release. Docs-only pushes skip it,
the same filter `images.yml` uses. A manual run does the same. Nothing on that
path touches a release: `tagName` is empty, and `tauri-action` reaches nothing
release-shaped without one.

**That path builds with the updater taken out**, both halves of it — no
updater artifacts, and no endpoints. The first is because the bundler refuses
to build an updater artifact it has no key to sign, so the run would need the
signing secrets to produce an installer at all. The second is worse and was
measured: `tauri.conf.json` carries 0.2.0 while the last published release is
0.4.4, so a build-only installer launched, found a newer version at the
endpoint and **replaced itself with the release** — `update 0.4.4 is
available; installing` — and the commit somebody installed it to try was gone
by the next launch. With the endpoints emptied the plugin says `no updater
configured` and the app runs as built. A **tag** keeps both: it is the only
path with a release to offer anybody, and without the signing key it still
fails, as it should.

`docs/laf/installing.md` is what a person is handed: how to install each one,
and exactly what an unsigned build shows them.

The workflow needs `TAURI_SIGNING_PRIVATE_KEY` (the private half of the
updater pubkey in `tauri.conf.json`, as the base64 file `tauri signer
generate` writes) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the
repository secrets, entered by a person. Both are set (2026-08-25) and match
the pubkey committed here. Rotating is a pair, two secrets and a pubkey commit
in one change, or the release builds signed updates that installed apps will
reject — and the door job now says so by key id instead of publishing them. The
door's own `DESKTOP_DOOR_SSH_KEY`, `DESKTOP_DOOR_KNOWN_HOSTS` and the variable
`DESKTOP_DOOR_KEY_FINGERPRINT` are written by `laf desktop door`, never by
hand. Apple Developer ID secrets are optional; without them the dmg is
ad-hoc signed, which Gatekeeper accepts only on the Mac that built it. Windows
code signing is not set up; SmartScreen will warn until it is.
