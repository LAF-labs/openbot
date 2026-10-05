//! Where this device is, for the page that asks: the one thing in this shell that reads the machine.
//!
//! THE ORDER IS THE OWNER'S (2026-10-05): the place a person said, else where their device really
//! is, else Seoul. A browser tab reads the device through `navigator.geolocation`, and this window
//! cannot — its webview answers no geolocation request — so the installed app, the surface this
//! product leads with, was the one that fell straight to Seoul. Tauri's own geolocation plugin is
//! for phones. So the device is read here, through CoreLocation, on macOS; everywhere else the
//! answer is `unsupported` and the page does what it did before.
//!
//! STILL NO PRODUCT LOGIC. This reads the device and rounds, and that is all of it: whether to ask,
//! when, how often and what to do with the answer are the page's
//! (`app/src/lib/whereabouts/device-place.ts`), the same table a browser tab goes through. Nothing
//! is written down here, on disk or in memory — the fix CoreLocation itself still holds is the only
//! thing a second question within the hour is answered from, and it holds one only once this run
//! of the app has found one.
//!
//! NEVER FINER THAN TWO DECIMALS, AND NEVER LOGGED. A fix is rounded in the callback that receives
//! it, before it is a value anything else can hold, so the page cannot be handed a finer one by a
//! mistake further on; and `DevicePlace` prints as its kind alone, so no log line written here or
//! later can carry where somebody is.

#[cfg(not(target_os = "macos"))]
use tauri::async_runtime::Sender;

/// What the page is told when it asks where this device is: a place, or the one reason for none.
///
/// A CLOSED LIST, AND FACTS ONLY. The page owns the words — "이 기기에서 위치 사용을 허락하지
/// 않았어요" is its sentence, not this process's — so what crosses is a kind the page can switch on,
/// the same way the tray takes one of three codes rather than text.
#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
// Everything but `Unsupported` is made by the half of this file that only macOS compiles.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum DevicePlace {
    /// Degrees at two decimals, about a kilometre: which town, never which door.
    Place { latitude: f64, longitude: f64 },
    /// The person said no — or Location Services is off for the whole machine, which the system
    /// reports as the same thing.
    Denied,
    /// The machine is not the person's to decide for: a profile or a parental control forbids it.
    Restricted,
    /// Nobody has been asked yet, and this call was told not to ask.
    UndeterminedNoPrompt,
    /// Allowed, and the device could not say where it is.
    Unavailable,
    /// Allowed, and the device did not say within `READ_BOUND`.
    Timeout,
    /// This platform is not read at all.
    Unsupported,
}

impl DevicePlace {
    /// The kind, as the page reads it — and all of this value that is ever printed.
    fn kind(self) -> &'static str {
        match self {
            Self::Place { .. } => "place",
            Self::Denied => "denied",
            Self::Restricted => "restricted",
            Self::UndeterminedNoPrompt => "undetermined_no_prompt",
            Self::Unavailable => "unavailable",
            Self::Timeout => "timeout",
            Self::Unsupported => "unsupported",
        }
    }
}

/// THE COORDINATES ARE LEFT OUT ON PURPOSE. A derived `Debug` would put them in the first log line
/// anybody wrote with `{:?}`, and the log is a file on somebody's disk.
impl std::fmt::Debug for DevicePlace {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.kind())
    }
}

/// Whether this device may be asked where it is, as the system holds it right now.
///
/// The browser's own three words where they mean the same thing (`navigator.permissions`), so the
/// page's one table reads both surfaces alike, and two the browser has no word for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum DevicePermission {
    Granted,
    /// Not decided: asking would put the system's own question in front of the person.
    Prompt,
    Denied,
    Restricted,
    /// Said only where the device is not read at all, which is everywhere but macOS.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
}

#[cfg(any(target_os = "macos", test))]
impl DevicePermission {
    /// `CLAuthorizationStatus`, by its number: 0 not determined, 1 restricted, 2 denied, 3 always,
    /// 4 when in use. A test holds these to the framework's own names.
    ///
    /// A NUMBER THIS BUILD DOES NOT KNOW IS NOT A YES. Whatever a later system adds, the answer
    /// here is the one that reads nothing and asks nothing.
    fn of_status(status: i32) -> Self {
        match status {
            0 => Self::Prompt,
            1 => Self::Restricted,
            3 | 4 => Self::Granted,
            _ => Self::Denied,
        }
    }
}

