//! The installable shell around the cloud service.
//!
//! A window onto the deployed origin, and nothing the browser tab did not already do. The product's
//! engine runs on the server — the Bots, their virtual computers, the room turns — and this process
//! exists so the person gets what a tab cannot give them: an icon in the dock, a window that is
//! theirs, notifications that arrive with the window closed behind other apps, and updates that
//! install themselves. It deliberately holds no product logic, because every line here is a line
//! that has to be written twice once there is a phone app.
//!
//! THE ORIGIN IS A SETTING, NOT A CONSTANT. The SPA is same-origin by construction: cookie auth,
//! relative `/api` calls, a socket built from `window.location`. Loading it from `tauri://` would
//! break every one of those at once, so the window navigates to the origin and the app runs there,
//! exactly as it does in a browser. Today that origin is the development server; the day a deployed
//! address exists it is TWO values, and it is the same address a phone will use:
//!
//!   1. `app.windows[0].url` in `tauri.conf.json` — where the window goes.
//!   2. `remote.urls` in `capabilities/default.json` — whether the page there may ask the shell for
//!      anything. Change the first without the second and the window loads, the app works, and the
//!      badge and notifications silently stop: the bridge below feature-detects, so there is no
//!      error anywhere, just an app that quietly stopped being an app.
//!
//! The one page the shell serves itself is the connection page: an app whose whole UI lives on a
//! server has exactly one failure it must explain on its own, and that is not reaching the server.
//!
//! AND IT IS AWAKE WHEN THE WINDOW IS NOT. Until 2026-09 closing the window ended the process, so
//! "a Bot is waiting for you" could only be said by a page that was still on screen — which is the
//! one moment nobody needs telling. The tray, the close-to-tray, the autostart and the deep link
//! below exist for the other moment. They are still not product logic: every one of them resolves
//! to *a path on the origin*, focus, or process lifetime, and the allowlist in `link_target` is the
//! whole of what this process knows about what the product's paths mean.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

/// How long launch will wait to find out whether the origin is there.
///
/// Both halves of the probe are bounded by it, and it is deliberately short: this is time the person
/// spends looking at a dock icon and nothing else.
const PROBE_BUDGET: Duration = Duration::from_millis(1200);

/// The scheme the operating system hands back to this process.
///
/// Registered for macOS and Windows by `plugins.deep-link.desktop.schemes` in `tauri.conf.json`,
/// which the bundler turns into `CFBundleURLTypes` and an NSIS registry key. A scheme named in one
/// place and read in the other is a link that opens nothing, so both say `lafagent`.
const SCHEME: &str = "lafagent";

/// The shell's own settings, beside the app's data. Not the product's: two booleans about this
/// process, which is why they are here rather than on the person's account.
const SETTINGS_FILE: &str = "shell.json";
/// Whether a notice from the page reaches the notification centre.
const NOTICES_KEY: &str = "notices";

/// How long the destination of a notice is worth honouring.
///
/// See `ShellState::notice_destination` for why a destination is remembered at all. Ten minutes is
/// the same span the boundary gives a question before it expires: past it, whatever the notice was
/// about is over, and sending somebody to it would be sending them to an empty page.
const NOTICE_DESTINATION_TTL: Duration = Duration::from_secs(600);

/// What the shell remembers between the window being put away and picked up again.
#[derive(Default)]
struct ShellState {
    /// Where the newest notice pointed, and when it was posted.
    ///
    /// THE DESKTOP NOTIFICATION PLUGIN CANNOT REPORT A CLICK. Measured in
    /// `tauri-plugin-notification` 2.3.3: `src/desktop.rs` builds a `notify_rust::Notification`,
    /// spawns `let _ = notification.show()` and drops the handle; `register_action_types` and
    /// `on_action` exist only in `src/mobile.rs`. So there is no callback to hang a navigation on,
    /// and claiming one would be inventing it.
    ///
    /// What can be observed is the person coming back — the tray, the menu's 열기, the dock. So the
    /// destination is held here and spent the next time the window is brought forward, which is as
    /// close to "they clicked the notice" as this platform can honestly get. Everything else about
    /// finding the waiting question is the app's own routing, unchanged.
    notice_destination: Mutex<Option<(String, Instant)>>,
}

