import type { Coordinates, Whereabouts } from "@shared/whereabouts";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  authKeys,
  type CurrentUserResult,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import { inShell } from "@/lib/notifications/shell";
import {
  canAskDeviceLocation,
  canUseDeviceLocation,
  clearPlace,
  type DevicePermission,
  type DeviceReading,
  devicePermission,
  readDevice,
  readDeviceCoordinates,
  saveDeviceCoordinates,
  savePlace,
} from "./queries";

/**
 * The device's own place — asked for once, and followed after — so the default is where the
 * person really is.
 *
 * The owner, 2026-10-05: "지역과 날짜는 기본값 실제 위치 데이터, fallback은 서울, 유저가 특정 위치를
 * 말해주면 저장." The date already was the device's (its zone rides on every turn and is kept for the
 * routines). The place was not: the device was read only when somebody found 내 정보 → 위치 and
 * pressed a button there, so for nearly everybody "real location" was nothing, and nothing is now
 * Seoul. This asks the device instead.
 *
 * ON BOTH SURFACES, THROUGH ONE TABLE. A browser tab is asked through `navigator.geolocation`; the
 * installed app, whose webview answers no such request, through its shell (`queries.ts`). The
 * first cut left the shell out, so the surface this product leads with was the one that fell
 * straight to Seoul. What to do is decided here once for both (`devicePlaceMove`) — the doors
 * differ, the table does not. A shell that cannot read the device — one from before the command,
 * or on Windows — says so by having no answer about being asked, which is the table's "cannot say".
 *
 * NOT BEFORE THE PERSON HAS AGREED TO ANYTHING. The first cut ran for anybody signed in, which
 * includes the first-run screen and the screen that asks again when the terms change: a new person
 * met the browser's location dialog before the sentence that says what continuing means, and a
 * browser that had already said yes was read and saved with nothing shown, before the agreement was
 * recorded (review of pull request 91). It waits for the same two facts `_authed`'s guard reads —
 * past the first run, no agreement owed — and never runs on the two screens that ask for them.
 *
 * NOT WHILE THE PERSON HAS SAID WHERE THEY ARE. What a person said outranks where a device is, in
 * the prompt and in the weather tool alike, so for them the device's dialog would only be a
 * surprise with nothing behind it, and a silent read a read of nothing anybody uses. They are not
 * asked and not read, and the once is not spent: if the words are cleared later, the default is the
 * device again and it is asked then.
 *
 * ONCE PER DEVICE — AND WHAT "ONCE" IS DEPENDS ON WHETHER THE QUESTION IS KNOWN TO HAVE BEEN SEEN.
 * A browser shows its prompt the moment it is asked, and never says that it went unanswered: an
 * ignored prompt simply stays there. So in a tab the once is spent when the question is put,
 * answered or not — asked and ignored must never ask again, or every load would. The installed
 * app's question goes through the system, which shows nothing where the app is not in use and
 * says nothing either: there the once was being spent on a dialog nobody saw (review of pull
 * request 94). The shell can tell — it answers `unanswered` after a minute — so there, and only
 * there, the once is spent by the person's answer, and an ask that comes back unanswered leaves
 * the device to be asked again (`tellsWhenUnanswered`). And an account that holds coordinates has
 * had its once on every device that sees them: nobody is shown a dialog about a place the account
 * already has.
 *
 * AND THE PLACE FOLLOWS THE DEVICE. Until this, coordinates saved at the first allow were a
 * snapshot: somebody who allowed location in 춘천 and opened the app in 부산 still got 춘천's
 * weather — measured in a browser that already said yes, at 부산, over an account holding 춘천: the
 * device was marked and never read. So a device that is ALREADY allowed is read again, with
 * nothing shown, and the answer is kept only when it has really moved. Nobody is ever shown
 * anything for this: it is the read of a device that said yes, or it is nothing. With two allowed
 * devices the account's place is the one looked at last, which is where the person is.
 *
 * WHENEVER THE WINDOW IS LOOKED AT AGAIN, AND AT MOST ONCE AN HOUR (`useDevicePlace`). Closing the
 * installed app puts its window away and its page goes on living for days, so "at an open" was
 * once, the day it was installed: somebody who travelled with the app in the tray stayed where
 * they had been until they quit it. The same move runs when the page is seen again, and the time
 * of the last read is kept on the device so that looking twice in an hour reads once.
 *
 * ONLY A FIX WORTH KEEPING, AND ONLY A REAL MOVE. What nobody pressed for is held to more than
 * what somebody did. A fix the device itself says may be more than three kilometres off is not
 * kept: a desktop on a cable is placed by its address, to within a city or two, and "last looked
 * at wins" would let that overwrite the good place a laptop gave — and a first read that names
 * the wrong city is worse than the Seoul that says it does not know. And a follow writes only
 * when the device is at least two hundredths of a degree from where the account has it: at the
 * edge of a cell the rounded value flips back and forth, and each flip would be a new place line
 * in the prompt and a colder cache, for somebody sitting still.
 *
 * 지우기 IS FINAL ON THE DEVICE IT WAS PRESSED ON, until the person chooses this device's place
 * again from 내 정보. That is why "asked" and "cleared" are two marks and not one
 * (`DeviceMark`): every device that follows has been asked, and only one whose person cleared its
 * place must stop following. A place cleared here does not come back by itself, which would make
 * 지우기 a control that does nothing.
 *
 * NEVER FINER THAN TWO DECIMALS, NEVER LOGGED, AND NEVER THE WORDS: the door rounds before
 * anything holds the answer — and the shell has rounded before that — and it goes through the
 * settings button's own door with no word about the place the person said
 * (`saveDeviceCoordinates`) — the server writes the coordinates and leaves the words as they are,
 * whatever this tab thought they were.
 */