/// How long the device has to answer once it has been asked for a fix.
///
/// The browser's `timeout`, and counted the way the browser counts it: from the moment the device
/// is asked, not from the moment the PERSON is — somebody reading the system's question for half a
/// minute has not made their device slow.
#[cfg(target_os = "macos")]
const READ_BOUND: std::time::Duration = std::time::Duration::from_secs(10);

/// How old a fix CoreLocation already holds may be and still be the answer, in seconds.
///
/// The browser's `maximumAge` (`readDeviceCoordinates` passes an hour), and what bounds this shell
/// to asking the device for a new fix at most once an hour however often the page asks — within
/// one run of the app. The manager is this process's, so a launch starts with no fix of its own:
/// one fix a launch, and one an hour after it. (Whether a new manager is handed the system's last
/// fix is not something this was measured for; nothing depends on it.)
#[cfg(any(target_os = "macos", test))]
const MAXIMUM_AGE_SECONDS: f64 = 3600.0;

/// A degree at the only precision that ever leaves this process: two decimals.
#[cfg(any(target_os = "macos", test))]
fn coarse(degrees: f64) -> f64 {
    (degrees * 100.0).round() / 100.0
}

/// A fix as CoreLocation reported it, coarsened — or `Unavailable` when it is not a place.
///
/// CoreLocation marks a fix it cannot stand behind with a negative accuracy, and the range is
/// checked as the page checks it (`coarseCoordinates`, shared/whereabouts.ts): the server refuses
/// anything off the planet, and an answer it would refuse is not worth handing over.
#[cfg(any(target_os = "macos", test))]
fn coarse_place(latitude: f64, longitude: f64, accuracy: f64) -> DevicePlace {
    let is_a_place = accuracy >= 0.0
        && latitude.is_finite()
        && longitude.is_finite()
        && latitude.abs() <= 90.0
        && longitude.abs() <= 180.0;
    if !is_a_place {
        return DevicePlace::Unavailable;
    }
    DevicePlace::Place {
        latitude: coarse(latitude),
        longitude: coarse(longitude),
    }
}

/// Whether a fix that old is still the answer. A fix dated in the future is not: a clock that
/// moved is not a reason to trust it.
#[cfg(any(target_os = "macos", test))]
fn is_recent(age_seconds: f64) -> bool {
    (0.0..=MAXIMUM_AGE_SECONDS).contains(&age_seconds)
}

/// What a `CLError` code means to the page. 1 is `kCLErrorDenied`; everything else — no fix, no
/// network — is a device that could not say.
#[cfg(any(target_os = "macos", test))]
fn failure(code: isize) -> DevicePlace {
    if code == 1 {
        DevicePlace::Denied
    } else {
        DevicePlace::Unavailable
    }
}

/// What a question about the device's place does first, given what the system says about asking.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
enum Step {
    /// Nothing is read and nobody is asked: this is the answer.
    Answer(DevicePlace),
    /// The system's own question, in front of the person.
    AskThePerson,
    /// Already allowed: the device is read with nothing shown.
    Read,
}

/// THE PERSON IS ASKED ONLY WHEN THE CALL SAID SO. The page keeps "once per device" and reads a
/// device that follows its person without ever showing anything, so the read that must stay silent
/// says `prompt: false` — and gets `undetermined_no_prompt` rather than a dialog if the permission
/// was taken back between the page's look and its read.
#[cfg(any(target_os = "macos", test))]
fn first_step(permission: DevicePermission, prompt: bool) -> Step {
    match permission {
        DevicePermission::Granted => Step::Read,
        DevicePermission::Prompt if prompt => Step::AskThePerson,
        DevicePermission::Prompt => Step::Answer(DevicePlace::UndeterminedNoPrompt),
        DevicePermission::Denied => Step::Answer(DevicePlace::Denied),
        DevicePermission::Restricted => Step::Answer(DevicePlace::Restricted),
        DevicePermission::Unsupported => Step::Answer(DevicePlace::Unsupported),
    }
}

