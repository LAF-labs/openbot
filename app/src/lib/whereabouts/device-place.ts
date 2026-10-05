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
  devicePermission,
  readDeviceCoordinates,
  saveDeviceCoordinates,
} from "./queries";

/**
 * The device's own place — asked for once, and followed after — so the default is where the
 * person really is.
 *
 * The owner, 2026-10-05: "지역과 날짜는 기본값 실제 위치 데이터, fallback은 서울, 유저가 특정 위치를
 * 말해주면 저장." The date already was the device's (its zone rides on every turn and is kept for the
 * routines). The place was not: the device was read only when somebody found 내 정보 → 위치 and
 * pressed a button there, so for nearly everybody "real location" was nothing, and nothing is now
 * Seoul. This asks the device at the first signed-in open instead.
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
 * ASKED ONCE PER DEVICE, WHATEVER CAME OF IT. Asked and dismissed must never ask again — a prompt
 * on every open is how a product gets its location blocked for good. And an account that holds
 * coordinates has had its once on every device that sees them: nobody is shown a dialog about a
 * place the account already has.
 *
 * AND THE PLACE FOLLOWS THE DEVICE. Until this, coordinates saved at the first allow were a
 * snapshot: somebody who allowed location in 춘천 and opened the app in 부산 still got 춘천's
 * weather — measured in a browser that already said yes, at 부산, over an account holding 춘천: the
 * device was marked and never read. So at an open, a device that is ALREADY allowed is read again,
 * with nothing shown, and the answer is kept only when the rounded value has moved. Nobody is ever
 * shown anything for this: it is the read of a device that said yes, or it is nothing. With two
 * allowed devices the account's place is the one opened last, which is where the person is.
 *
 * 지우기 IS FINAL ON THE DEVICE IT WAS PRESSED ON, until the person presses the device's button
 * there again. That is why "asked" and "cleared" are two marks and not one (`DeviceMark`): every
 * device that follows has been asked, and only one whose person cleared its place must stop
 * following. A place cleared here does not come back at the next open, which would make 지우기 a
 * control that does nothing.
 *
 * NEVER FINER THAN TWO DECIMALS, NEVER LOGGED, AND NEVER THE WORDS: `readDeviceCoordinates` rounds
 * before anything holds the answer — and the shell has rounded before that — and it goes through
 * the settings button's own door with no word about the place the person said
 * (`saveDeviceCoordinates`) — the server writes the coordinates and leaves the words as they are,
 * whatever this tab thought they were.
 */

/**
 * Per device, in this browser's storage: that the device's once is spent. `1`, and nothing else.
 *
 * LEFT EXACTLY AS IT WAS, so a build from before "cleared" existed still reads it as it wrote it:
 * rolled back, it sees a device that was asked and asks nobody twice.
 */
const DEVICE_PLACE_ASKED_KEY = "laf.device-place-asked";

/**
 * Per device too: whether the person cleared this device's place HERE. `1` when they pressed
 * 지우기 over coordinates; `0` when this build marked the device and they had not, or they pressed
 * the device's button again afterwards.
 */
const DEVICE_PLACE_CLEARED_KEY = "laf.device-place-cleared";

/**
 * What this device remembers about being asked.
 *
 *   none      never asked here
 *   asked     the once is spent, and the person has not cleared this device's place here
 *   cleared   지우기, here: nothing is read by itself until they press the device's button again
 *   old       marked by a build from before "cleared" was a mark of its own
 *
 * AN OLD MARK CANNOT SAY WHICH IT WAS — the one key was written when a device was asked and when
 * its place was cleared alike. So it is read by what the account holds. Coordinates held: it was
 * not a 지우기, which would have emptied them, and the device follows. Nothing held: it may have
 * been, and it is treated as one — a place cleared before this change stays cleared, at the cost
 * of a device whose once simply failed not being read again until its button is pressed. What an
 * old mark cannot rule out: a place cleared here before this change, and coordinates given since
 * from another device, reads as "held" and this device follows again.
 */
export type DeviceMark = "none" | "asked" | "cleared" | "old";