/**
 * Per device, in this browser's storage: that this device's once is spent — `1`. `0` is the
 * installed app's question put and not yet answered, which spends nothing.
 */
const DEVICE_PLACE_ASKED_KEY = "laf.device-place-asked";

/** Per device too: `1` when the person cleared this device's place HERE. Absent, they have not. */
const DEVICE_PLACE_CLEARED_KEY = "laf.device-place-cleared";

/** And when this device was last read by itself, in milliseconds: what keeps that to once an hour. */
const DEVICE_PLACE_READ_AT_KEY = "laf.device-place-read-at";

const AN_HOUR_MS = 3_600_000;

/**
 * How far off a fix may say it is, in metres, and still be kept for somebody who pressed nothing.
 *
 * Three kilometres: a fix from Wi-Fi is good to a street or two and one from a phone's cell to a
 * kilometre or so, and both name the right 시·구. What this leaves out is the fix a machine with
 * neither gets from its address, which can be a city away. A device that does not say how far off
 * it is has not said it is good.
 */
export const AUTOMATIC_ACCURACY_METRES = 3000;

/** How far a device must be from where the account has it before a follow writes: 0.02°, either way. */
const MOVED_HUNDREDTHS = 2;

/**
 * What this device remembers about being asked.
 *
 *   none      not asked — or, in the installed app, asked and not answered
 *   asked     the once is spent: they were asked, or the account's once was spent here
 *   cleared   지우기, here: nothing is read by itself until they choose this device's place again
 */
export type DeviceMark = "none" | "asked" | "cleared";

export type DevicePlaceMove =
  /** Already allowed and nothing held: read it and keep it, with nothing shown. */
  | "read"
  /** Already allowed, over coordinates the account holds: read it, and keep it only if it moved. */
  | "follow"
  /** Not decided: the device's own prompt. Spends the once. */
  | "ask"
  /** The account holds coordinates and the device is not to be read: the once is spent here too. */
  | "spent"
  /** Nothing, and nothing is marked: a later look decides again. */
  | "nothing";

/**
 * Whether a person is somebody the device may be asked about at all: past the first run, owing no
 * agreement, and not on the two screens that exist to ask for those. The same facts `_authed`'s
 * `beforeLoad` reads; the paths are named as well, because a person can stand on `/welcome` for a
 * moment after the stamp lands and before the screen leaves.
 */