/// Say whether this device may be asked. ON THE MAIN THREAD — `run_on_main_thread` is how the
/// commands in `lib.rs` get here. Reads one property; shows nothing, reads no location.
#[cfg(not(target_os = "macos"))]
pub(crate) fn permission(_app: &tauri::AppHandle, answer: Sender<DevicePermission>) {
    let _ = answer.try_send(DevicePermission::Unsupported);
}

/// Say where this device is, or why not. ON THE MAIN THREAD, like `permission`.
///
/// NOT READ ON WINDOWS. What it would take is in desktop/README.md ("The device's place"); it is
/// not written here because nothing here could run it, and code that reads somebody's location is
/// not code to ship unmeasured.
#[cfg(not(target_os = "macos"))]
pub(crate) fn place(_app: &tauri::AppHandle, _prompt: bool, answer: Sender<DevicePlace>) {
    let _ = answer.try_send(DevicePlace::Unsupported);
}

#[cfg(target_os = "macos")]
pub(crate) use core_location::{permission, place};

#[cfg(target_os = "macos")]
mod core_location {
    use std::cell::{OnceCell, RefCell};
    use std::thread;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_core_location::{
        kCLLocationAccuracyKilometer, CLLocation, CLLocationManager, CLLocationManagerDelegate,
    };
    use objc2_foundation::{NSArray, NSError};
    use tauri::async_runtime::Sender;

    use super::{
        coarse_place, failure, first_step, is_recent, DevicePermission, DevicePlace, Step,
        READ_BOUND,
    };

    define_class!(
        /// What CoreLocation calls back. It holds nothing: every callback arrives on the main
        /// thread — the run loop of the thread the manager was made on — and reads `DEVICE` and
        /// `WAITING` there, which only that thread can.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        struct PlaceDelegate;

        unsafe impl NSObjectProtocol for PlaceDelegate {}

        unsafe impl CLLocationManagerDelegate for PlaceDelegate {
            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            fn authorization_changed(&self, _manager: &CLLocationManager) {
                permission_changed();
            }

            #[unsafe(method(locationManager:didUpdateLocations:))]
            fn located(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
                // The newest fix is the last, and it is rounded on this line: past it, nothing
                // this process holds is finer than two decimals.
                finish(
                    locations
                        .lastObject()
                        .map_or(DevicePlace::Unavailable, |fix| place_of(&fix)),
                );
            }

            #[unsafe(method(locationManager:didFailWithError:))]
            fn failed(&self, _manager: &CLLocationManager, error: &NSError) {
                finish(failure(error.code()));
            }
        }
    );

    /// The one manager this process makes, the delegate it calls, and the way back to the main
    /// thread for the bound on a read.
    ///
    /// MADE ONCE AND KEPT, the first time the page asks. A manager per question would have to be
    /// let go of inside its own callback, which is the manager being freed by the code it is in the
    /// middle of calling. One that is never let go of has no such moment, costs nothing while it is
    /// asked nothing — it is told to find one fix and stops — and its `location` is what makes a
    /// second question within the hour cost the device nothing.
    struct Device {
        app: tauri::AppHandle,
        manager: Retained<CLLocationManager>,
        /// The manager's `delegate` is a weak reference: this is what keeps the delegate alive.
        _delegate: Retained<PlaceDelegate>,
    }

    /// Everybody waiting for the device, and what they are waiting on.
    ///
    /// ONE QUESTION AT A TIME, WHOEVER ASKS. The page asks at an open and again when somebody
    /// presses the button on 내 정보; the second joins the first and both are given the one answer,
    /// rather than two dialogs or two fixes.
    struct Waiting {
        answers: Vec<Sender<DevicePlace>>,
        /// The system's question is up, and has not been answered.
        is_asking_the_person: bool,
        /// Which read is under way, if one is. Counted so a bound that fires late cannot end the
        /// read after the one it was started for.
        reading: Option<u64>,
        reads: u64,
    }