export type DevicePlaceMove =
  /** Already allowed and nothing held: read it and keep it, with nothing shown. Spends the once. */
  | "read"
  /** Already allowed, over coordinates the account holds: read it, and keep it only if it moved. */
  | "follow"
  /** Not decided: the device's own prompt, this once. Spends the once. */
  | "ask"
  /** The account holds coordinates and the device is not to be read: the once is spent here too. */
  | "spent"
  /** Nothing, and nothing is marked: a later open decides again. */
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
 * What to do at a signed-in open, in a tab and in the installed app alike. In order, and the
 * order is the rule:
 *
 *   not agreed, or a surface with no way to ask               nothing
 *   the person cleared this device's place here               nothing — until its button is pressed
 *   the account holds coordinates
 *     and the person has said where they are                  spent — their words are the place
 *     and the device says yes already                         follow — read, kept only if it moved
 *     otherwise                                               spent — no dialog over a place held
 *   an old mark, and nothing held                             nothing — it may have been a 지우기
 *   the person has said where they are                        nothing — and the once is kept
 *   the device says yes already                               read
 *   this device was asked before                              nothing
 *   the device has not decided                                ask
 *   the device says no, or cannot say (no Permissions API,    nothing — asking blind is a prompt
 *     a shell that cannot read it)                            nobody chose to risk
 *
 * "Read" comes before "asked before" on purpose: a device that said yes and whose first answer was
 * lost on the way — a save that failed, a dialog answered after the wait ran out — is read at the
 * next open instead of never.
 */
export function devicePlaceMove(input: {
  agreed: boolean;
  canAsk: boolean;
  held: Pick<Whereabouts, "place" | "coordinates">;
  mark: DeviceMark;
  permission: DevicePermission;
}): DevicePlaceMove {
  if (!input.agreed || !input.canAsk) return "nothing";
  if (input.mark === "cleared") return "nothing";
  const isSaid = Boolean(input.held.place?.trim());
  if (input.held.coordinates) {
    if (isSaid) return "spent";
    return input.permission === "granted" ? "follow" : "spent";
  }
  if (input.mark === "old") return "nothing";
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
 * so somebody who has not agreed, who has said where they are, or who cleared this device's place
 * costs the device nothing and leaves no mark. Read off the table rather than written beside it: a
 * second list of "the rows that do not need the device" would be a second table.
 */
function moveWhateverTheDeviceSays(facts: Facts): DevicePlaceMove | undefined {
  const [first, ...rest] = EVERY_ANSWER.map((permission) =>
    devicePlaceMove({ ...facts, permission }),
  );
  return rest.every((move) => move === first) ? first : undefined;
}

function deviceMark(): DeviceMark {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return "none";
    const cleared = storage.getItem(DEVICE_PLACE_CLEARED_KEY);
    if (cleared === "1") return "cleared";
    if (storage.getItem(DEVICE_PLACE_ASKED_KEY) !== "1") return "none";
    return cleared === "0" ? "asked" : "old";
  } catch {
    // Storage that throws cannot remember a 지우기 either, so nothing is read by itself here.
    return "cleared";
  }
}

/** Write both marks, and say whether they were kept. */
function keepMarks(isCleared: boolean): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    const cleared = isCleared ? "1" : "0";
    storage.setItem(DEVICE_PLACE_ASKED_KEY, "1");
    storage.setItem(DEVICE_PLACE_CLEARED_KEY, cleared);
    return (
      storage.getItem(DEVICE_PLACE_ASKED_KEY) === "1" &&
      storage.getItem(DEVICE_PLACE_CLEARED_KEY) === cleared
    );
  } catch {
    return false;
  }
}

/**
 * Spend the once: asked, and not cleared. Whether it was kept — where it cannot be, the device is
 * not asked: the once could not be held to. There is no 지우기 for this to take back: on a device
 * whose place was cleared here the table has nothing to do, so nothing is ever marked there.
 */
