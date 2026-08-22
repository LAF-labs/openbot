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
//! address exists it is one value in `tauri.conf.json`, and the same value is what a phone will use.
//!
//! The one page the shell serves itself is the connection page: an app whose whole UI lives on a
//! server has exactly one failure it must explain on its own, and that is not reaching the server.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::Manager;

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
/// its own page. Each address gets a short timeout; a refused local port fails instantly.
fn reachable(origin: &str) -> bool {
    let Ok(url) = tauri::Url::parse(origin) else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .take(3)
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(1500)).is_ok())
}

/// The shell's own connection page, with the origin for it to keep probing. A webview that cannot
/// load its page explains nothing — WKWebView stays blank, WebView2 shows its own error — so the
/// window is sent here instead, and the page navigates to the origin the moment it answers.
fn connection_page(app: &tauri::AppHandle, origin: &str) -> tauri::Url {
    let mut url = match &app.config().build.dev_url {
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
    url.query_pairs_mut().append_pair("origin", origin);
    url
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_badge])
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
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
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}
