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

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

/// How long launch will wait to find out whether the origin is there.
///
/// Both halves of the probe are bounded by it, and it is deliberately short: this is time the person
/// spends looking at a dock icon and nothing else.
const PROBE_BUDGET: Duration = Duration::from_millis(1200);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_badge, open_external])
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
            #[cfg(not(debug_assertions))]
            install_updates(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::{connection_page_url, web_url};

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