export function mayAskAboutTheDevice(
  user: { onboarded: boolean; consentRequired: boolean } | null | undefined,
  pathname: string,
): boolean {
  if (!user?.onboarded || user.consentRequired) return false;
  return pathname !== "/welcome" && pathname !== "/consent";
}

/**
 * What to do when the page is looked at, in a tab and in the installed app alike. In order, and
 * the order is the rule:
 *
 *   not agreed, or a surface with no way to ask               nothing
 *   the person cleared this device's place here               nothing — until they give it again
 *   this device was read by itself within the hour            nothing — once an hour is enough
 *   the account holds coordinates
 *     and the person has said where they are                  spent — their words are the place
 *     and the device says yes already                         follow — read, kept only if it moved
 *     otherwise                                               spent — no dialog over a place held
 *   the person has said where they are                        nothing — and the once is kept
 *   the device says yes already                               read
 *   this device's once is spent                               nothing
 *   the device has not decided                                ask
 *   the device says no, or cannot say (no Permissions API,    nothing — asking blind is a prompt
 *     a shell that cannot read it)                            nobody chose to risk
 *
 * "Read" comes before "the once is spent" on purpose: a device that said yes and whose answer never
 * arrived — a save that failed, a fix too vague to keep, a dialog answered after the wait ran out
 * — is read at a later look instead of never.
 */
export function devicePlaceMove(input: {
  agreed: boolean;
  canAsk: boolean;
  held: Pick<Whereabouts, "place" | "coordinates">;
  mark: DeviceMark;
  isRecent: boolean;
  permission: DevicePermission;
}): DevicePlaceMove {
  if (!input.agreed || !input.canAsk) return "nothing";
  if (input.mark === "cleared") return "nothing";
  if (input.isRecent) return "nothing";
  const isSaid = Boolean(input.held.place?.trim());
  if (input.held.coordinates) {
    if (isSaid) return "spent";
    return input.permission === "granted" ? "follow" : "spent";
  }
  if (isSaid) return "nothing";
  if (input.permission === "granted") return "read";
  if (input.mark === "asked") return "nothing";
  if (input.permission === "prompt") return "ask";
  return "nothing";
}

/** Everything a device can say about being asked. */
const EVERY_ANSWER: readonly DevicePermission[] = [
  "granted",
  "prompt",
  "denied",
  null,
];

type Facts = Omit<Parameters<typeof devicePlaceMove>[0], "permission">;

/**
 * The move when nothing the device could say would change it — or undefined when it would.
 *
 * THE DEVICE IS NOT EVEN ASKED WHAT IT WOULD SAY until every reason not to ask has been ruled out,
 * so somebody who has not agreed, who has said where they are, who cleared this device's place, or
 * whose device was read within the hour costs the device nothing and leaves no mark. Read off the
 * table rather than written beside it: a second list of "the rows that do not need the device"
 * would be a second table.
 */
function moveWhateverTheDeviceSays(facts: Facts): DevicePlaceMove | undefined {
  const [first, ...rest] = EVERY_ANSWER.map((permission) =>
    devicePlaceMove({ ...facts, permission }),
  );
  return rest.every((move) => move === first) ? first : undefined;
}

/** Whether the device is far enough from where the account has it for a follow to write. */
function hasMoved(held: Coordinates | null, device: Coordinates): boolean {
  if (!held) return true;
  const hundredths = (degrees: number) => Math.round(degrees * 100);
  return (
    Math.abs(hundredths(device.latitude) - hundredths(held.latitude)) >=
      MOVED_HUNDREDTHS ||
    Math.abs(hundredths(device.longitude) - hundredths(held.longitude)) >=
      MOVED_HUNDREDTHS
  );
}

function deviceMark(): DeviceMark {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return "none";
    if (storage.getItem(DEVICE_PLACE_CLEARED_KEY) === "1") return "cleared";
    return storage.getItem(DEVICE_PLACE_ASKED_KEY) === "1" ? "asked" : "none";
  } catch {
    // Storage that throws cannot remember a 지우기 either, so nothing is read by itself here.
    return "cleared";
  }
}