function markAsked(): boolean {
  return keepMarks(false);
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
  markAsked: () => boolean;
  permission: () => Promise<DevicePermission>;
  /** `mayPrompt` is true for the one ask and false for every read that must show nothing. */
  read: (mayPrompt: boolean) => Promise<Coordinates>;
  /** The coordinates and nothing else: the words the account holds are not this door's to send. */
  save: (coordinates: Coordinates) => Promise<unknown>;
};

/**
 * The move, carried out. Says what it did, for a test: the table's own word, or `same` for a
 * device that had not moved, `unread` for one that did not answer, `unsaved` for an answer the
 * server did not take.
 *
 * MARKED BEFORE THE DEVICE IS ASKED, not after: a prompt closed with the tab, or a read that never
 * comes back, has still been the once.
 *
 * ONLY THE ONE ASK MAY SHOW THE PERSON ANYTHING. Every other read tells the door so, and a shell
 * whose permission was taken back since it was looked at answers without a dialog.
 *
 * Quiet in every failure — denied at the prompt, no fix, offline. There is no screen here to say it
 * on, and the person is no worse off than before: Seoul, or where the device last was.
 */
export async function offerDevicePlace(
  doors: DevicePlaceDoors,
): Promise<DevicePlaceMove | "same" | "unread" | "unsaved"> {
  const facts = (): Facts => ({
    agreed: doors.agreed(),
    canAsk: doors.canAsk(),
    held: doors.held(),
    mark: doors.mark(),
  });
  const move =
    moveWhateverTheDeviceSays(facts()) ??
    // The device's answer, on the facts as they are once it has given it.
    devicePlaceMove({ permission: await doors.permission(), ...facts() });
  if (move === "spent") doors.markAsked();
  if (move !== "read" && move !== "follow" && move !== "ask") return move;
  if (!doors.markAsked()) return "nothing";
  let coordinates: Coordinates;
  try {
    coordinates = await doors.read(move === "ask");
  } catch {
    return "unread";
  }
  const now = doors.held();
  if (move === "follow") {
    // 지우기 pressed, or a place said, while the device was answering: theirs stands.
    if (doors.mark() === "cleared" || now.place?.trim()) return "nothing";
    if (
      now.coordinates?.latitude === coordinates.latitude &&
      now.coordinates.longitude === coordinates.longitude
    ) {
      return "same";
    }
  } else if (now.coordinates) {
    // Given another way while the prompt was up (the settings button, another tab): theirs stands.
    return "spent";
  }
  try {
    await doors.save(coordinates);
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
 */
export async function clearPlaceOnThisDevice(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  const hadCoordinates = heldIn(queryClient).coordinates !== null;
  const cleared = await clearPlace(queryClient);
  if (hadCoordinates) keepMarks(true);
  return cleared;
}

/**
 * The button on 내 정보: read this device because the person pressed — the one read that is theirs
 * rather than the app's, so it may show the system's question however often it has been asked —
 * and take back a 지우기 made here. Pressing it is how somebody says this device's place is wanted
 * again, and it follows the device from then on.
 */
export async function readThisDeviceOnAPress(): Promise<Coordinates> {
  const coordinates = await readDeviceCoordinates(true);
  keepMarks(false);
  return coordinates;
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
 * At a signed-in open, once the person is somebody who may be asked: the device's place, asked for
 * once and followed after (`offerDevicePlace`).
 *
 * One offer for each time this is mounted, however often the effect runs — and not spent while the
 * person is still on the first run or owes an agreement, so the offer is made on the screen they
 * land on after it. The work is in an effect and its own function: nothing here is read or written
 * while rendering.
 */
export function useDevicePlaceOnce(): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: user } = useQuery(currentUserQueryOptions());
  const mayAsk = mayAskAboutTheDevice(user, pathname);
  const offered = useRef(false);
  useEffect(() => {
    if (!mayAsk || offered.current) return;
    offered.current = true;
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
      markAsked,
      permission: devicePermission,
      read: readDeviceCoordinates,
      save: (coordinates) => saveDeviceCoordinates(coordinates, queryClient),
    });
  }, [mayAsk, queryClient, router]);
}
