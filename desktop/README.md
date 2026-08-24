# desktop — the installable shell

A Tauri 2 window onto the deployed origin. The product's engine runs on the
server; this process exists for what a browser tab cannot give a person — a
dock icon, a window of their own, notifications with the window behind other
apps, and updates that install themselves. It holds no product logic.

## The origin is a setting

The app is same-origin by construction (cookie auth, relative `/api`, a
socket built from `window.location`). Loading it from `tauri://` would break
all of that at once, so the window's `url` in `src-tauri/tauri.conf.json` IS
the origin and the app runs there exactly as in a browser. Today that is the
development server, `http://localhost:3010`.

Changing it is TWO values, and they must move together: the window's `url`,
and `remote.urls` in `capabilities/default.json`. Change only the first and
everything appears to work — the window loads, the app runs — while the badge,
the notifications and outward links silently stop, because the bridge
feature-detects and finds nothing. A phone build will use the same address.

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

`open_external` takes http and https and refuses every other scheme, and the
opener plugin is NOT granted to the origin. Neither is the updater, nor the
process plugin: the shell checks for updates from Rust, on release builds
only, and installs them for the next launch rather than restarting an app
somebody is using. So a page running somebody else's script cannot make this
process install software, restart itself, or hand an arbitrary scheme to the
operating system.

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
Tauri bundle cannot be produced.

`dev` passes `src-tauri/tauri.dev.conf.json`, which points the window at
`localhost:3010` instead of the deployed origin. It repeats the whole window
object rather than only the URL because Tauri replaces arrays when it merges
configs — a partial window would build fine and open at the wrong size. The
two files are the one place in this shell where a value is duplicated on
purpose; change the window's shape in both or neither.

The updater's endpoint is this repository's latest release, which publishes
`latest.json` beside the installers. The pubkey in `tauri.conf.json` was
carried over from the retired `LAF-labs/prime` shell and **its private half no
longer exists**: it lived only as an Actions secret on that repository, and a
GitHub secret cannot be read back out by anyone, its owner included. So the
first release here has to generate a fresh pair and replace the pubkey in the
same change. That costs nothing today — nothing signed by the old key was ever
published, so no installed app is holding it.

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
repository secrets, entered by a person. Neither is set yet, and the pubkey
currently in `tauri.conf.json` has no matching private half — generate a pair,
paste the secrets, and commit the new pubkey together, or the release builds
signed updates that installed apps will reject. Apple Developer ID secrets are
optional; without them the dmg is ad-hoc signed, which Gatekeeper accepts
only on the Mac that built it. Windows code signing is not set up; SmartScreen
will warn until it is.
