import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The person, not the Bot.
 *
 * `AuthenticatedUser.image` has been on `/api/me` since sign-in existed and nothing had ever drawn
 * it: every provider this deployment offers (Google, Kakao, Naver) hands back a picture, and the
 * app threw it away and drew two grey letters instead. The sidebar footer built those letters
 * inline, which is also why they were wrong for Korean — `"김기범".split(/\s+/).slice(0, 2)` is one
 * word, so it took `[0]` of it and then `.toUpperCase()`, and a name with no space rendered a
 * single syllable by accident rather than on purpose.
 *
 * WHAT MAKES IT FALL BACK RATHER THAN BREAK. A provider's picture URL is a third-party host that
 * expires, rate-limits, or refuses a referrer, and a broken <img> is a broken-image glyph where a
 * face was. `onError` puts the letters back, keyed on the URL that failed so a new picture is
 * tried rather than inheriting the last one's verdict.
 *
 * `referrerPolicy="no-referrer"`: Google's avatar host answers 403 to a referred request from an
 * origin it does not know, which is every deployment of this. It is also one less place this app
 * announces where somebody is signed in from.
 */

/** Soft enough to sit under text at any of the three sizes, in both themes. */
const TONES = [
  "bg-rose-100 text-rose-700 dark:bg-rose-400/20 dark:text-rose-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200",
  "bg-teal-100 text-teal-700 dark:bg-teal-400/20 dark:text-teal-200",
  "bg-sky-100 text-sky-700 dark:bg-sky-400/20 dark:text-sky-200",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/20 dark:text-indigo-200",
  "bg-violet-100 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-400/20 dark:text-fuchsia-200",
] as const;

const SIZES = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-base",
} as const;

export type PersonAvatarSize = keyof typeof SIZES;

/**
 * One letter, and for a Korean name one syllable.
 *
 * Scanned rather than sliced: a display name can lead with an emoji or a bracket, and `[0]` of
 * that is a coloured circle with a coloured circle in it.
 */
export const personInitial = (
  name: string | null | undefined,
  email: string | null | undefined,
): string => {
  const source = (name ?? "").trim() || (email ?? "").trim();
  for (const character of source) {
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(character)) return character;
    if (/[a-z]/i.test(character)) return character.toUpperCase();
    if (/[0-9]/.test(character)) return character;
  }
  return "?";
};

/**
 * The same person keeps the same colour, on every device and after every deploy.
 *
 * Keyed on the address rather than the display name, because a person renaming themselves is not a
 * different person and a colour that moves when they do is a colour that means nothing. Lower-cased
 * first, since an address is not case-sensitive in the half that matters here.
 */
export const personTone = (email: string | null | undefined): string => {
  let hash = 0;
  for (const character of (email ?? "").trim().toLowerCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return TONES[hash % TONES.length] as string;
};

export const PersonAvatar = ({
  className,
  email,
  image,
  name,
  size = "md",
}: {
  className?: string;
  email: string | null | undefined;
  image?: string | null;
  name?: string | null;
  size?: PersonAvatarSize;
}) => {
  /*
   * The URL that failed, not a boolean. A boolean would keep the letters up after the picture
   * changed to a working one — the state would have to be cleared by an effect watching the prop,
   * which is the same thing said less directly.
   */
  const [brokenSource, setBrokenSource] = useState<string | null>(null);
  const showsImage = Boolean(image) && image !== brokenSource;

  return (
    /*
     * Decorative. Both call sites put the name in text beside it, so announcing it here would read
     * the person's name twice — and `alt` on a provider's avatar is not information a screen
     * reader gains anything from.
     */
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium leading-none select-none",
        SIZES[size],
        showsImage ? "bg-muted" : personTone(email),
        className,
      )}
      data-slot="person-avatar"
    >
      {showsImage && image ? (
        <img
          alt=""
          className="size-full object-cover"
          onError={() => setBrokenSource(image)}
          referrerPolicy="no-referrer"
          src={image}
        />
      ) : (
        personInitial(name, email)
      )}
    </span>
  );
};