/// Where the app lives. Read from the bundled config so a build for a different deployment is a
/// different config and not a different binary.
fn origin(app: &tauri::AppHandle) -> String {
    app.config()
        .app
        .windows
        .first()
        .and_then(|window| match &window.url {
            tauri::WebviewUrl::External(url) => Some(url.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "http://localhost:3010".to_string())
}

/// Whether anything answers at the origin's address. A TCP connect, not an HTTP request: the
/// question is only "is there a server", and a server that is up but unhappy should get to show
/// its own page.
///
/// ON A WORKER THREAD, AND BOUNDED. This runs during `setup()`, which is before the event loop
/// starts and before any window is on screen, so every millisecond it takes is a millisecond the
/// person spends looking at a bouncing dock icon. Name resolution is the part that cannot be
/// bounded from the inside — `getaddrinfo` blocks for as long as the resolver wants, which on a
/// laptop that just woke with a captive portal is tens of seconds — so the whole thing happens
/// somewhere else and launch waits `PROBE_BUDGET` for the answer.
///
/// A probe that has not finished in time counts as REACHABLE. "I do not know yet" must not become
/// "the server is down": the webview is already loading the origin, and a slow network deserves to
/// keep loading rather than be replaced by a page announcing it is offline.
fn reachable(origin: &str) -> bool {
    let Ok(url) = tauri::Url::parse(origin) else {
        return false;
    };
    let (Some(host), Some(port)) = (
        url.host_str().map(str::to_owned),
        url.port_or_known_default(),
    ) else {
        return false;
    };

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        // Every address the name resolves to, not the first few: a host that is up on its second
        // address is up.
        let answered = (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| {
                addresses.into_iter().any(|address| {
                    TcpStream::connect_timeout(&address, PROBE_BUDGET).is_ok()
                })
            })
            .unwrap_or(false);
        let _ = sender.send(answered);
    });
    receiver.recv_timeout(PROBE_BUDGET).unwrap_or(true)
}

/// The shell's own connection page, with the origin for it to keep probing. A webview that cannot
/// load its page explains nothing — WKWebView stays blank, WebView2 shows its own error — so the
/// window is sent here instead, and the page navigates to the origin the moment it answers.
fn connection_page(app: &tauri::AppHandle, origin: &str) -> tauri::Url {
    let base = match &app.config().build.dev_url {
        // `tauri dev` does not embed `frontendDist`; it serves the folder from a server of its own
        // and writes that address here. A debug build asking its own scheme for the page gets
        // "asset not found" — measured — so in dev the page is fetched from where dev put it.
        Some(dev_server) if cfg!(debug_assertions) => dev_server
            .join("index.html")
            .expect("the dev server address is a base URL"),
        // A bundled app serves `frontendDist` on Tauri's own scheme, which differs by platform.
        _ => tauri::Url::parse(if cfg!(windows) {
            "http://tauri.localhost/index.html"
        } else {
            "tauri://localhost/index.html"
        })
        .expect("the shell page address is a literal"),
    };
    tauri::Url::parse(&connection_page_url(base.as_str(), origin))
        .expect("the page address was already a URL")
}

/// The page address with the origin it should keep retrying, encoded into the query.
///
/// Split out from the config lookup so the encoding can be tested: an origin that arrives at the
/// page half-escaped is a page that retries the wrong address, or nothing at all.
fn connection_page_url(base: &str, origin: &str) -> String {
    let mut url = tauri::Url::parse(base).expect("the page address is a URL");
    url.query_pairs_mut().append_pair("origin", origin);
    url.to_string()
}

/// The address on the origin that a kind and an id name, or nothing when they name none.
///
/// THE WHOLE OF WHAT THIS PROCESS KNOWS ABOUT THE PRODUCT'S PATHS, and deliberately a list of three.
/// Two callers arrive here — a `lafagent://` link the operating system handed over, and the
/// destination the page attaches to a notice — and neither may say "navigate to this path". An
/// allowlist is not politeness: a scheme handler is reachable by anything on the machine that can
/// call `open`, so a shell that forwarded an arbitrary path would be a way for any program to point
/// this window, holding this person's session, at any address on their deployment.
///
/// Built with `path_segments_mut` rather than `format!`, so the id is percent-encoded and the host
/// is the origin's — a segment containing `/` or `..` cannot climb out, and one containing `//`
/// cannot become a different site.
///
/// `connected` is the third and the odd one, because the product has no `/connected/<id>` page: a
/// consent that finished in the person's own browser sends them back here, and what they should see
/// is the connections list with the outcome on it. So the id becomes a QUERY value rather than a
/// path segment — `query_pairs_mut` encodes it exactly as `path_segments_mut` encodes the others,
/// and `connected=failed` is the same word the browser-tab redirect has always used, so the screen
/// needs to know nothing about where the person came back from.
fn link_target(origin: &str, kind: &str, id: &str) -> Option<String> {
    if !matches!(kind, "approve" | "channel" | "connected") || id.is_empty() {
        return None;
    }
    let mut url = tauri::Url::parse(origin).ok()?;
    if kind == "connected" {
        {
            let mut segments = url.path_segments_mut().ok()?;
            segments.clear();
            segments.push("settings");
            segments.push("connected-accounts");
        }
        url.query_pairs_mut().append_pair("connected", id);
        return Some(url.to_string());
    }
    {
        let mut segments = url.path_segments_mut().ok()?;
        segments.clear();
        segments.push(kind);
        segments.push(id);
    }
    Some(url.to_string())
}

