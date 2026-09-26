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
//! exactly as it does in a browser. It is TWO values, and it is the same address a phone will use:
//!
//!   1. `app.windows[0].url` in `tauri.conf.json` — where the window goes on a first launch.
//!   2. `remote.urls` in `capabilities/default.json` — whether the page there may ask the shell for
//!      anything. Change the first without the second and the window loads, the app works, and the
//!      badge and notifications silently stop: the bridge below feature-detects, so there is no
//!      error anywhere, just an app that quietly stopped being an app.
//!
//! ONE BUILD OPENS THE WHOLE FLEET, so those two name the front door and the wildcard rather than a
//! customer: `https://agent.laf-co.com` and `https://*.agent.laf-co.com`. A person installs the one
//! installer, signs in at the front door and is walked to their own `<name>.agent.laf-co.com`. The
//! shell writes that down (`remember_origin`) and opens there next time, so the walk is a first
//! launch and not every launch — and `origin()` is where the window IS rather than what it was
//! compiled with, because a link and a notice belong to the deployment, not to the front door.
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
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
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

/// The shell's own settings, beside the app's data. Not the product's: a switch and an address
/// about this process, which is why they are here rather than on the person's account.
const SETTINGS_FILE: &str = "shell.json";
/// Whether a notice from the page reaches the notification centre.
const NOTICES_KEY: &str = "notices";
/// The deployment this app was last used on, so the next launch opens there.
const ORIGIN_KEY: &str = "origin";
/// Which summon shortcut the person chose, by its id in `SUMMON_CHOICES`, or `off`.
const SUMMON_KEY: &str = "summon";

/// The summon shortcuts a person can choose between, by the id the page sends, and `off`.
///
/// A LIST, NOT A RECORDER. A global shortcut takes a key combination away from every other program
/// on the machine while this one runs, so a page that could register any combination could take
/// Cmd+C from the person's whole computer. The page names an id; this list decides what it means.
///
/// THE DEFAULT IS ⌃⌥L (Ctrl+Alt+L), and each of these was chosen by what it does NOT collide with.
/// Space with Ctrl, Cmd or Option is taken on the machines this product is for: ⌃Space and ⌃⌥Space
/// switch the input source on macOS — the 한/영 key of a Korean Mac — ⌘Space is Spotlight, and
/// ⌥Space, ⌘⇧Space and Ctrl+Shift+Space are what ChatGPT, Raycast and 1Password install. Ctrl/Cmd+
/// Shift+letter is every browser's and Excel's (Ctrl+Shift+L is Excel's filter). ⌃⌥ with a letter
/// is VoiceOver's only while VoiceOver is on, and L is the product's own letter. ⌥Space stays on
/// the list for the person who has none of those apps and wants the familiar one.
const SUMMON_CHOICES: [&str; 4] = ["control-alt-l", "alt-shift-l", "alt-space", "off"];
const SUMMON_DEFAULT: &str = "control-alt-l";
const SUMMON_OFF: &str = "off";

/// What the page is told when an update is ready. A nudge only: the version is read back through
/// `update_ready`, because the page can emit events too and an event is not a fact.
const UPDATE_READY_EVENT: &str = "update-ready";

/// The product's domain. The front door is this name; every customer is ONE name under it.
///
/// The same shape `capabilities/default.json` grants — `https://agent.laf-co.com` and
/// `https://*.agent.laf-co.com`. An origin this shell opens that the capability does not grant is
/// a window where the badge, the notices and the links out silently stop, so the two are read
/// together by `tests/desktop-shell.test.ts` rather than kept in step by hand.
const FLEET_DOMAIN: &str = "agent.laf-co.com";

/// The development server, the one address outside the fleet a DEVELOPMENT build will open.
///
/// ABSENT FROM A RELEASE BUILD. An address on the person's own machine is not the fleet: anything
/// that can listen on port 3010 — a program they installed, a script somebody talked them into
/// running — would be served in this window as their deployment and handed the badge, the notices
/// and the links out. So the constant only exists with `debug_assertions`, which makes a release
/// path that still reads it a compile error rather than something a review has to catch, and its
/// grant is `capabilities/dev.json`, which only `tauri.dev.conf.json` applies.
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:3010";

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
    /// The tray's status line, once the tray exists, and what it says now.
    status_line: Mutex<Option<MenuItem<tauri::Wry>>>,
    status: Mutex<Option<BotStatus>>,
    /// A newer version, verified and in hand, once the updater has fetched one.
    update: Mutex<Option<ReadyUpdate>>,
}

