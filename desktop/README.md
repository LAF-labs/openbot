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

Since 2026-10-05, two that READ the machine rather than draw on it:
**`device_place_permission`** and **`device_place`** — whether the device may
be asked where it is, and where it is to two decimals of a degree. They have a
section of their own below ("The device's place").

**The shell's own commands — `set_badge`, `open_external`, `post_notice` and
the seven above — are declared twice, and both declarations are
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
the page shows one quiet control, 다시 시작해서 업데이트, at the foot of the Bot's
column (a card in the corner, 새 버전이 준비됐어요 with 지금 다시 시작, until
2026-10-06 — the same control now also says when the page itself is behind the
server), withheld
while the Bot is working or waiting on the person. That rule was made while the
window drove the Bot's turn and a restart ended it; the server runs the turn now
and it goes on through a restart, and the rule was kept — a restart still takes
the answer off the screen somebody is watching it arrive on. So a page running
somebody else's script cannot make
this process install software, restart itself into anything but the signed
update it already holds, take a key combination from the rest of the machine,
or hand an arbitrary scheme to the operating system.

**On Windows the update waits for that press, and until 2026-09-26 it did not.**
The updater's Windows `install()` launches the NSIS installer and then calls
`std::process::exit(0)` (tauri-plugin-updater 2.10.1, `updater.rs`), so the
`download_and_install` the shell ran at launch ended the app a minute after
somebody opened it whenever there was an update. Now Windows downloads and
verifies at launch and installs only on that press; macOS installs at once
(`install()` there replaces the bundle and the process runs on), so it applies
on the next launch whether or not the person presses anything. A development
build never checks; `LAF_SHELL_PRETEND_UPDATE=<version>` makes it hold a pretend
update so the card and the restart can be seen outside a release.

### Downloads, and what the page is told about them

A webview saves a file and draws nothing. Measured in a debug bundle on macOS
26.6, 2026-10-02 — the presses made by a script in the page, since nothing
outside the window can press it, and read back from the folder, the system log
and the page:

- **A link with `download` saves.** wry lets every download through by default
  (`download_started_handler: Some(|_, _| true)`, 0.55.1) and chooses the place:
  the Downloads folder, `name (1).ext` rather than writing over a file. Three
  presses of a file card's 내려받기 made `news.csv`, `news (1).csv` and
  `news (2).csv`, each within the second and each quarantined by WebKit — and
  the screen did not change after any of them, which is what makes a person
  press again to find out.
- **A link without `download` is DRAWN, whatever the server says.** The webview
  does not read `Content-Disposition: attachment`; it asks only whether it can
  show the type. 설정 → 내 데이터 → 내려받기 answered JSON, so the press replaced
  the whole app with the export as text — in a window with no back button — and
  saved nothing (system log: `policyAction=Use`, then `didCommitLoadForFrame`
  on the main frame). That link carries `download` now, and any new link that
  is a save needs it too.
- **The first download asks.** macOS shows its own question about the Downloads
  folder (`kTCCServiceSystemPolicyDownloadsFolder`), once per app, with the
  reason from `NSDownloadsFolderUsageDescription` in `src-tauri/Info.plist`.
  This process waits on the answer: three minutes passed between one press and
  its file, which was three minutes of an unanswered question, and a navigation
  asked for meanwhile waited with it.

So the shell hears each download end and tells the page (`note_download` →
the `download-ended` event → `DownloadNotice`): 다운로드 폴더에 저장했어요 with
the name the file was saved under, or that it was not saved and what to check.
Measured the same way: the press, `a download ended: saved=true` in the shell's
log within the second, the file in the folder, and the line on screen — read at
one and two seconds, gone by eleven; it holds for six. A handler is a closure and can only be given to a window still being
built, so both configs mark the window `create: false` and `build_window` builds
it from the config with the call Tauri would have made. No command and no
capability were added: the page only listens, which `core:default` already
allows. Unmeasured on Windows, where WebView2 hands the handler the finished
path itself.