/// The address a `lafagent://` link names, or nothing when it names none.
///
/// `lafagent://approve/<id>`, `lafagent://channel/<id>` and `lafagent://connected/<id>`: the host
/// is the kind and the single path segment is the id. A link with no id, more than one segment,
/// another scheme or another host resolves to nothing and the window stays where it was — the
/// honest answer to a link this shell does not understand, rather than a guess at what it might
/// have meant.
fn deep_link_url(origin: &str, link: &str) -> Option<String> {
    let url = tauri::Url::parse(link).ok()?;
    if url.scheme() != SCHEME {
        return None;
    }
    let kind = url.host_str()?;
    let mut segments = url.path_segments()?;
    let id = segments.next()?;
    // Exactly one segment. A trailing slash leaves an empty one behind, which is the same link.
    if segments.any(|rest| !rest.is_empty()) {
        return None;
    }
    link_target(origin, kind, id)
}

/// The window, on screen and in front, from wherever it was.
///
/// Three calls because a window can be away in three different ways, and each of them is a separate
/// no-op when it does not apply. `app.show()` is the macOS one: hiding the last window there leaves
/// the *process* hidden as well, so showing the window alone brings up something the person cannot
/// see behind whatever they are working in.
fn present(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("no main window to show");
        return;
    };
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = window.unminimize();
    if let Err(error) = window.show() {
        log::error!("the window could not be shown: {error}");
    }
    let _ = window.set_focus();
}

/// Send the window to an address on the origin.
fn navigate(app: &tauri::AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(parsed) = tauri::Url::parse(url) else {
        return;
    };
    if let Err(error) = window.navigate(parsed) {
        log::error!("could not follow the link: {error}");
    }
}

/// Bring the window forward, and spend whatever the last notice was pointing at.
///
/// The pending destination is taken whether or not it is still fresh: a stale one is not worth
/// following and is certainly not worth following later.
fn present_where_the_notice_pointed(app: &tauri::AppHandle) {
    let pending = app
        .state::<ShellState>()
        .notice_destination
        .lock()
        .ok()
        .and_then(|mut held| held.take());
    present(app);
    let Some((url, at)) = pending else {
        log::info!("nothing was waiting to be come back to");
        return;
    };
    if at.elapsed() >= NOTICE_DESTINATION_TTL {
        log::info!("a notice pointed at {url}, but too long ago to follow");
        return;
    }
    log::info!("following the newest notice to {url}");
    navigate(app, &url);
}

/// Follow a link the operating system handed over.
///
/// The pending notice destination is dropped rather than followed: somebody who opened a link asked
/// for that page, and arriving somewhere else because a notice fired a minute earlier is the kind of
/// surprise that makes an app feel haunted.
fn open_deep_link(app: &tauri::AppHandle, link: &str) {
    let Some(url) = deep_link_url(&origin(app), link) else {
        log::warn!("a link this shell does not understand: {link}");
        return;
    };
    if let Ok(mut held) = app.state::<ShellState>().notice_destination.lock() {
        held.take();
    }
    log::info!("following a link to {url}");
    present(app);
    navigate(app, &url);
}

