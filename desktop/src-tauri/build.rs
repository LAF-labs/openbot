/*
 * THE SHELL'S OWN COMMANDS HAVE TO BE DECLARED, OR THE ORIGIN CANNOT CALL THEM.
 *
 * `tauri_build::build()` on its own generates no application manifest, and Tauri then refuses every
 * app command that arrives from a REMOTE origin — which, in this shell, is every one of them, since
 * the window's URL is the deployed origin rather than bundled code. From `webview/mod.rs`:
 *
 *     // Check ACL on plugin commands, when the app defined its ACL manifest,
 *     // or when the request comes from a non-local (remote) origin. This
 *     // ensures remote content can never reach custom commands unless an
 *     // explicit `remote` capability has been configured for them.
 *
 * Measured 2026-09 in a real bundle: the dock badge and `open_external` had never once run. The
 * page called them, the promise rejected, the bridge caught the rejection and answered "no shell" —
 * the same silent fallback that makes a browser tab work correctly. So the two things the README
 * says this process exists for were dead, and nothing anywhere said so. Adding a notice command
 * found it: its notification came out through the notification plugin's `window.Notification`
 * polyfill instead, which is the only reason anything appeared at all.
 *
 * Naming the commands here generates an `allow-$command` permission for each; `capabilities/
 * default.json` grants those three to the origin, and only those three. The two lists move
 * together — a command added to `generate_handler!` and not to this one is refused at runtime with
 * no compile error anywhere.
 */
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["set_badge", "open_external", "post_notice"]),
    ))
    .expect("the shell's own commands could not be declared");
}