### The device's place

The owner's order (2026-10-05): the place a person said, else where their
device really is, else Seoul. A browser tab reads the device through
`navigator.geolocation`. This window cannot — its webview answers no
geolocation request, and Tauri's own geolocation plugin is for phones — so the
surface this product leads with was the one that fell straight to Seoul. The
shell reads the device itself now, on macOS, through CoreLocation
(`src-tauri/src/location.rs`), and offers the page two commands:

- **`device_place_permission`** → `"granted" | "prompt" | "denied" |
  "restricted" | "unsupported"`. Reads one property. Shows nothing and reads no
  location. `prompt` is "not decided": asking would put the system's question
  up. `restricted` is a machine whose person may not decide; `unsupported` is a
  platform that is not read — Windows.
- **`device_place({ prompt })`** → `{ kind: "place", latitude, longitude,
  accuracy }`, or `{ kind }` with one of `denied`, `restricted`,
  `undetermined_no_prompt`, `unanswered`, `unavailable`, `timeout`,
  `unsupported`. With `prompt: true` a device that has not decided shows the
  system's own question and the call waits for the answer, for a minute; with
  `prompt: false` nothing is ever shown — allowed is read, and not-decided
  answers `undetermined_no_prompt`. `accuracy` is how far off the device says
  the fix may be, in whole metres: a radius, not a position.

Both are read-only and take nothing a page could choose but that one boolean.
What crosses is a kind and three numbers, never words: the page owns the
sentences.

**What a script on the origin gets from them, said plainly.** A page running
somebody else's script can call both as the app does. It can put the system's
own question in front of the person, as often as the system will show it; and
on a device that has said yes it can read where that device is, to two
decimals, whenever it likes — whether or not the account keeps a place. It
gets nothing finer, and nothing from a device that said no.

**Still no product logic.** The shell reads and rounds. Whether to ask, when,
how often and what the answer is for are the page's, in the same table a
browser tab goes through (`app/src/lib/whereabouts/device-place.ts`): asked
until the person has decided, after they have agreed to the terms; read again
with nothing shown each time the page is looked at, at most once an hour, so
the place follows the device; kept only when the fix is good to three
kilometres and has moved two hundredths of a degree; never while the person
has said where they are, and never again by itself once they cleared it there.

What the shell does hold to, because only it can:

- **Two decimals, rounded before the value exists.** A fix is rounded in the
  delegate callback that receives it, so there is no finer value in this
  process for a later mistake to hand over; the page rounds again on its side.
  `DevicePlace` prints as its kind alone — a derived `Debug` would have put
  coordinates in the first log line anybody wrote with `{:?}`, and the log is
  a file on somebody's disk.
- **Nothing stored.** Not on disk and not in memory. A second question within
  the hour is answered from the fix CoreLocation itself still holds
  (`CLLocationManager.location`, by its timestamp) — the browser's
  `maximumAge` — so within one run of the app the device is asked for a new fix
  at most once an hour however often the page asks. The manager is this
  process's, so each launch may cost one fix of its own.
- **A kilometre.** `desiredAccuracy` is `kCLLocationAccuracyKilometer`: the
  coarsest fix that still names the town, and the cheapest to find.
- **Nobody waits for ever.** Both things asked of the system can simply never
  answer, so each has a bound, and a bound that passes is a kind of its own.
  The device has **ten seconds**, counted from the fix being asked for — the
  browser's `timeout` — and then the answer is `timeout`. The person has **a
  minute**, and then the answer is `unanswered`. That second bound did not
  exist until the review of pull request 94: CoreLocation shows its question
  only for an app that is in use and says nothing when it does not, so no
  callback ever came, the page's one ask hung, and a press of the button on 내
  정보 joined the same wait and sat at 찾는 중… until the app was quit. A minute
  because the dialog is one sentence and two buttons, and because a late answer
  is not lost: the system keeps it, and the next time the page looks the device
  is simply allowed and is read with nothing shown. `unanswered` is not a
  refusal — the person may never have seen the question — so the page spends
  nothing on it and may ask again. When the bound passes the shell looks at
  what the system holds NOW rather than assuming: a callback that was missed is
  as possible as a dialog that never appeared.