/// What the Bot is doing, as the tray says it.
///
/// THE PAGE DERIVES IT AND SENDS A CODE; THE WORDS ARE HERE. The pill in the app decides from facts
/// only the page has (`app/src/lib/agents/presence.ts`), so the shell repeats its answer rather
/// than guessing one. But a tray menu is drawn by the operating system out of strings this process
/// holds — the same reason 열기 and 종료 are Korean literals below — and a page that could put any
/// text it liked into a native menu is a page that could make the menu say anything. Three codes,
/// three sentences, and a code this list does not know is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BotStatus {
    Working,
    Waiting,
    Idle,
}

impl BotStatus {
    fn from_code(code: &str) -> Option<Self> {
        match code {
            "working" => Some(Self::Working),
            "waiting" => Some(Self::Waiting),
            "idle" => Some(Self::Idle),
            _ => None,
        }
    }

    fn words(self) -> &'static str {
        match self {
            Self::Working => "일하는 중",
            Self::Waiting => "사장님 차례",
            Self::Idle => "쉬는 중",
        }
    }

    /// The dot drawn on the tray icon: amber when the person is being waited on — the pill's own
    /// colour for it — green while the Bot works, and none at rest, so the ordinary state is the
    /// ordinary icon.
    fn dot(self) -> Option<[u8; 3]> {
        match self {
            Self::Waiting => Some([0xF5, 0x9E, 0x0B]),
            Self::Working => Some([0x22, 0xC5, 0x5E]),
            Self::Idle => None,
        }
    }
}

/// A newer version the updater has fetched and verified, waiting for a restart.
///
/// ON WINDOWS IT IS NOT YET INSTALLED, and that is the point of holding the bytes. The updater's
/// Windows `install()` launches the NSIS installer and then calls `std::process::exit(0)`
/// (tauri-plugin-updater 2.10.1, `updater.rs`), so the `download_and_install` this shell used to
/// call at launch ended the app a minute after somebody opened it — mid-task, the thing it promised
/// never to do. On macOS `install()` replaces the bundle in place and the process runs on, so there
/// the update is installed at once and waits only for the next launch or 지금 다시 시작.
struct ReadyUpdate {
    version: String,
    #[cfg(all(windows, not(debug_assertions)))]
    installer: (tauri_plugin_updater::Update, Vec<u8>),
}

/// The address this build was compiled pointing at: the product's front door.
///
/// Read from the bundled config rather than written here, so `tauri.dev.conf.json` moves a
/// development launch without a second constant to keep in step.
fn configured_origin(app: &tauri::AppHandle) -> String {
    let declared = app
        .config()
        .app
        .windows
        .first()
        .and_then(|window| match &window.url {
            tauri::WebviewUrl::External(url) => Some(url.to_string()),
            _ => None,
        })
        // The front door, never the development server: a release build knows no other address.
        .unwrap_or_else(|| format!("https://{FLEET_DOMAIN}"));
    // Normalised to a bare origin so it compares with what the window reports and with what was
    // remembered: `Url::to_string` adds the trailing slash that an origin does not carry.
    fleet_origin(&declared).unwrap_or(declared)
}

/// `candidate` as a bare origin, when it is one this shell is allowed to open. Nothing otherwise.
///
/// EVERY ANSWER HERE HAS TO BE INSIDE THE CAPABILITY GRANT. A window pointed at an origin
/// `capabilities/default.json` does not list still loads and still works — and the badge, the
/// notices and the links out are refused with no error anywhere, because the bridge feature-detects
/// and reads a rejection as "no shell". So this is stricter than a suffix check in both of the ways
/// a suffix check is wrong: `evil-agent.laf-co.com` ends with the domain and is not under it, and
/// `a.b.agent.laf-co.com` is two names deep where the grant has one `*`.
fn fleet_origin(candidate: &str) -> Option<String> {
    let url = tauri::Url::parse(candidate).ok()?;
    let serialized = url.origin().ascii_serialization();
    #[cfg(debug_assertions)]
    if serialized == DEV_ORIGIN {
        return Some(serialized);
    }
    // A port would put it outside the grant as surely as a different host would.
    if url.scheme() != "https" || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let under_the_domain = host
        .strip_suffix(FLEET_DOMAIN)
        .and_then(|name| name.strip_suffix('.'))
        .is_some_and(|name| !name.is_empty() && !name.contains('.'));
    (host == FLEET_DOMAIN || under_the_domain).then_some(serialized)
}

/// The deployment this app was last used on, if there is one and it is still one we may open.
///
/// Validated on the way out as well as on the way in: a settings file somebody edited by hand, or
/// one written by a build that granted a different domain, must not decide where this window goes.
fn remembered_origin(app: &tauri::AppHandle) -> Option<String> {
    let stored = app.store(SETTINGS_FILE).ok()?.get(ORIGIN_KEY)?;
    fleet_origin(stored.as_str()?)
}