/** Write one mark, and say whether it was kept. */
function keep(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

/** The once is spent on this device. Whether the mark was kept. */
function markAsked(): boolean {
  return keep(DEVICE_PLACE_ASKED_KEY, "1");
}

/**
 * Whether this device can keep a mark at all — found out before the installed app's question is
 * put, because there the once is spent by the answer and must be keepable then: a device that
 * cannot remember having been answered would ask at every look. What it leaves behind is `0`,
 * asked and not answered, which spends nothing.
 */
function canMark(): boolean {
  return keep(DEVICE_PLACE_ASKED_KEY, "0");
}

function wasReadWithinTheHour(): boolean {
  try {
    const at = Number(
      globalThis.localStorage?.getItem(DEVICE_PLACE_READ_AT_KEY),
    );
    const age = Date.now() - at;
    // A time that is not one, or one in the future — a clock that moved — is not a recent read.
    return at > 0 && age >= 0 && age < AN_HOUR_MS;
  } catch {
    return false;
  }
}

function markRead(): void {
  keep(DEVICE_PLACE_READ_AT_KEY, String(Date.now()));
}

/** What the account holds, as this tab last heard it. */
function heldIn(
  queryClient: QueryClient,
): Pick<Whereabouts, "place" | "coordinates"> {
  const current = queryClient.getQueryData<CurrentUserResult>(
    authKeys.currentUser(),
  );
  const whereabouts =
    current && typeof current === "object" ? current.whereabouts : null;
  return {
    place: whereabouts?.place ?? null,
    coordinates: whereabouts?.coordinates ?? null,
  };
}

export type DevicePlaceDoors = {
  /** Past the first run, owing no agreement, on a screen that asks for neither — read when acted on. */
  agreed: () => boolean;
  canAsk: () => boolean;
  /** What the account holds, as this tab knows it. Read again after the device answers. */
  held: () => Pick<Whereabouts, "place" | "coordinates">;
  mark: () => DeviceMark;
  /**
   * Whether this surface says when its question went unanswered. The installed app does: its
   * shell answers `unanswered`, since the system may never have shown the dialog. A browser tab
   * does not: its prompt is shown when asked and is silent for ever if ignored.
   */
  tellsWhenUnanswered: () => boolean;
  /** Whether a mark could be kept here at all: where it cannot, nobody is asked. */
  canMark: () => boolean;
  markAsked: () => boolean;
  /** Whether this device was read by itself within the hour, and the note that it is being now. */
  isRecent: () => boolean;
  markRead: () => void;
  permission: () => Promise<DevicePermission>;
  /** `mayPrompt` is true for the one ask and false for every read that must show nothing. */
  read: (mayPrompt: boolean) => Promise<DeviceReading>;
  /** The coordinates and nothing else: the words the account holds are not this door's to send. */
  save: (coordinates: Coordinates) => Promise<unknown>;
};

/**
 * The move, carried out. Says what it did, for a test: the table's own word, or
 *
 *   unanswered   the person was asked and did not decide — nothing is spent
 *   unread       they decided, and the device gave no place
 *   vague        it gave one too far off to keep for somebody who pressed nothing
 *   same         a device that is followed had not really moved
 *   unsaved      an answer the server did not take
 *
 * WHEN THE ONCE IS SPENT. A device that already said yes is marked before it is read — that yes
 * was the person's decision. One that has to be asked is marked BEFORE the question in a browser
 * tab, where a prompt closed with the tab, or ignored for ever, has still been the once; and
 * AFTER the answer in the installed app, where `unanswered` leaves the device to be asked again.
 *
 * ONLY THE ONE ASK MAY SHOW THE PERSON ANYTHING. Every other read tells the door so, and a shell
 * whose permission was taken back since it was looked at answers without a dialog.
 *
 * Quiet in every failure — denied at the prompt, no fix, offline. There is no screen here to say it
 * on, and the person is no worse off than before: Seoul, or where the device last was.
 */
export async function offerDevicePlace(
  doors: DevicePlaceDoors,
): Promise<
  DevicePlaceMove | "unanswered" | "unread" | "vague" | "same" | "unsaved"
> {
  const facts = (): Facts => ({
    agreed: doors.agreed(),
    canAsk: doors.canAsk(),
    held: doors.held(),
    mark: doors.mark(),
    isRecent: doors.isRecent(),
  });
  const move =
    moveWhateverTheDeviceSays(facts()) ??
    // The device's answer, on the facts as they are once it has given it.
    devicePlaceMove({ permission: await doors.permission(), ...facts() });
  if (move === "spent") doors.markAsked();
  if (move !== "read" && move !== "follow" && move !== "ask") return move;
  // Only an ask on a surface that can say "unanswered" waits for the answer before it is the once.
  const isSpentByTheAnswer = move === "ask" && doors.tellsWhenUnanswered();
  if (isSpentByTheAnswer ? !doors.canMark() : !doors.markAsked()) {
    return "nothing";
  }
  // Noted before the device is read: one that does not answer is tried again in an hour, not at
  // every look.
  if (move !== "ask") doors.markRead();
  let reading: DeviceReading;
  try {
    reading = await doors.read(move === "ask");
  } catch {
    return "unread";
  }
  if (isSpentByTheAnswer) {
    if (reading.coordinates === null && reading.refusal === "unanswered") {
      return "unanswered";
    }
    doors.markAsked();
  }
  if (move === "ask") doors.markRead();
  if (reading.coordinates === null) return "unread";
  if (
    reading.accuracy === null ||
    reading.accuracy > AUTOMATIC_ACCURACY_METRES
  ) {
    return "vague";
  }
  const now = doors.held();
  if (move === "follow") {
    // 지우기 pressed, or a place said, while the device was answering: theirs stands.
    if (doors.mark() === "cleared" || now.place?.trim()) return "nothing";
    if (!hasMoved(now.coordinates, reading.coordinates)) return "same";
  } else if (now.coordinates) {
    // Given another way while the prompt was up (the settings button, another tab): theirs stands.
    return "spent";
  }
  try {
    await doors.save(reading.coordinates);
  } catch {
    return "unsaved";
  }
  return move;
}

/**
 * 지우기, on this device: the place is cleared, and where the device's coordinates were part of it
 * this device stops being read by itself — whatever it had or had not been asked.
 *
 * WITHOUT THIS A CLEARED PLACE CAME BACK. Somebody whose coordinates came from the settings
 * button — every person who gave them before the device was asked by itself — had never been
 * marked: they cleared their place, and at the next open a browser that still said yes was read and
 * saved again (review of pull request 91). And since the place follows the device, a mark that only
 * said "asked" would not stop it either: every device that follows has been asked. Clearing words
 * alone marks nothing: the device was never part of that answer, and with nothing known it is the
 * default again.
 *
 * MARKED BEFORE THE REQUEST GOES, not when it comes back. A follow may be reading the device at
 * that moment; it looks at the mark when the device answers, and a mark written only after the
 * server had replied would let it save the place back in between (review of pull request 94). If
 * the server does not take the clear, the mark is taken off again: a place that was not cleared
 * leaves no device silenced.
 */
export async function clearPlaceOnThisDevice(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  const isMarking =
    heldIn(queryClient).coordinates !== null && deviceMark() !== "cleared";
  if (isMarking) keep(DEVICE_PLACE_CLEARED_KEY, "1");
  try {
    const cleared = await clearPlace(queryClient);
    // Coordinates were held, so somebody decided about a device once: the once is spent here.
    if (isMarking) markAsked();
    return cleared;
  } catch (failure) {
    if (isMarking) forget(DEVICE_PLACE_CLEARED_KEY);
    throw failure;
  }
}

function forget(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}

/**
 * The button on 내 정보: the person chooses this device as where they are. The device is read —
 * with the system's question if it has to be asked, and however vague the fix, since they are
 * looking at the answer — and saved at once, in one request that also takes the words away.
 *
 * ONE PRESS, BECAUSE THE BUTTON SAYS "USE". It used to read the device and wait for a second press
 * of 저장 — and with a place in words on the account that would have changed nothing either, since
 * what a person said outranks where a device is. The owner pressed it, allowed their device, saw
 * the box still holding the place typed before with two numbers under it, pressed seven more
 * times, and asked whether the place in the box was the server's location (2026-10-06). Choosing
 * the device is choosing it over the words: `place: null` goes with the coordinates, which the
 * door reads as an answer about both.
 *
 * AND IT IS HOW A 지우기 MADE HERE IS TAKEN BACK — when the save succeeds, not at the press: a
 * read that is refused, or a save the server does not take, leaves everything as it was and
 * rejects with the surface's words for why.
 */
export async function chooseThisDevice(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  const coordinates = await readDeviceCoordinates();
  const held = await savePlace({ place: null, coordinates }, queryClient);
  forget(DEVICE_PLACE_CLEARED_KEY);
  // They pressed and the device answered: the once is spent, and it has just been read.
  markAsked();
  markRead();
  return held;
}

/**
 * Whether to draw the button that asks this device: at once in a browser tab, and in the installed
 * app once its shell has said the device can be read.
 *
 * A shell from before the command, and one on Windows, cannot — and an installed app is not
 * replaced when the deployment is, so for a while most shells that open this page are the first
 * kind. There the button is absent rather than a control that asks and then says nothing.
 */
export function useCanUseDeviceLocation(): boolean {
  const [canUse, setCanUse] = useState(
    () => !inShell() && canAskDeviceLocation(),
  );
  useEffect(() => {
    if (!inShell()) return;
    let isMounted = true;
    void canUseDeviceLocation().then((answer) => {
      if (isMounted) setCanUse(answer);
    });
    return () => {
      isMounted = false;
    };
  }, []);
  return canUse;
}

/**
 * The device's place, offered whenever a person who may be asked is looking at the page
 * (`offerDevicePlace`): when a signed-in screen opens, and every time the page is seen again.
 *
 * SEEN AGAIN, BECAUSE THE INSTALLED APP IS NOT OPENED TWICE. Closing its window puts it away; the
 * page behind it goes on living for days and is never loaded again, so a hook that ran once per
 * mount ran once per install. Two things say the page is being looked at, and both are listened
 * for, as the socket already does for the same reason (`lib/channels/use-channel-events.ts`):
 * `visibilitychange` — a tab that is switched back to, a window that is uncovered or brought back
 * from the tray, a screen that is unlocked — and the window's `focus`, for the one that was on
 * screen all along and is clicked into again. The table keeps all of that to one read an hour.
 *
 * NEVER WHILE THE PAGE IS HIDDEN. An app started at login with its window away, and a tab opened
 * behind another, are not being looked at — and the system shows its question only for an app that
 * is in use, so asking then is asking nobody. The offer waits for the first look.
 *
 * ONE AT A TIME. An ask can take as long as the person takes; a second look while it is out
 * starts nothing. The work is in an effect and its own function: nothing here is read or written
 * while rendering.
 */
export function useDevicePlace(): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: user } = useQuery(currentUserQueryOptions());
  const mayAsk = mayAskAboutTheDevice(user, pathname);
  const isOffering = useRef(false);
  useEffect(() => {
    if (!mayAsk) return;
    const offer = () => {
      if (document.visibilityState !== "visible" || isOffering.current) return;
      isOffering.current = true;
      const done = () => {
        isOffering.current = false;
      };
      void offerDevicePlace({
        // Read again when acted on: the cache and the address, not what this render saw.
        agreed: () => {
          const current = queryClient.getQueryData<CurrentUserResult>(
            authKeys.currentUser(),
          );
          return mayAskAboutTheDevice(
            current && typeof current === "object" ? current : null,
            router.state.location.pathname,
          );
        },
        canAsk: canAskDeviceLocation,
        held: () => heldIn(queryClient),
        mark: deviceMark,
        tellsWhenUnanswered: inShell,
        canMark,
        markAsked,
        isRecent: wasReadWithinTheHour,
        markRead,
        permission: devicePermission,
        read: readDevice,
        save: (coordinates) => saveDeviceCoordinates(coordinates, queryClient),
      }).then(done, done);
    };
    offer();
    document.addEventListener("visibilitychange", offer);
    window.addEventListener("focus", offer);
    return () => {
      document.removeEventListener("visibilitychange", offer);
      window.removeEventListener("focus", offer);
    };
  }, [mayAsk, queryClient, router]);
}