/// Whether a notice from the page reaches the notification centre.
///
/// Absent means yes: somebody who has never touched the tray switch installed an app in order to be
/// told things. The store is read rather than cached so the answer is the same one the tray's tick
/// is drawn from, and there is only ever one of them.
fn notices_enabled(app: &tauri::AppHandle) -> bool {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(NOTICES_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn set_notices_enabled(app: &tauri::AppHandle, enabled: bool) {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        log::warn!("the shell's settings could not be opened; the change lasts this launch only");
        return;
    };
    store.set(NOTICES_KEY, enabled);
    if let Err(error) = store.save() {
        log::warn!("the shell's settings could not be written: {error}");
    }
}

/// Where a notice should land, as the page describes it.
///
/// A kind and an id, never a path: the page says what it is about and the allowlist in
/// `link_target` decides where that is, so there is one place in this process that can turn
/// somebody's notification into a navigation.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeDestination {
    kind: String,
    id: String,
}

/// Post a notice through the operating system, unless the tray says not to.
///
/// The page used to call the notification plugin's own binding. It comes through here instead for
/// two reasons: the tray's switch has to be able to stop it — a mute the page could route around is
/// not a mute — and this is where the destination is remembered.
///
/// `silent` is taken and dropped on purpose. On desktop the plugin's `silent` is iOS-only (measured:
/// `models.rs` holds the flag, `desktop.rs` never reads it), so a Bot that merely finished still
/// makes whatever sound the person's system makes. Accepting the argument keeps the page's two
/// kinds honest for the day a platform does something with it; pretending it worked would not.
#[tauri::command]
fn post_notice(
    app: tauri::AppHandle,
    title: String,
    body: String,
    silent: bool,
    destination: Option<NoticeDestination>,
) -> Result<(), String> {
    // Logged rather than dropped in silence, because this is the seam where "the app said a Bot was
    // waiting" and "the person's machine showed something" stop being the same sentence, and the
    // difference is otherwise invisible from either side. `silent` appears here and nowhere else,
    // which is the whole truth about it on this platform.
    log::info!("a notice from the page: {title:?} silent={silent}");
    if !notices_enabled(&app) {
        log::info!("notices are switched off in the tray; staying quiet");
        // Not an error. The person asked for silence and got it, and a caller told otherwise would
        // fall back to the webview's own notification and undo the switch they just pressed.
        return Ok(());
    }
    match destination
        .as_ref()
        .and_then(|it| link_target(&origin(&app), &it.kind, &it.id))
    {
        Some(url) => {
            log::info!("a notice pointing at {url}");
            if let Ok(mut held) = app.state::<ShellState>().notice_destination.lock() {
                held.replace((url, Instant::now()));
            }
        }
        // Worth a line rather than a silent nothing: a notice that arrives with no destination is
        // a notice a person can only answer by going and finding what it was about.
        None => log::info!("a notice pointing nowhere: {destination:?}"),
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

/// The number of rooms waiting, on the dock icon.
///
/// The one thing a webview cannot do for itself: `navigator.setAppBadge` is a Chromium-PWA API and
/// WKWebView has no equivalent, so without this the app's only badge was a number in the tab title,
/// and a dock icon has no title. The SPA calls this when it holds `window.__TAURI__`; a count of
/// zero clears it. The same value the tab title carried, in the place a person actually looks.
#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window
        .set_badge_count(if count == 0 { None } else { Some(count as i64) })
        .map_err(|error| error.to_string())
}

/// Open a link in the person's own browser.
///
/// Every link a Bot writes is rendered `target="_blank"` (`app/src/lib/markdown.tsx`), and a webview
/// has nowhere to put a new window: without this, clicking any link in any message does nothing at
/// all. The page asks for this command rather than the shell plugin's own `open`, and the plugin is
/// deliberately NOT granted to the origin — a general-purpose opener reachable from a web page can
/// launch whatever a scheme handler is registered for, and this can only open the web.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let web = web_url(&url)?;
    app.opener()
        .open_url(web, None::<&str>)
        .map_err(|error| error.to_string())
}

/// The web address in `url`, or why it is not one.
///
/// Separate from the command so the rule can be stated once and tested: the page asking is a web
/// page, and handing the operating system an arbitrary scheme is how a link becomes a way to launch
/// whatever a scheme handler is registered for.
fn web_url(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "not a link".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        scheme => Err(format!("{scheme} links are not opened")),
    }
}