/// Where the window goes when the app opens: the deployment last used, or the front door.
fn launch_origin(app: &tauri::AppHandle) -> String {
    remembered_origin(app).unwrap_or_else(|| configured_origin(app))
}

/// Where the window is right now, when that is somewhere this shell knows.
///
/// A link and a notice are relative to the deployment the person is signed into, NOT to the address
/// this build was compiled with. One build opens the whole fleet, so those stopped being the same
/// thing: an approval raised on `mystore.agent.laf-co.com` used to resolve to
/// `https://agent.laf-co.com/approve/<id>` — the front door, which knows nothing about it.
fn origin(app: &tauri::AppHandle) -> String {
    app.get_webview_window("main")
        .and_then(|window| window.url().ok())
        .and_then(|url| fleet_origin(url.as_str()))
        .or_else(|| remembered_origin(app))
        .unwrap_or_else(|| configured_origin(app))
}

/// Write down where the window is, so the next launch opens there instead of at the front door.
///
/// WHY THE SHELL REMEMBERS RATHER THAN THE PERSON TYPING IT. Every customer has an origin of their
/// own and one build opens all of them, so a freshly installed app can only start at the front
/// door, which signs the person in and walks them to theirs. That is the right first launch and the
/// wrong tenth: it needs the front door to be up, and it happens again every single time. So
/// whatever fleet origin the window is on when it is put away is kept, and the next launch goes
/// straight there. Nothing has to unwind it — signing out lands back on the front door, which is a
/// fleet origin too, and the next put-away writes that.
fn remember_origin(app: &tauri::AppHandle) {
    let here = origin(app);
    if remembered_origin(app).as_deref() == Some(here.as_str()) {
        return;
    }
    let Ok(store) = app.store(SETTINGS_FILE) else {
        log::warn!(
            "the shell's settings could not be opened; the next launch starts at the front door"
        );
        return;
    };
    log::info!("remembering {here} for the next launch");
    store.set(ORIGIN_KEY, here);
    if let Err(error) = store.save() {
        log::warn!("the shell's settings could not be written: {error}");
    }
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
                addresses
                    .into_iter()
                    .any(|address| TcpStream::connect_timeout(&address, PROBE_BUDGET).is_ok())
            })
            .unwrap_or(false);
        let _ = sender.send(answered);
    });
    receiver.recv_timeout(PROBE_BUDGET).unwrap_or(true)
}

/// The shell's own connection page, with the origin for it to keep probing. A webview that cannot
/// load its page explains nothing — WKWebView stays blank, WebView2 shows its own error — so the
/// window is sent here instead, and the page navigates to the origin the moment it answers.
fn connection_page(app: &tauri::AppHandle, origin: &str, home: &str) -> tauri::Url {
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
    tauri::Url::parse(&connection_page_url(base.as_str(), origin, home))
        .expect("the page address was already a URL")
}