    thread_local! {
        static DEVICE: OnceCell<Device> = const { OnceCell::new() };
        static WAITING: RefCell<Waiting> = const {
            RefCell::new(Waiting {
                answers: Vec::new(),
                is_asking_the_person: false,
                reading: None,
                reads: 0,
            })
        };
    }

    /// The manager, made on first use. Nothing off the main thread: there is no manager there, and
    /// its callbacks would have no run loop to arrive on.
    ///
    /// Handed out retained rather than borrowed, so that no borrow of `DEVICE` or `WAITING` is ever
    /// held across a call into CoreLocation — which may call the delegate back before it returns,
    /// and the delegate reads both.
    fn manager(app: &tauri::AppHandle) -> Option<Retained<CLLocationManager>> {
        let main_thread = MainThreadMarker::new()?;
        DEVICE.with(|device| {
            let device = device.get_or_init(|| {
                let delegate: Retained<PlaceDelegate> = unsafe {
                    msg_send![
                        super(main_thread.alloc::<PlaceDelegate>().set_ivars(())),
                        init
                    ]
                };
                // SAFETY: on the main thread, which the marker above is the proof of; the delegate
                // is kept beside the manager for as long as the manager is.
                let manager = unsafe { CLLocationManager::new() };
                unsafe {
                    // A kilometre: the coarsest fix that still names the town, which is all that
                    // is kept — and the cheapest for the device to find.
                    manager.setDesiredAccuracy(kCLLocationAccuracyKilometer);
                    manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                }
                Device {
                    app: app.clone(),
                    manager,
                    _delegate: delegate,
                }
            });
            Some(device.manager.clone())
        })
    }

    fn permission_of(manager: &CLLocationManager) -> DevicePermission {
        // SAFETY: a property read, on the thread the manager was made on. It asks nobody anything.
        DevicePermission::of_status(unsafe { manager.authorizationStatus() }.0)
    }

    fn place_of(fix: &CLLocation) -> DevicePlace {
        // SAFETY: both are reads of an immutable fix, on the main thread.
        let (at, accuracy) = unsafe { (fix.coordinate(), fix.horizontalAccuracy()) };
        coarse_place(at.latitude, at.longitude, accuracy)
    }

    /// A fix CoreLocation already holds, when it is young enough to be the answer.
    fn recent(manager: &CLLocationManager) -> Option<DevicePlace> {
        // SAFETY: property reads on the main thread; `location` is nil until a fix has been found.
        let fix = unsafe { manager.location() }?;
        let age_seconds = -unsafe { fix.timestamp() }.timeIntervalSinceNow();
        let held = place_of(&fix);
        (is_recent(age_seconds) && matches!(held, DevicePlace::Place { .. })).then_some(held)
    }

    pub(crate) fn permission(app: &tauri::AppHandle, answer: Sender<DevicePermission>) {
        // Off the main thread there is nothing to read, and "no" is the answer that asks nothing.
        let said = manager(app).map_or(DevicePermission::Denied, |manager| permission_of(&manager));
        let _ = answer.try_send(said);
    }

    pub(crate) fn place(app: &tauri::AppHandle, prompt: bool, answer: Sender<DevicePlace>) {
        let Some(manager) = manager(app) else {
            let _ = answer.try_send(DevicePlace::Unavailable);
            return;
        };
        let permission = permission_of(&manager);
        log::info!(
            "the page asked where this device is: permission={permission:?} prompt={prompt}"
        );
        match first_step(permission, prompt) {
            Step::Answer(said) => {
                let _ = answer.try_send(said);
                // A refusal is everybody's answer: whoever was waiting on the person is told too,
                // should the system not have said so itself.
                if matches!(said, DevicePlace::Denied | DevicePlace::Restricted) {
                    finish(said);
                }
            }
            Step::AskThePerson => {
                let is_first = WAITING.with_borrow_mut(|waiting| {
                    waiting.answers.push(answer);
                    !std::mem::replace(&mut waiting.is_asking_the_person, true)
                });
                if is_first {
                    log::info!("asking the person whether this device may be read");
                    // SAFETY: on the main thread. The answer arrives at `permission_changed`.
                    unsafe { manager.requestWhenInUseAuthorization() };
                }
            }
            Step::Read => read(app, &manager, Some(answer)),
        }
    }