/// Fetch and install a newer version, if the release the endpoint points at is newer than this one.
///
/// Release builds only: a development launch has no business asking GitHub, and the version it
/// would compare is whatever happens to be in the config. Failure is logged and nothing else — an
/// app that cannot reach its update endpoint is an app that still has to run.
///
/// Installed rather than merely downloaded, and WITHOUT a restart: the new version is in place for
/// the next launch. Restarting an app somebody is using, to deliver a change they did not ask for,
/// is the behaviour that teaches people to dread updates.
#[cfg(not(debug_assertions))]
fn install_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) => {
                log::warn!("no updater configured: {error}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                log::info!("update {} is available; installing", update.version);
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => log::info!("update installed; it applies on the next launch"),
                    Err(error) => log::warn!("update could not be installed: {error}"),
                }
            }
            Ok(None) => log::info!("no update available"),
            Err(error) => log::warn!("update check failed: {error}"),
        }
    });
}

/// The icon in the menu bar, and the four things reachable from it.
///
/// KOREAN, IN THE SHELL. Everywhere else in this product the surface owns the words and the server
/// sends facts, but a tray menu is drawn by the operating system out of strings this process holds:
/// there is no page to ask. So these four are written here, in the language the product leads in,
/// the same way `public/index.html` is.
///
/// The menu is the whole of the shell's UI, and each item is one of the things a window cannot do
/// for itself once it has been put away: come back, stop making noise, start with the machine, and
/// end.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
    let notices = CheckMenuItem::with_id(
        app,
        "notices",
        "알림 받기",
        true,
        notices_enabled(app),
        None::<&str>,
    )?;
    /*
     * AUTOSTART IS READ FROM THE OPERATING SYSTEM, NOT FROM A FILE OF OURS.
     *
     * `is_enabled()` asks whether the LaunchAgent plist (macOS) or the Run key (Windows) is there,
     * which is the thing that actually decides whether the app starts — so the tick cannot disagree
     * with the behaviour, and there is no second copy of the setting to migrate, corrupt or lose.
     * That is also why this one boolean needs no store: the OS already remembers it.
     */
    let starts_with_login = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "로그인할 때 자동 실행",
        true,
        starts_with_login,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &notices,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(&app.config().product_name.clone().unwrap_or_default())
        .menu(&menu)
        /*
         * Where the click goes differs by platform, and both are the platform's own habit rather
         * than a preference. On macOS a menu bar item opens its menu on any click and 열기 is how
         * the window comes back. On Windows a left click on a tray icon restores the window and the
         * menu belongs to the right button.
         */
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => present_where_the_notice_pointed(app),
            "notices" => {
                let enabled = !notices_enabled(app);
                set_notices_enabled(app, enabled);
                // The tick is set from what was stored, not from what was asked for: a write that
                // failed leaves a menu that tells the truth about a mute that did not take.
                let _ = notices.set_checked(notices_enabled(app));
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let result = if launcher.is_enabled().unwrap_or(false) {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                if let Err(error) = result {
                    log::warn!("autostart could not be changed: {error}");
                }
                let _ = autostart.set_checked(launcher.is_enabled().unwrap_or(false));
            }
            // The one way out other than the platform's own Quit. Everything else about this menu
            // exists because closing the window no longer ends the process.
            "quit" => app.exit(0),
            other => log::warn!("unknown tray item: {other}"),
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            present_where_the_notice_pointed(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![
            set_badge,
            open_external,
            post_notice
        ])
        /*
         * SINGLE INSTANCE FIRST, AND BEFORE ANY WINDOW EXISTS.
         *
         * The plugin decides whether this process is the second one, and a second process that got
         * as far as building a window would flash one on screen before disappearing. On Windows and
         * Linux a deep link IS a second launch — the operating system runs the binary again with
         * the URL as its only argument — so without this, following a link would open a whole new
         * app beside the one already signed in.
         */
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("a second launch arrived; keeping this one");
            // What the second process was asked to open, if it was asked to open anything. The
            // plugin's `deep-link` feature routes it to the same `on_open_url` the first launch
            // listens on, so both platforms' links end up in one place.
            app.deep_link().handle_cli_arguments(argv.iter());
            present(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        /*
         * Off unless somebody turns it on, from the tray, and remembered by the operating system.
         * An app that adds itself to a person's login items on first launch is one they uninstall.
         * `LaunchAgent` over `AppleScript`: a plist this app writes is one it can also remove,
         * where the AppleScript route edits the person's Login Items list and asks for permission
         * to drive System Events to do it.
         */
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let target = origin(app.handle());
            log::info!("window origin: {target}");
            if let Some(window) = app.get_webview_window("main") {
                // The window is declared with the origin as its URL and is already loading it. It
                // is surfaced only once the webview exists, which avoids a white flash on launch —
                // and only after the origin answered, so what appears is the app or an explanation,
                // never a blank page.
                if !reachable(&target) {
                    log::warn!("origin unreachable, showing the connection page: {target}");
                    if let Err(error) = window.navigate(connection_page(app.handle(), &target)) {
                        log::error!("could not show the connection page: {error}");
                    }
                }
                if let Err(error) = window.show() {
                    log::error!("the window could not be shown: {error}");
                }
                /*
                 * CLOSING PUTS THE WINDOW AWAY; IT DOES NOT END THE APP.
                 *
                 * This is the whole reason the rest of this file exists. A person who closes the
                 * window has finished looking at it, not finished with their Bots — and the Bots
                 * keep working on the server either way, so the thing that has to survive is the
                 * process that can tell them about it. Quit is still one gesture away, from the
                 * tray or from the platform's own Quit, and both really end the process.
                 */
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                        // macOS only: with no window left on screen the process stays frontmost,
                        // holding the menu bar of an app with nothing to show. Hiding it hands the
                        // foreground back to whatever the person was actually using.
                        #[cfg(target_os = "macos")]
                        let _ = handle.hide();
                    }
                });
            } else {
                /*
                 * Nothing will appear, and the process will sit there looking alive. Worth saying
                 * out loud: the one time this was seen, the cause was outside the app entirely —
                 * a LOCKED SCREEN, which terminates WKWebView's content process, so the webview
                 * never finishes being created. An app that logs nothing here looks like a bug in
                 * itself.
                 */
                log::error!("no main window at setup: nothing will be visible");
            }
            if let Err(error) = build_tray(app.handle()) {
                // Survivable, and worth saying loudly: without the tray, closing the window leaves
                // a process with no way back to it and no way to quit it.
                log::error!("no tray icon: {error}");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_deep_link(&handle, url.as_str());
                }
            });
            /*
             * A link that started the app rather than arriving at a running one. On macOS the
             * `Opened` event fires before this listener exists; on Windows and Linux the URL is a
             * command-line argument the plugin has already read. Either way it is waiting here.
             */
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    open_deep_link(app.handle(), url.as_str());
                }
            }
            #[cfg(not(debug_assertions))]
            install_updates(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the desktop shell failed to start")
        .run(|app, event| {
            /*
             * The dock icon of an app whose window is hidden. macOS sends this instead of launching
             * a second copy, and an app that ignores it is one that cannot be reopened from the
             * dock at all — which, now that closing only hides, is most of the time.
             */
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                present_where_the_notice_pointed(app);
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{connection_page_url, deep_link_url, link_target, web_url};

    const ORIGIN: &str = "https://agent.laf-co.com";

    #[test]
    fn a_link_lands_on_the_page_it_names() {
        assert_eq!(
            deep_link_url(ORIGIN, "lafagent://approve/a1b2").as_deref(),
            Some("https://agent.laf-co.com/approve/a1b2")
        );
        assert_eq!(
            deep_link_url(ORIGIN, "lafagent://channel/room-7").as_deref(),
            Some("https://agent.laf-co.com/channel/room-7")
        );
        // The development origin keeps its port, and a link is relative to wherever this build
        // points — one binary, whichever deployment it was pointed at.
        assert_eq!(
            deep_link_url("http://localhost:3010", "lafagent://approve/x").as_deref(),
            Some("http://localhost:3010/approve/x")
        );
    }

    /// A consent that finished in the person's own browser sends them back here.
    ///
    /// The id is a QUERY value rather than a path segment, because the product has no
    /// `/connected/<id>` page — what they should see is the connections list with the outcome on
    /// it, which is the same `?connected=` the browser-tab redirect has always used.
    #[test]
    fn a_finished_connection_lands_on_the_connections_list() {
        assert_eq!(
            deep_link_url(ORIGIN, "lafagent://connected/google-sheets").as_deref(),
            Some("https://agent.laf-co.com/settings/connected-accounts?connected=google-sheets")
        );
        // The failure word is the one the screen already knows, so nothing there has to learn
        // where the person came back from.
        assert_eq!(
            deep_link_url(ORIGIN, "lafagent://connected/failed").as_deref(),
            Some("https://agent.laf-co.com/settings/connected-accounts?connected=failed")
        );
        assert_eq!(
            deep_link_url("http://localhost:3010", "lafagent://connected/notion").as_deref(),
            Some("http://localhost:3010/settings/connected-accounts?connected=notion")
        );
    }

    /// The query is where an id could stop being an id, so it is encoded exactly as a segment is.
    ///
    /// A `#` that survived would truncate the URL to a fragment and land the window on the bare
    /// connections page; an `&` that survived would let a link somebody else's program opened add
    /// a second parameter of its own choosing.
    #[test]
    fn a_connection_id_cannot_climb_out_of_its_query_value() {
        for (id, expected) in [
            ("a&b=c", "a%26b%3Dc"),
            ("a#b", "a%23b"),
            ("../../admin/credentials", "..%2F..%2Fadmin%2Fcredentials"),
        ] {
            let url = link_target(ORIGIN, "connected", id).expect("an id is still an id");
            assert_eq!(
                url,
                format!("https://agent.laf-co.com/settings/connected-accounts?connected={expected}")
            );
        }
        assert!(link_target(ORIGIN, "connected", "").is_none());
    }

    /// A scheme handler is reachable by anything on the machine that can call `open`. Every line
    /// here is a way somebody else's program could have pointed this window — holding this person's
    /// signed-in session — somewhere they did not ask to go.
    #[test]
    fn a_link_can_only_name_the_three_pages_it_is_allowed_to() {
        for refused in [
            // Not ours.
            "https://agent.laf-co.com/admin/credentials",
            "lafagent2://approve/x",
            // Ours, naming something that is not one of the two.
            "lafagent://admin/credentials",
            "lafagent://approve",
            "lafagent://approve/",
            "lafagent://approve/a/b",
            "lafagent:///approve/a",
            // The third kind is an allowlist entry too, not an opening: same shape, same refusals.
            "lafagent://connected",
            "lafagent://connected/",
            "lafagent://connected/a/b",
            "not a url at all",
            "",
        ] {
            assert!(
                deep_link_url(ORIGIN, refused).is_none(),
                "should refuse {refused}"
            );
        }
    }

    /// An id is a segment, not a piece of a path. Everything here used to be a way to leave the two
    /// pages the allowlist names while still passing it.
    #[test]
    fn an_id_cannot_climb_out_of_its_segment() {
        for (id, expected) in [
            // The separators are what matter, and they are encoded: the whole thing stays ONE
            // segment, so the leading dots are just characters in an id nothing will match.
            ("../../admin/credentials", "..%2F..%2Fadmin%2Fcredentials"),
            ("a/b", "a%2Fb"),
            ("a?b=c", "a%3Fb=c"),
            ("a#b", "a%23b"),
        ] {
            let url = link_target(ORIGIN, "approve", id).expect("an id is still an id");
            assert_eq!(url, format!("https://agent.laf-co.com/approve/{expected}"));
        }
        // And a host can only ever be the origin's, whatever an id tries to say.
        for id in ["//evil.example", "/../..//evil.example", ".."] {
            let url = link_target(ORIGIN, "channel", id).expect("an id is still an id");
            assert!(
                url.starts_with("https://agent.laf-co.com/"),
                "{id} left the origin: {url}"
            );
        }
        assert!(link_target(ORIGIN, "approve", "").is_none());
        assert!(link_target(ORIGIN, "admin", "x").is_none());
    }

    /// The shell decides two things on its own. Both are one line, and both are the kind of line
    /// that is wrong in a way nobody notices until it matters.
    #[test]
    fn only_the_web_is_opened() {
        assert_eq!(
            web_url("https://wttr.in/Seoul").as_deref(),
            Ok("https://wttr.in/Seoul")
        );
        assert!(web_url("http://localhost:3010/channel/a").is_ok());
        // Everything else is a way to hand the operating system something it will act on.
        for refused in [
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "javascript:alert(1)",
            "ftp://example.com",
            "not a url at all",
            "",
        ] {
            assert!(web_url(refused).is_err(), "should refuse {refused}");
        }
    }

    #[test]
    fn the_connection_page_carries_the_origin_it_should_retry() {
        let page = connection_page_url("tauri://localhost/index.html", "http://localhost:3010");
        assert!(page.starts_with("tauri://localhost/index.html?origin="));
        // Encoded, so the page reads back exactly the address the shell was pointed at.
        assert!(page.contains("http%3A%2F%2Flocalhost%3A3010"));
    }
}