/// The page address with the origin it should keep retrying, encoded into the query.
///
/// Split out from the config lookup so the encoding can be tested: an origin that arrives at the
/// page half-escaped is a page that retries the wrong address, or nothing at all.
///
/// `home` is carried only when it differs from `origin`, and it is the way out of a remembered
/// deployment that is never coming back. Without it a customer whose address changed would be an
/// app retrying a dead host forever, with the front door — which is where they would be told the
/// new one — unreachable from inside the window. The page draws no button when there is no second
/// address to offer.
fn connection_page_url(base: &str, origin: &str, home: &str) -> String {
    let mut url = tauri::Url::parse(base).expect("the page address is a URL");
    url.query_pairs_mut().append_pair("origin", origin);
    if home != origin {
        url.query_pairs_mut().append_pair("home", home);
    }
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

/// What the Bot is doing, from the page, onto the tray.
#[tauri::command]
fn set_status(app: tauri::AppHandle, status: String) -> Result<(), String> {
    let status =
        BotStatus::from_code(&status).ok_or_else(|| format!("{status:?} is not a status"))?;
    show_status(&app, status);
    Ok(())
}

/// Put a status on the tray: its line in the menu, its tooltip and the dot on its icon.
///
/// Skipped when nothing changed, because the page says it on every render that could have changed
/// it and a tray icon rebuilt that often is a menu bar that flickers.
fn show_status(app: &tauri::AppHandle, status: BotStatus) {
    let state = app.state::<ShellState>();
    {
        let Ok(mut current) = state.status.lock() else {
            return;
        };
        if *current == Some(status) {
            return;
        }
        current.replace(status);
    }
    log::info!("tray status: {status:?}");
    if let Some(line) = state.status_line.lock().ok().and_then(|line| line.clone()) {
        let _ = line.set_text(status.words());
    }
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let name = app.config().product_name.clone().unwrap_or_default();
    let _ = tray.set_tooltip(Some(format!("{name} · {}", status.words())));
    if let Some(icon) = app.default_window_icon() {
        let icon = match status.dot() {
            Some(colour) => tauri::image::Image::new_owned(
                with_dot(icon.rgba(), icon.width(), icon.height(), colour),
                icon.width(),
                icon.height(),
            ),
            None => icon.clone(),
        };
        if let Err(error) = tray.set_icon(Some(icon)) {
            log::warn!("the tray icon could not show {status:?}: {error}");
        }
    }
}

/// The icon with a round dot in its lower right corner, ringed in white so it reads on a dark menu
/// bar and a light one alike. Pixels in, pixels out, so it can be tested without a tray.
fn with_dot(rgba: &[u8], width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    if out.len() != (width as usize) * (height as usize) * 4 {
        return out;
    }
    let size = width.min(height) as f32;
    let radius = size * 0.2;
    let ring = radius + size * 0.05;
    let (centre_x, centre_y) = (width as f32 - ring, height as f32 - ring);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - centre_x, y as f32 + 0.5 - centre_y);
            let distance = (dx * dx + dy * dy).sqrt();
            let at = ((y * width + x) * 4) as usize;
            if distance <= radius {
                out[at..at + 4].copy_from_slice(&[colour[0], colour[1], colour[2], 255]);
            } else if distance <= ring {
                out[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
    out
}

/// The key combination a summon choice names, or nothing for `off` and for anything unknown.
fn summon_shortcut_for(choice: &str) -> Option<Shortcut> {
    match choice {
        "control-alt-l" => Some(Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::ALT),
            Code::KeyL,
        )),
        "alt-shift-l" => Some(Shortcut::new(
            Some(Modifiers::ALT | Modifiers::SHIFT),
            Code::KeyL,
        )),
        "alt-space" => Some(Shortcut::new(Some(Modifiers::ALT), Code::Space)),
        _ => None,
    }
}

fn is_summon_choice(choice: &str) -> bool {
    choice == SUMMON_OFF || summon_shortcut_for(choice).is_some()
}

/// The summon choice in force: what the person picked, or the default when they never have.
fn summon_choice(app: &tauri::AppHandle) -> String {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(SUMMON_KEY))
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|choice| is_summon_choice(choice))
        .unwrap_or_else(|| SUMMON_DEFAULT.to_owned())
}

/// Hold the chosen shortcut and nothing else. False when it is off or could not be had.
///
/// Registration can fail for reasons outside this process — the operating system decides, and the
/// plugin returns its refusal as an error. So the answer is reported back to the settings row
/// rather than assumed: a choice that reads "on" over a key that does nothing is the control that
/// saves and does nothing.
fn apply_summon(app: &tauri::AppHandle, choice: &str) -> bool {
    let shortcuts = app.global_shortcut();
    if let Err(error) = shortcuts.unregister_all() {
        log::warn!("the previous summon shortcut could not be released: {error}");
    }
    let Some(shortcut) = summon_shortcut_for(choice) else {
        log::info!("no summon shortcut ({choice})");
        return false;
    };
    match shortcuts.register(shortcut) {
        Ok(()) => {
            log::info!("summon shortcut: {choice}");
            true
        }
        Err(error) => {
            log::warn!("the summon shortcut {choice} could not be registered: {error}");
            false
        }
    }
}

/// What the settings row draws: the choice, the list it is from, and whether it is really held.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SummonSetting {
    choice: String,
    choices: [&'static str; 4],
    active: bool,
}

fn summon_setting(app: &tauri::AppHandle) -> SummonSetting {
    let choice = summon_choice(app);
    let active =
        summon_shortcut_for(&choice).is_some_and(|it| app.global_shortcut().is_registered(it));
    SummonSetting {
        choice,
        choices: SUMMON_CHOICES,
        active,
    }
}

#[tauri::command]
fn summon_shortcut(app: tauri::AppHandle) -> SummonSetting {
    summon_setting(&app)
}

/// Change the summon shortcut to one of the list, or turn it off.
#[tauri::command]
fn set_summon_shortcut(app: tauri::AppHandle, choice: String) -> Result<SummonSetting, String> {
    if !is_summon_choice(&choice) {
        return Err(format!("{choice:?} is not one of the summon shortcuts"));
    }
    match app.store(SETTINGS_FILE) {
        Ok(store) => {
            store.set(SUMMON_KEY, choice.as_str());
            if let Err(error) = store.save() {
                log::warn!("the shell's settings could not be written: {error}");
            }
        }
        Err(error) => log::warn!("the shell's settings could not be opened: {error}"),
    }
    apply_summon(&app, &choice);
    Ok(summon_setting(&app))
}