    /// Read the device for everybody waiting, and for `answer` when there is one.
    fn read(
        app: &tauri::AppHandle,
        manager: &CLLocationManager,
        answer: Option<Sender<DevicePlace>>,
    ) {
        if let Some(held) = recent(manager) {
            if let Some(answer) = answer {
                let _ = answer.try_send(held);
            }
            finish(held);
            return;
        }
        let started = WAITING.with_borrow_mut(|waiting| {
            waiting.answers.extend(answer);
            waiting.is_asking_the_person = false;
            if waiting.reading.is_some() {
                return None;
            }
            waiting.reads += 1;
            waiting.reading = Some(waiting.reads);
            waiting.reading
        });
        let Some(read) = started else {
            return;
        };
        // SAFETY: on the main thread. One fix, to `located` or `failed`, and the manager stops.
        unsafe { manager.requestLocation() };
        let app = app.clone();
        // The bound, kept by a thread that only sleeps: it does nothing but come back to the main
        // thread, where everything about the read is.
        thread::spawn(move || {
            thread::sleep(READ_BOUND);
            let _ = app.run_on_main_thread(move || expire(read));
        });
    }

    /// The system's word on asking changed — and it calls this once when the delegate is set, too,
    /// with whatever the word already was.
    fn permission_changed() {
        let Some((app, manager)) = DEVICE.with(|device| {
            device
                .get()
                .map(|device| (device.app.clone(), device.manager.clone()))
        }) else {
            return;
        };
        match permission_of(&manager) {
            DevicePermission::Granted => {
                // Somebody was waiting on the person, and the person said yes: now the device.
                let is_owed = WAITING.with_borrow(|waiting| {
                    !waiting.answers.is_empty() && waiting.reading.is_none()
                });
                if is_owed {
                    read(&app, &manager, None);
                }
            }
            DevicePermission::Denied => finish(DevicePlace::Denied),
            DevicePermission::Restricted => finish(DevicePlace::Restricted),
            // Still not decided: this was the call that comes with setting the delegate, or the
            // question is still up.
            DevicePermission::Prompt | DevicePermission::Unsupported => {}
        }
    }

    /// The read took too long. Stopping is what cancels a fix the manager is still looking for.
    fn expire(read: u64) {
        if WAITING.with_borrow(|waiting| waiting.reading != Some(read)) {
            return;
        }
        if let Some(manager) = DEVICE.with(|device| device.get().map(|it| it.manager.clone())) {
            // SAFETY: on the main thread.
            unsafe { manager.stopUpdatingLocation() };
        }
        finish(DevicePlace::Timeout);
    }

    /// Give everybody waiting the one answer. A callback that arrives with nobody waiting — a fix
    /// after its bound, a change made in System Settings — answers nobody and is kept nowhere.
    fn finish(said: DevicePlace) {
        let answers = WAITING.with_borrow_mut(|waiting| {
            waiting.is_asking_the_person = false;
            waiting.reading = None;
            std::mem::take(&mut waiting.answers)
        });
        if answers.is_empty() {
            return;
        }
        // The kind and never the place: `DevicePlace` prints nothing else.
        log::info!("this device answered: {said:?}");
        for answer in answers {
            let _ = answer.try_send(said);
        }
    }

    #[cfg(test)]
    mod tests {
        use objc2_core_location::{CLAuthorizationStatus, CLError};

        use super::super::{failure, DevicePermission, DevicePlace};

