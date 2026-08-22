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
development server, `http://localhost:3010`; the day a deployed address exists
it is that one value, plus the same value under `capabilities/default.json`
`remote.urls` so the app may call the shell. A phone build will use the same
address.

`withGlobalTauri` is on: the page is not bundled, so it cannot `import`
`@tauri-apps/api` — the global is the only way the SPA can ask the shell for
what a webview cannot do itself (a dock badge, a native notification). The
SPA feature-detects `window.__TAURI__` and stays a plain web app without it.

`csp` is `null` deliberately: the page is served by the origin, which is the
one that must set a CSP. A shell CSP of `'self'` — what the previous, local
shell had — would block the origin's own scripts.

## What the shell adds

Exactly two things, both reached from the SPA through the global and both
with a web fallback: the dock badge (`set_badge`, a Rust command — WKWebView
has no `setAppBadge`) and OS notifications (the notification plugin — the
webview's own `Notification` is unsupported there). Everything else the page
does in a browser it does here unchanged.

## Running

```bash
bun install
cd desktop && bun run dev       # needs the app on :3010 and the API on :3001
cd desktop && bun run build     # .app + .dmg on macOS, .exe (NSIS) on Windows
```

The updater's public key and endpoint are carried over from the previous
shell; releases publish `latest.json` beside the installers.

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
repository secrets, entered by a person. Apple Developer ID secrets are
optional; without them the dmg is ad-hoc signed, which Gatekeeper accepts
only on the Mac that built it. Windows code signing is not set up; SmartScreen
will warn until it is.