/// Hold a fetched update and tell the page, which shows the one quiet notice about it.
fn mark_update_ready(app: &tauri::AppHandle, ready: ReadyUpdate) {
    let version = ready.version.clone();
    if let Ok(mut held) = app.state::<ShellState>().update.lock() {
        held.replace(ready);
    }
    if let Err(error) = app.emit(UPDATE_READY_EVENT, &version) {
        log::warn!("the page could not be told about {version}: {error}");
    }
}

/// The version waiting for a restart, if there is one.
#[tauri::command]
fn update_ready(app: tauri::AppHandle) -> Option<String> {
    app.state::<ShellState>()
        .update
        .lock()
        .ok()
        .and_then(|held| held.as_ref().map(|ready| ready.version.clone()))
}

/// The update being held, taken out to be applied — or the refusal when there is none.
fn take_ready_update(held: &Mutex<Option<ReadyUpdate>>) -> Result<ReadyUpdate, String> {
    held.lock()
        .map_err(|_| "the update could not be read".to_string())?
        .take()
        .ok_or_else(|| "no update is waiting".to_string())
}

/// Restart into the update this shell fetched — and ONLY that.
///
/// The process plugin is still not granted to the page, and this is not a way round that: with no
/// verified update in hand it refuses, so a page running somebody else's script can at most restart
/// the app into the signed version the shell itself downloaded, which is what the person's own
/// press of 지금 다시 시작 would do. It is never called by anything but that press; the notice
/// withholds the button while the Bot is working, because the window drives the turn and a restart
/// would end it.
#[tauri::command]
fn restart_to_update(app: tauri::AppHandle) -> Result<(), String> {
    let ready = take_ready_update(&app.state::<ShellState>().update).inspect_err(|refusal| {
        log::warn!("a restart was asked for and refused: {refusal}");
    })?;
    log::info!("restarting into {}", ready.version);
    remember_origin(&app);
    #[cfg(all(windows, not(debug_assertions)))]
    {
        let (update, bytes) = &ready.installer;
        // Runs the installer and ends this process; the installer brings the new version up.
        update.install(bytes).map_err(|error| error.to_string())?;
    }
    app.restart()
}

/// A development build never asks the updater anything (see `install_updates`), so without this the
/// notice and its restart could only ever be seen in a release. `LAF_SHELL_PRETEND_UPDATE=<version>`
/// holds a pretend update after a few seconds — late enough that the page is already listening.
/// Absent from a release build, like `DEV_ORIGIN`.
#[cfg(debug_assertions)]
fn pretend_update(app: &tauri::AppHandle) {
    let Ok(version) = std::env::var("LAF_SHELL_PRETEND_UPDATE") else {
        return;
    };
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(8));
        log::info!("pretending update {version} is ready (development build)");
        mark_update_ready(&handle, ReadyUpdate { version });
    });
}

/// Fetch a newer version, if the release the endpoint points at is newer than this one, and hold it
/// for a restart.
///
/// Release builds only: a development launch has no business asking the endpoint, and the version
/// it would compare is whatever happens to be in the config. Failure is logged and nothing else — an
/// app that cannot reach its update endpoint is an app that still has to run.
///
/// NEVER A RESTART THE PERSON DID NOT ASK FOR. Restarting an app somebody is using, to deliver a
/// change they did not ask for, is the behaviour that teaches people to dread updates — and here it
/// would also end whatever the Bot was doing, because the window drives the turn. So the update is
/// fetched and verified, the page is told, and it shows one quiet notice with 지금 다시 시작. On
/// macOS it is also installed at once, so it applies on the next launch whether or not they press
/// it; on Windows installing IS exiting (see `ReadyUpdate`), so it waits for the press.
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
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                log::info!("no update available");
                return;
            }
            Err(error) => {
                log::warn!("update check failed: {error}");
                return;
            }
        };
        let version = update.version.clone();
        log::info!("update {version} is available; fetching");
        // `download` verifies the signature against the pubkey in `tauri.conf.json` before it
        // answers, so what is held below is already the signed release or nothing.
        let bytes = match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => bytes,
            Err(error) => {
                log::warn!("update {version} could not be fetched: {error}");
                return;
            }
        };
        #[cfg(windows)]
        {
            log::info!("update {version} fetched; it installs when the person restarts");
            mark_update_ready(
                &app,
                ReadyUpdate {
                    version,
                    installer: (update, bytes),
                },
            );
        }
        #[cfg(not(windows))]
        match update.install(bytes) {
            Ok(()) => {
                log::info!("update {version} installed; it applies on the next launch");
                mark_update_ready(&app, ReadyUpdate { version });
            }
            Err(error) => log::warn!("update {version} could not be installed: {error}"),
        }
    });
}