        /// `of_status` and `failure` read numbers so that they can be tested where there is no
        /// CoreLocation; this is where the numbers are held to the framework's own names.
        #[test]
        fn the_numbers_are_the_frameworks_own() {
            for (status, expected) in [
                (
                    CLAuthorizationStatus::NotDetermined,
                    DevicePermission::Prompt,
                ),
                (
                    CLAuthorizationStatus::Restricted,
                    DevicePermission::Restricted,
                ),
                (CLAuthorizationStatus::Denied, DevicePermission::Denied),
                (
                    CLAuthorizationStatus::AuthorizedAlways,
                    DevicePermission::Granted,
                ),
                (
                    CLAuthorizationStatus::AuthorizedWhenInUse,
                    DevicePermission::Granted,
                ),
            ] {
                assert_eq!(DevicePermission::of_status(status.0), expected);
            }
            assert_eq!(failure(CLError::Denied.0), DevicePlace::Denied);
            assert_eq!(
                failure(CLError::LocationUnknown.0),
                DevicePlace::Unavailable
            );
            assert_eq!(failure(CLError::Network.0), DevicePlace::Unavailable);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        coarse, coarse_place, failure, first_step, is_recent, DevicePermission, DevicePlace, Step,
    };

    /// Two decimals, and nothing finer ever: the whole of what makes this safe to hand a page.
    #[test]
    fn a_fix_is_rounded_to_two_decimals_before_it_is_anything_else() {
        assert_eq!(
            coarse_place(37.498_095, 127.027_61, 65.0),
            DevicePlace::Place {
                latitude: 37.5,
                longitude: 127.03
            }
        );
        // South and west of zero round the same way, toward the nearest hundredth.
        assert_eq!(
            coarse_place(-33.868_82, -151.209_3, 1000.0),
            DevicePlace::Place {
                latitude: -33.87,
                longitude: -151.21
            }
        );
        // Already coarse stays put: rounding twice is rounding once.
        for degrees in [37.88, 127.73, -0.01, 0.0, 90.0, -180.0] {
            assert_eq!(coarse(coarse(degrees)), coarse(degrees));
            assert_eq!(coarse(degrees), degrees);
        }
        // And what crosses to the page holds no third decimal, whatever the device said.
        let said = serde_json::to_string(&coarse_place(35.179_554_3, 129.075_641_6, 30.0))
            .expect("a place is serialisable");
        assert_eq!(
            said,
            r#"{"kind":"place","latitude":35.18,"longitude":129.08}"#
        );
    }

    /// A fix the device cannot stand behind, or one that is not on this planet, is no place.
    #[test]
    fn a_fix_that_is_not_a_place_is_unavailable() {
        for (latitude, longitude, accuracy) in [
            // CoreLocation's own mark for an invalid fix.
            (37.5, 127.03, -1.0),
            (37.5, 127.03, f64::NAN),
            (90.01, 127.03, 10.0),
            (37.5, -180.01, 10.0),
            (f64::NAN, 127.03, 10.0),
            (37.5, f64::INFINITY, 10.0),
        ] {
            assert_eq!(
                coarse_place(latitude, longitude, accuracy),
                DevicePlace::Unavailable,
                "({latitude}, {longitude}) ±{accuracy}"
            );
        }
        // The edges of the planet are on it.
        assert!(matches!(
            coarse_place(-90.0, 180.0, 0.0),
            DevicePlace::Place { .. }
        ));
    }

    /// The system's word on asking, by its number — and an unknown number is never a yes.
    #[test]
    fn a_status_the_shell_does_not_know_reads_nothing() {
        assert_eq!(DevicePermission::of_status(0), DevicePermission::Prompt);
        assert_eq!(DevicePermission::of_status(1), DevicePermission::Restricted);
        assert_eq!(DevicePermission::of_status(2), DevicePermission::Denied);
        assert_eq!(DevicePermission::of_status(3), DevicePermission::Granted);
        assert_eq!(DevicePermission::of_status(4), DevicePermission::Granted);
        for unknown in [-1, 5, 99, i32::MAX] {
            assert_eq!(
                DevicePermission::of_status(unknown),
                DevicePermission::Denied
            );
        }
    }