- **Never on the window's thread, always on the main one.** CoreLocation's
  manager calls back on the run loop of the thread that made it, so the one
  manager this process makes lives on the main thread and is never let go of —
  a manager per question would have to be freed inside its own callback. The
  commands are `async`: they hop there with `run_on_main_thread`, and wait for
  the answer on the runtime's threads. Everybody who asks while a question is
  open joins it and is given the one answer.

**Two declarations outside the code decide whether any of it works, and both
fail without a word.** `Info.plist` carries the reason macOS shows under its
question — `NSLocationWhenInUseUsageDescription`, the key the systems this
bundle opens on read, and the older `NSLocationUsageDescription` with the same
sentence. With no string the system refuses the request and asks nobody. The
sentence says what is read, how coarsely and what for, and names no 사장님 and
no 가게: 봇이 날씨나 가까운 곳을 찾을 때 기준으로 삼도록, 이 기기의 위치를 약
1km 단위로만 읽어 저장합니다. And `Entitlements.plist` carries
`com.apple.security.personal-information.location`, named in
`bundle.macOS.entitlements`: under the hardened runtime CoreLocation is refused
to a process without it. **That file is not read by any build today** — see
Releasing: with no Apple secrets the bundler never runs `codesign`, so there is
no hardened runtime and nothing to be entitled to. It is there so that the day
Developer ID signing is switched on, the same commit can still read the
device. `tests/desktop-shell.test.ts` holds all three.

**A development build says what the system holds, when asked to.**
`LAF_SHELL_DEVICE_STATUS` in its environment (any value; `open -g --env
LAF_SHELL_DEVICE_STATUS=1 "<bundle>"`) makes it log two lines at launch:
whether the device may be asked, and what a read that must show nothing
answers. It looks and reads with `prompt: false`, so it never shows anybody
anything, and of a read the log holds the kind and never the place. It exists
because nothing outside the page can call a command.

**Measured 2026-10-05 and -06**, macOS 26.6.2, debug bundles built as under
Running and started with `open -g`, **no dialog shown and none answered**:

- With that switch: `this device may be asked where it is: Prompt`, then `the
  page asked where this device is: permission=Prompt prompt=false` and `asked
  where it is with nothing shown, this device answers:
  undetermined_no_prompt`. No warning and no error in the shell's log.
- The system log, for the same second: `setDesiredAccuracy: 1000.000000`,
  `setDelegate:`, `CLInternalGetAuthorizationStatus`, and CoreLocation
  `invoking #delegate … locationManagerDidChangeAuthorization:` with
  `authorizationStatus: NotDetermined` — the callback that comes with setting
  a delegate, which the shell must not read as an answer and does not.
  `locationd` keyed the client by its bundle identifier
  (`icom.lafco.lafagent.dev`) and logged `Client will now show up in
  settings`: making the manager is enough to put the app on the Location
  Services list, before anybody has been asked. Nothing asked for
  authorization or for a fix.
- The bundle: both usage strings in `Contents/Info.plist`; CoreLocation linked;
  `codesign -dvvv` → `flags=0x20002(adhoc,linker-signed)`, `Info.plist=not
  bound`, `Sealed Resources=none`, no entitlements — the bundler signed
  nothing, as its source says.