/// The icon in the menu bar, the two facts it states and the four things reachable from it.
///
/// KOREAN, IN THE SHELL. Everywhere else in this product the surface owns the words and the server
/// sends facts, but a tray menu is drawn by the operating system out of strings this process holds:
/// there is no page to ask. So these are written here, in the language the product leads in, the
/// same way `public/index.html` is — the Bot's status included, which the page sends as a code.
///
/// Each item is one of the things a window cannot do for itself once it has been put away: say
/// what the Bot is doing, come back, stop making noise, start with the machine, and end.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    /*
     * WHICH SHELL THIS IS, as the first line of the menu and as a fact rather than a button.
     *
     * macOS draws an "About LAF Agent" in the app menu on its own; Windows draws nothing, so until
     * this line a person on Windows had no way to read the version of the thing they had installed
     * — and the server's build, on the Settings footer, is only half of "what are you running".
     * `package_info()` is the version the bundler stamped from the release tag (release.yml), so it
     * is the same number the updater compares against. Disabled: there is nothing to do with it.
     */
    let info = app.package_info();
    let about = MenuItem::with_id(
        app,
        "about",
        format!("{} {}", info.name, info.version),
        false,
        None::<&str>,
    )?;
    /*
     * WHAT THE BOT IS DOING, under which shell this is. A fact rather than a button, like the line
     * above it, so a person can see "사장님 차례" without opening the window — which is the only
     * question most people open a tray menu to answer. It says 쉬는 중 until the page first
     * reports, and again whenever the window starts loading a page (`on_page_load` in `run`): a page
     * that is gone cannot still be saying the Bot is working.
     */
    let status = MenuItem::with_id(app, "status", BotStatus::Idle.words(), false, None::<&str>)?;
    if let Ok(mut line) = app.state::<ShellState>().status_line.lock() {
        line.replace(status.clone());
    }
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
            &about,
            &status,
            &PredefinedMenuItem::separator(app)?,
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
            // exists because closing the window no longer ends the process. Where the person was
            // is written down here while the window is certainly still there, rather than left to
            // the run loop's `Exit` to catch on the way past.
            "quit" => {
                remember_origin(app);
                app.exit(0);
            }
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
            post_notice,
            set_status,
            summon_shortcut,
            set_summon_shortcut,
            update_ready,
            restart_to_update
        ])
        /*
         * A PAGE THAT IS LOADING IS NOT A BOT THAT IS WORKING. The tray's status is whatever the page
         * last said, and a page that navigated away, reloaded or was replaced by the connection page
         * can no longer take it back — so every load starts the tray at rest, and the page that
         * arrives says otherwise if it has reason to.
         */
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                show_status(webview.app_handle(), BotStatus::Idle);
            }
        })
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
        /*
         * THE SUMMON SHORTCUT, held from Rust. No `global-shortcut:` permission is granted to the
         * page (`removeUnusedCommands` strips the plugin's commands from the build): the page names
         * one of `SUMMON_CHOICES` through `set_summon_shortcut` and this process registers it.
         * Pressed only — the release of the same keys would otherwise summon twice.
         */
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        log::info!("summoned by the shortcut");
                        present_where_the_notice_pointed(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let home = configured_origin(app.handle());
            let target = launch_origin(app.handle());
            log::info!("window origin: {target} (front door: {home})");
            if let Some(window) = app.get_webview_window("main") {
                // The window is declared with the front door as its URL and is already loading it.
                // A remembered deployment is one navigation away from that, done here rather than
                // by rebuilding the window in Rust — the window's shape lives in the two config
                // files and is checked by `tests/desktop-shell.test.ts`, and only its address moves.
                if target != home {
                    match tauri::Url::parse(&target) {
                        Ok(url) => {
                            if let Err(error) = window.navigate(url) {
                                log::error!("could not open the remembered deployment: {error}");
                            }
                        }
                        Err(error) => {
                            log::error!("the remembered deployment is not a URL: {error}")
                        }
                    }
                }
                // It is surfaced only once the webview exists, which avoids a white flash on launch
                // — and only after the origin answered, so what appears is the app or an
                // explanation, never a blank page.
                if !reachable(&target) {
                    log::warn!("origin unreachable, showing the connection page: {target}");
                    if let Err(error) =
                        window.navigate(connection_page(app.handle(), &target, &home))
                    {
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
                    /*
                     * WHERE THE WINDOW IS, NOTED EVERY TIME THE PERSON LOOKS AWAY.
                     *
                     * The obvious place to write this down is the way out, and the way out is not
                     * reliable: measured on macOS 15, quitting the app fires neither
                     * `ExitRequested` nor a `CloseRequested` — `shell.json` stayed `{}` across a
                     * whole session — and by `RunEvent::Exit` there may be no webview left to ask.
                     * Losing focus is the opposite: it happens constantly, always with the window
                     * alive, and it survives even a process that is killed rather than quit. The
                     * write is skipped when nothing changed, so the common case reads a cached
                     * store value and stops.
                     */
                    if let tauri::WindowEvent::Focused(false) = event {
                        remember_origin(&handle);
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        // Read before the window is hidden, while it can still say where it is.
                        remember_origin(&handle);
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
            apply_summon(app.handle(), &summon_choice(app.handle()));
            #[cfg(debug_assertions)]
            pretend_update(app.handle());
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
            /*
             * The last chance, and only that. Measured on macOS 15: the platform's own Quit
             * reaches `Exit` and nothing before it — no `ExitRequested`, no `CloseRequested` — so
             * without this line an app that was only ever quit remembered nothing at all. Whether
             * a webview is still there to answer is the platform's business; when it is not,
             * `origin()` falls back to what was already written and this is a no-op.
             */
            if let tauri::RunEvent::Exit = event {
                remember_origin(app);
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{
        connection_page_url, deep_link_url, fleet_origin, is_summon_choice, link_target,
        summon_shortcut_for, take_ready_update, web_url, with_dot, BotStatus, ReadyUpdate,
        SUMMON_CHOICES, SUMMON_DEFAULT, SUMMON_OFF,
    };
    use std::sync::Mutex;

    const ORIGIN: &str = "https://agent.laf-co.com";

    /// The tray says one of three things, and a page cannot make it say a fourth.
    #[test]
    fn the_tray_takes_three_codes_and_nothing_else() {
        assert_eq!(BotStatus::from_code("working"), Some(BotStatus::Working));
        assert_eq!(BotStatus::from_code("waiting"), Some(BotStatus::Waiting));
        assert_eq!(BotStatus::from_code("idle"), Some(BotStatus::Idle));
        for refused in ["Working", "idle ", "", "busy", "사장님 차례", "<b>idle</b>"] {
            assert_eq!(
                BotStatus::from_code(refused),
                None,
                "should refuse {refused:?}"
            );
        }
        // The words are the tray's own, and the person's turn is the only one with a dot of amber.
        assert_eq!(BotStatus::Waiting.words(), "사장님 차례");
        assert_eq!(BotStatus::Idle.dot(), None);
        assert_ne!(BotStatus::Waiting.dot(), BotStatus::Working.dot());
    }

    /// The page names a summon shortcut by id; only the list decides which keys that is.
    #[test]
    fn the_summon_shortcut_is_one_of_the_list_or_off() {
        assert!(SUMMON_CHOICES.contains(&SUMMON_DEFAULT));
        assert!(SUMMON_CHOICES.contains(&SUMMON_OFF));
        for choice in SUMMON_CHOICES {
            assert!(is_summon_choice(choice), "{choice} should be a choice");
            assert_eq!(summon_shortcut_for(choice).is_some(), choice != SUMMON_OFF);
        }
        // Every one of them has a modifier: a bare key taken system-wide is a key nobody can type.
        let keys: Vec<_> = SUMMON_CHOICES
            .iter()
            .filter_map(|choice| summon_shortcut_for(choice))
            .collect();
        for key in &keys {
            assert!(!key.mods.is_empty(), "{key:?} has no modifier");
        }
        let mut ids: Vec<_> = keys.iter().map(|key| key.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), keys.len(), "two choices name the same keys");
        for refused in ["ctrl+c", "Control+Alt+L", "super+space", "", "OFF"] {
            assert!(!is_summon_choice(refused), "should refuse {refused:?}");
        }
    }

    /// No update in hand, no restart: the one thing that stops `restart_to_update` being a way for
    /// a page to restart the app whenever it likes. (A Windows release build holds the installer as
    /// well, which a test has no signed update to make one of.)
    #[cfg(not(all(windows, not(debug_assertions))))]
    #[test]
    fn a_restart_is_refused_without_an_update_in_hand() {
        let held = Mutex::new(None);
        assert!(take_ready_update(&held).is_err());
        held.lock().unwrap().replace(ReadyUpdate {
            version: "9.9.9".to_string(),
        });
        assert_eq!(
            take_ready_update(&held)
                .map(|ready| ready.version)
                .as_deref(),
            Ok("9.9.9")
        );
        // Taken, not copied: a second press has nothing to restart into.
        assert!(take_ready_update(&held).is_err());
    }

    #[test]
    fn the_status_dot_sits_in_the_corner_and_leaves_the_rest_alone() {
        let (width, height) = (40, 40);
        let icon = vec![10u8; (width * height * 4) as usize];
        let dotted = with_dot(&icon, width, height, [1, 2, 3]);
        assert_eq!(dotted.len(), icon.len());
        let pixel = |x: u32, y: u32| {
            let at = ((y * width + x) * 4) as usize;
            dotted[at..at + 4].to_vec()
        };
        assert_eq!(pixel(0, 0), vec![10, 10, 10, 10]);
        assert_eq!(pixel(width / 2, height / 2), vec![10, 10, 10, 10]);
        // The dot's centre is a ring's width in from the corner.
        assert_eq!(pixel(width - 11, height - 11), vec![1, 2, 3, 255]);
        // A buffer that is not the size it claims is handed back untouched.
        assert_eq!(
            with_dot(&icon[..10], width, height, [1, 2, 3]),
            icon[..10].to_vec()
        );
    }

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
                format!(
                    "https://agent.laf-co.com/settings/connected-accounts?connected={expected}"
                )
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
        let page = connection_page_url(
            "tauri://localhost/index.html",
            "http://localhost:3010",
            "http://localhost:3010",
        );
        assert!(page.starts_with("tauri://localhost/index.html?origin="));
        // Encoded, so the page reads back exactly the address the shell was pointed at.
        assert!(page.contains("http%3A%2F%2Flocalhost%3A3010"));
        // The front door is the same address here, so there is no second one to offer.
        assert!(!page.contains("home="));
    }

    /// A remembered deployment that never answers again must not be a window with no way out.
    ///
    /// The front door is where somebody is told their new address, and from inside a page that is
    /// retrying a dead host it is otherwise unreachable — there is no address bar in this window.
    #[test]
    fn the_connection_page_offers_the_front_door_when_it_is_somewhere_else() {
        let page = connection_page_url(
            "tauri://localhost/index.html",
            "https://gone.agent.laf-co.com",
            ORIGIN,
        );
        assert!(page.contains("home=https%3A%2F%2Fagent.laf-co.com"));
    }

    /// Every origin this shell will open, and it has to be inside what the capability grants.
    ///
    /// A window pointed anywhere else loads and runs, and the badge, the notices and the links out
    /// are refused with no error anywhere — the failure this whole file is arranged around. The
    /// refusals below are each a way a suffix check would have said yes.
    #[test]
    fn only_the_fleet_can_be_opened() {
        for (candidate, expected) in [
            (ORIGIN, "https://agent.laf-co.com"),
            // Serialised as a bare origin, whatever shape it arrived in: this is compared against
            // what the window reports and against what was written down.
            ("https://agent.laf-co.com/", "https://agent.laf-co.com"),
            (
                "https://mystore.agent.laf-co.com/channel/7?x=1#y",
                "https://mystore.agent.laf-co.com",
            ),
        ] {
            assert_eq!(
                fleet_origin(candidate).as_deref(),
                Some(expected),
                "should open {candidate}"
            );
        }
        for refused in [
            // Ends with the domain without being under it.
            "https://evil-agent.laf-co.com",
            // Has the domain in front of one somebody else owns.
            "https://agent.laf-co.com.evil.example",
            // Two names deep, where the grant carries one `*`.
            "https://a.b.agent.laf-co.com",
            // The grant names no port and no other scheme.
            "https://mystore.agent.laf-co.com:8443",
            "http://mystore.agent.laf-co.com",
            // The development server is one address, not a host.
            "http://localhost:3011",
            "http://localhost",
            // The shell's own page, which is not a place to be sent back to.
            "tauri://localhost/index.html",
            "file:///etc/passwd",
            "not a url at all",
            "",
        ] {
            assert!(fleet_origin(refused).is_none(), "should refuse {refused}");
        }
    }

    /// A release build opens nothing on the person's own machine; a development build opens the
    /// development server, and only that one address.
    ///
    /// Asserted per profile because the same line is right in one and a hole in the other:
    /// `cargo test` checks the development answer, `cargo test --release` the one people install.
    #[test]
    fn the_development_server_is_opened_only_by_a_development_build() {
        let opened = fleet_origin("http://localhost:3010/approve/a");
        if cfg!(debug_assertions) {
            assert_eq!(opened.as_deref(), Some("http://localhost:3010"));
        } else {
            assert!(
                opened.is_none(),
                "a release build opened the development server"
            );
        }
    }
}