    /// The person is asked only when the call said so; allowed is read with nothing shown; and a
    /// no — theirs or the machine's — is the answer without the device being touched.
    #[test]
    fn the_person_is_asked_only_when_the_call_says_so() {
        for prompt in [true, false] {
            assert_eq!(first_step(DevicePermission::Granted, prompt), Step::Read);
            assert_eq!(
                first_step(DevicePermission::Denied, prompt),
                Step::Answer(DevicePlace::Denied)
            );
            assert_eq!(
                first_step(DevicePermission::Restricted, prompt),
                Step::Answer(DevicePlace::Restricted)
            );
            assert_eq!(
                first_step(DevicePermission::Unsupported, prompt),
                Step::Answer(DevicePlace::Unsupported)
            );
        }
        assert_eq!(
            first_step(DevicePermission::Prompt, true),
            Step::AskThePerson
        );
        // The silent read: no dialog, and the page is told why there is no place.
        assert_eq!(
            first_step(DevicePermission::Prompt, false),
            Step::Answer(DevicePlace::UndeterminedNoPrompt)
        );
    }

    /// A refusal at the device is the person's no; anything else is a device that could not say.
    #[test]
    fn a_failed_read_is_denied_or_unavailable() {
        assert_eq!(failure(1), DevicePlace::Denied);
        for other in [0, 2, 3, 18, 99, -1] {
            assert_eq!(failure(other), DevicePlace::Unavailable);
        }
    }

    /// An hour, as the browser is given: a fix inside it is the answer, and one from the future
    /// or from longer ago is not.
    #[test]
    fn a_fix_under_an_hour_old_is_still_the_answer() {
        for age in [0.0, 1.0, 59.0 * 60.0, 3600.0] {
            assert!(is_recent(age), "{age}s");
        }
        for age in [3600.1, 86_400.0, -0.5, f64::NAN, f64::INFINITY] {
            assert!(!is_recent(age), "{age}s");
        }
    }

    /// What the page switches on, exactly: one word a reason, and both words of the permission
    /// the browser's own.
    #[test]
    fn the_page_is_told_a_kind_and_nothing_else() {
        let kind = |said: DevicePlace| serde_json::to_string(&said).expect("serialisable");
        assert_eq!(kind(DevicePlace::Denied), r#"{"kind":"denied"}"#);
        assert_eq!(kind(DevicePlace::Restricted), r#"{"kind":"restricted"}"#);
        assert_eq!(
            kind(DevicePlace::UndeterminedNoPrompt),
            r#"{"kind":"undetermined_no_prompt"}"#
        );
        assert_eq!(kind(DevicePlace::Unavailable), r#"{"kind":"unavailable"}"#);
        assert_eq!(kind(DevicePlace::Timeout), r#"{"kind":"timeout"}"#);
        assert_eq!(kind(DevicePlace::Unsupported), r#"{"kind":"unsupported"}"#);
        // Each kind is the word it serialises as, so the log and the page say the same thing.
        for said in [
            DevicePlace::Place {
                latitude: 37.5,
                longitude: 127.03,
            },
            DevicePlace::Denied,
            DevicePlace::Restricted,
            DevicePlace::UndeterminedNoPrompt,
            DevicePlace::Unavailable,
            DevicePlace::Timeout,
            DevicePlace::Unsupported,
        ] {
            assert!(kind(said).starts_with(&format!(r#"{{"kind":"{}""#, said.kind())));
        }

        let word = |said: DevicePermission| serde_json::to_string(&said).expect("serialisable");
        assert_eq!(word(DevicePermission::Granted), r#""granted""#);
        assert_eq!(word(DevicePermission::Prompt), r#""prompt""#);
        assert_eq!(word(DevicePermission::Denied), r#""denied""#);
        assert_eq!(word(DevicePermission::Restricted), r#""restricted""#);
        assert_eq!(word(DevicePermission::Unsupported), r#""unsupported""#);
    }

    /// The log is a file on somebody's disk. Printed any way a log line could print it, a place
    /// is its kind and never where.
    #[test]
    fn a_place_is_never_printed() {
        let here = DevicePlace::Place {
            latitude: 37.5,
            longitude: 127.03,
        };
        for printed in [format!("{here:?}"), format!("{here:#?}")] {
            assert_eq!(printed, "place");
            assert!(!printed.contains("37") && !printed.contains("127"));
        }
    }
}