- **What the page is told when the window is put away and brought back, with
  the screen LOCKED** (a temporary line in the shell hid the window as closing
  does, called `present()`, twice, and had the page report every
  `visibilitychange`, `focus`, `blur` and the shell's own `tauri://focus`): the
  page was alive, said `visibilityState=hidden hasFocus=false` throughout, and
  was told nothing at all — no event of any kind. So a page behind a lock is
  not a page being looked at, and nothing is read for it. With the screen
  unlocked it was not measured; see below.
- The half that every other platform compiles was compiled once on this Mac
  with its condition flipped: no error and no warning. Not built on Windows.

**Measured 2026-10-06 with the owner at the screen**, on a debug bundle of
this shell — its code has not changed since — with the page served at
`localhost:3010`:

- The press of 이 기기 위치 쓰기 put the system's question up, and it was
  allowed. The log read `the page asked where this device is:
  permission=Prompt prompt=true`, `asking the person whether this device may be
  read`, and two seconds later `this device answered: place`.
- With the words taken off the account and the app opened again, the device
  was read by itself with nothing shown (`permission=Granted`) and its place
  was saved — so the fix said it was good to three kilometres — and the place
  was the right one.
- **And the person could not tell that any of it had worked.** The form drew
  the answer as two numbers under a box that still held the place typed
  before, and saved nothing until a second button was pressed; they pressed
  seven more times and asked whether the place in the box was the server's.
  That was the page's to fix and is fixed there, not here: one press reads
  and saves, the device's place is drawn by a name the server reads from
  기상청's table and never by a number, and one sentence says which of the
  words, the device or Seoul is in use
  (`app/src/components/shop/shop-location.tsx`). The shell's answer is what it
  was.

**Still not measured, because each needs a person at the screen:** the
question's wording as the system draws it; a refusal; both bounds; that a
second question within the hour is answered from `CLLocationManager.location`
(read from Apple's documentation); anything at all under the hardened runtime,
which no build has; and **that bringing the window back from the tray with the
screen unlocked tells the page so**. That last is read, not measured: the page
listens for `visibilitychange` and the window's `focus`, the same two the
socket has listened to for "looked at again" since before this
(`app/src/lib/channels/use-channel-events.ts`); and a notice about the
conversation on screen is withheld wherever the page says it is visible
(`decideNotice`), while this shell was measured posting notices with its
window in the tray (2026-09-26, above) — which is the page saying, there, that
it was not. Whoever next has the development app open with this change served
at `localhost:3010` (1 to 3, allowed, are what was measured above):

1. An account with no place at all is asked when the window is first looked
   at; one that holds words, or coordinates, is not — by the table — and is
   asked by the press of 설정 → 내 정보 → 위치 → 이 기기 위치 쓰기. That the
   button is drawn at all is the first proof: it is drawn only when the shell
   has answered `device_place_permission`.
2. The system's question appears with the sentence above under it. The log
   reads `the page asked where this device is: permission=Prompt prompt=true`
   and `asking the person whether this device may be read`.
3. Allowed: `this device answered: place`, and the press has saved it — the
   box is empty, the screen says 이 기기 위치: with the place's name and 부근
   and no number anywhere, and 저장됨. Refused: `this device answered: denied`,
   and the screen says so in words with nothing changed. Left alone for a
   minute: `this device answered: unanswered`, the button comes back with a
   sentence saying the question was not answered, and pressing again asks
   again.
4. With coordinates saved and no words, close the window to the tray and
   bring it back: the first time, `permission=Granted prompt=false` and `this
   device answered: place`, and no write unless the device is two hundredths
   of a degree from what is saved. Do it again within the hour and the log
   says nothing — the page did not ask.
5. 위치 지우기, then the tray and back: nothing about the device in the log,
   now or an hour on.

If no question appears at 2, read what `locationd` said about the app
(`log show --last 2m --predicate 'process == "locationd" AND eventMessage
CONTAINS "lafagent"'`): at the dry run it logged that Launch Services knew the
client "as a plugin or app" under neither name, and then that it "will now
show up in settings" — for a bundle run from under `target/`. A bundle the
system cannot name may not be asked about; `lsregister -f` on the bundle, or a
copy in `~/Applications`, is the thing to try. The button comes back after a
minute either way.

**Windows answers `unsupported`**, and the page there is what it was: Seoul,
or the place the person says. Reading it would be WinRT's
`Windows.Devices.Geolocation.Geolocator` — `RequestAccessAsync`, then
`GetGeopositionAsync` with a coarse `DesiredAccuracyInMeters` — through the
`windows` crate that is already in the tree for WebView2, with its
`Devices_Geolocation` feature turned on; the same closed result, rounded the
same way. It is not written because nothing here can run it: an unpackaged
desktop app is asked about differently from a packaged one, and differently
again from Windows 11 24H2, and code that reads somebody's location is not
code to ship unmeasured.

**What it cost.** One crate newly compiled, `objc2-core-location` 0.3.2 with
four of its features — already in the lockfile for iOS by way of
`objc2-ui-kit`, so the lockfile gained three lines and no package. `objc2` and
`objc2-foundation` are named as direct dependencies and were compiled already.
Measured: the first `cargo check` after the change took 6.7 s, and the debug
binary is 0.56 MB larger than the last one built on this Mac from main, two
days earlier (37.26 → 37.83 MB, unstripped, and not all of the difference is
this change). A release binary was not built.

### A file dropped on the window is the page's

`dragDropEnabled` is `false` in both configs. Tauri's own file-drop handler is
on unless a config turns it off, and where it is on the page never hears a
drop: tauri-runtime-wry 2.11.4 installs a wry handler that answers `true` to
every drag event, and wry 0.55.1's `performDragOperation:` then returns YES
without handing the drop to WebKit (`wkwebview/drag_drop.rs`), so no `drop`
reaches the DOM. What Tauri offers instead is the file's PATH, through an event
of its own — which this page, a remote origin with no file-system grant, could
do nothing with. The composer takes files the way a web page does, and since
2026-10-02 takes them wherever in the window they are let go
(`composer.tsx`, on the document), with the app refusing any file nothing took
so that no screen is replaced by one (`lib/stray-drop.ts`).

**Read from the two libraries' source, not measured.** A drop needs a hand on
the pointer, and nothing in this repository's tooling can make one in a native
window. The page's half is measured — in Chromium, a file let go over the
transcript is attached, and the cue is drawn while it is held. Whoever next
has the app open: drag a spreadsheet onto the conversation and see the chip.

## Awake when the window is not

Closing the window used to end the process, which meant "a Bot is waiting for
you" could only be said by a page already on screen — the one moment nobody
needs telling. So:

- **A tray icon**, with 열기 / 알림 받기 / 로그인할 때 자동 실행 / 종료. Its
  strings are Korean and live in `lib.rs`, because a tray menu is drawn by the
  operating system out of strings this process holds: there is no page to ask.
- **The Bot's status in the tray**: 일하는 중 / 내 차례 / 쉬는 중, as a line
  under the version, in the tooltip, and on the icon itself in the way each
  platform has. The page derives it — the same answer as the pill under the
  Bot's face (`app/src/lib/agents/presence.ts`) — and sends one of three codes;
  the words stay here for the reason above, and a page cannot put text of its
  own into a native menu. Every page load starts it at 쉬는 중, so a page that
  went away cannot leave it saying the Bot is busy. The three are the app's own
  words (`Busy working`, `Your turn`, `Ready` in its dictionary) and a test
  holds them to it: the person's turn read 사장님 차례 here until 2026-10-03, to
  everybody, whoever they had said they were.
- **On the icon, Windows paints and macOS writes.** On Windows the status is a
  dot on the window's icon (amber for the person's turn, green while working,
  none at rest). On macOS that icon — a full-bleed white square — was a white
  tile on a dark menu bar, so since 2026-10-03 the tray there is a template
  image (`icons/tray-template.png`, exported from the `.svg` beside it): one
  colour, the menu bar's own, light or dark. A template cannot hold a coloured
  dot, so the one state that needs the person is said in words — the tray's
  title reads 내 차례 beside the icon while the Bot waits on the person, and
  nothing otherwise; working and resting stay in the menu and the tooltip.
  **Looked at in a real menu bar on 2026-10-03** (the development build, a dark
  bar, a Retina display): the mark is drawn in the bar's white, 내 차례 appears
  beside it when a question is raised and goes when it is answered. Three
  things about tray-icon 0.24.2 shaped the code, each read in its source and
  the first also measured: it draws every icon 18 pt tall whatever its pixels —
  the drawing's 22 pt box came out with a 12 pt mark beside neighbours of 16,
  so the picture is 36 px, the margin left off, and the mark is 15–16 pt; its
  `set_icon` drops the template flag, so the status never sets the icon again
  on macOS; and its `set_title(None)` does nothing there, so "no title" is sent
  as an empty one. Not looked at: a light menu bar, a display that is not
  Retina.
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
  12.3, so on macOS 12 and 13 the gap remains and was not measured here. WebView2
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

## The oldest system it opens on

`bundle.macOS.minimumSystemVersion` is **12.3**, and that is not where the app
runs from. The window's engine is the system's WebKit, and the page needs one
that builds a pattern with a look-behind — Safari 16.4, which macOS has from
13.3. On an older engine the page draws a sentence that says what to update in
place of the app (`app/src/lib/engine-floor.ts`), instead of a conversation
that falls over the moment it holds a Bot's reply, which is what the app did
there before it asked.

12.3 is the oldest system on which that sentence is known to be drawn, as far
as it could be measured without one: a production build, in an engine with the
look-behind and the 74 APIs newer than Safari 15.4 taken away before the page's
scripts ran, read the entry and drew it, and asked the server for nothing. The
same build with only what is newer than 16.4 taken away (50 APIs, and the `v`
flag) ran a whole turn — a reply with an e-mail address made a link, a table,
and the line a screen reader is given. Not measured: a real Safari of either
age, and whether updating Safari alone on macOS 12 moves the engine a webview
gets.

The floor was 12.0 until then. Raising it to 13.3 was the other choice, and
the owner's decision was this one: a Mac that stays on 12 is told by the app
what to update.

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

It also gives a development launch an identity of its own —
`com.lafco.lafagent.dev`, "LAF Agent Dev" — so its settings, its log and its
single-instance lock are not the installed app's. Until 2026-10-02 it had none,
and on a machine with both a development launch wrote its `localhost:3010` into
the installed app's `shell.json` (measured). To drive a development build with
something that addresses apps by bundle, make one:
`./node_modules/.bin/tauri build --debug --bundles app --config
src-tauri/tauri.dev.conf.json --config
'{"bundle":{"createUpdaterArtifacts":false}}'` — a debug bundle keeps
`debug_assertions`, so it still opens the development server. (Not `bunx
tauri`: outside this workspace that name resolves to an unrelated npm package.)

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

**What "ad-hoc signed" is, exactly** (read in tauri-bundler 2.11.4 and measured
on a bundle, 2026-10-05): with no `APPLE_CERTIFICATE` and no signing identity
the bundler does not run `codesign` at all. What the binary carries is the
linker's own ad-hoc signature — `flags=0x20002(adhoc,linker-signed)`,
`Info.plist=not bound`, no sealed resources, no entitlements, and no hardened
runtime. The day the six Apple secrets are set, the bundler signs with
`--options runtime` (`bundle.macOS.hardenedRuntime` defaults to true) and hands
`codesign` the file `bundle.macOS.entitlements` names. That file exists for
that day: under the hardened runtime the shell cannot read the device's
location without the entitlement in it ("The device's place"). Nobody has run
that build; the first one should be opened and asked where it is before it is
called a release.
