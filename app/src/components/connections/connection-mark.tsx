/**
 * WHAT A SERVICE LOOKS LIKE ON THE 연결 SCREEN.
 *
 * It was `name.trim().slice(0, 1)` in a grey rounded square. On a Korean screen that is the first
 * SYLLABLE, so twenty-four rows showed 노 네 네 네 쿠 배 쿠 요 홈 당 캐 토 네 인 카 카 — three of
 * them identical, two more nearly so, and not one of them telling anybody which service they were
 * about to hand a login to. The name beside it was doing all the work, which is another way of
 * saying the tile was doing none.
 *
 * INLINE, ALWAYS. The reason the initial existed is real and has not changed: twenty-four remote
 * logos on one screen is twenty-four ways for a row to be blank at the exact moment somebody is
 * deciding whether to trust it, and a request per vendor is a request per vendor. Everything here
 * is drawn from geometry and letterforms in this bundle. Nothing is fetched.
 *
 * A ROUNDED RECT INSIDE THE SVG, not a Tailwind background. The ground is the brand's own colour,
 * which is a per-vendor value: as a class it would be an arbitrary `bg-[#...]` that Tailwind can
 * only emit if it can see the literal string, and as a `style` attribute it would break the
 * house rule. As an SVG `fill` attribute it is neither — it is geometry, and it is what SVG is for.
 *
 * LETTERFORMS RATHER THAN TRACED LOGOS. A hand-approximated Google G or 배민 wordmark is a drawing
 * of somebody's trademark that is also slightly wrong, which is worse than not drawing it. Latin
 * letters on the brand's ground read at 32px, are unambiguous between vendors, and are honestly
 * ours. Four vendors get a geometric glyph instead, where the shape is simple enough to be exact
 * and carries more than the letters would.
 *
 * These are decoration: the tile is `aria-hidden` and the row's title is the accessible name, so
 * the brand pairings below are judged on legibility at 32px rather than against a text-contrast
 * floor they are not text for.
 */

/** The generic mark, for a service with no family of its own. */
export const GENERIC_MARK = "site";

type Mark = {
  /** The tile's ground. Absent means the theme's own muted fill, for the generic mark. */
  ground?: string;
  /** The letterform or glyph colour. */
  ink: string;
  /** One or two characters. Never one letter, and never a Korean syllable — that was the bug. */
  letters?: string;
  glyph?: "bubble" | "camera" | "document" | "globe";
};

/**
 * Every mark this build can draw, by id.
 *
 * `connection-marks.test.ts` walks it against `shared/sites/catalogue.ts` and the plugin catalogue
 * copy in both directions: a service naming a mark that is not here would silently fall back to the
 * globe, and a mark nothing names is dead weight nobody will notice.
 */
export const MARKS: Readonly<Record<string, Mark>> = {
  /*
   * One mark for Drive, Sheets, Gmail, Calendar and Business Profile. They are five products and
   * one consent: what the row is really asking about is the person's Google account.
   */
  google: { ground: "#FFFFFF", ink: "#4285F4", letters: "G" },
  naver: { ground: "#03C75A", ink: "#FFFFFF", letters: "N" },
  // The bubble rather than the letter: 카카오's shape is the one thing everybody in Korea can name
  // from across a room, and its yellow needs a dark ink or the tile reads as blank.
  kakao: { ground: "#FEE500", ink: "#3C1E1E", glyph: "bubble" },
  notion: { ground: "#FFFFFF", ink: "#111111", letters: "N" },
  coupang: { ground: "#AE1D2D", ink: "#FFFFFF", letters: "CP" },
  // Its own two letters rather than 쿠팡's: they are different logins, and the rows sit together.
  "coupang-eats": { ground: "#AE1D2D", ink: "#FFFFFF", letters: "CE" },
  baemin: { ground: "#2AC1BC", ink: "#0B3B3A", letters: "BM" },
  yogiyo: { ground: "#FA0050", ink: "#FFFFFF", letters: "YG" },
  daangn: { ground: "#FF6F0F", ink: "#FFFFFF", letters: "DG" },
  catchtable: { ground: "#FF5A36", ink: "#FFFFFF", letters: "CT" },
  toss: { ground: "#3182F6", ink: "#FFFFFF", letters: "TS" },
  // The digits, not the letters: "24" is the half of the name a person recognises.
  cafe24: { ground: "#0F4BEB", ink: "#FFFFFF", letters: "24" },
  instagram: { ground: "#E1306C", ink: "#FFFFFF", glyph: "camera" },
  // A form, because 홈택스 is the one row here that is a government office rather than a brand.
  hometax: { ground: "#1A4F9C", ink: "#FFFFFF", glyph: "document" },
  [GENERIC_MARK]: { ink: "currentColor", glyph: "globe" },
};

/**
 * The tile, at the size every row draws it.
 *
 * `aria-hidden`, because the row's title already names the service and a screen reader announcing
 * "N" before "네이버 스마트스토어 판매자센터" is noise.
 */
export const ConnectionMark = ({ mark }: { mark?: string }) => {
  const found = MARKS[mark ?? GENERIC_MARK] ?? MARKS[GENERIC_MARK];
  // Never undefined in practice; the fallback keeps a bad id from throwing on a screen about trust.
  const spec = found ?? { ink: "currentColor", glyph: "globe" as const };

  return (
    <svg
      aria-hidden="true"
      className="size-8 shrink-0 text-muted-foreground"
      role="presentation"
      viewBox="0 0 32 32"
    >
      {/*
       * Inset by half a pixel so the 1px stroke lands inside the box rather than straddling its
       * edge, which is what makes a white tile on a white card read as an edge rather than a smudge.
       */}
      <rect
        className={spec.ground ? "stroke-border" : "fill-muted stroke-border"}
        fill={spec.ground}
        height="31"
        rx="8"
        strokeWidth="1"
        width="31"
        x="0.5"
        y="0.5"
      />
      {spec.letters ? (
        <text
          fill={spec.ink}
          fontSize={spec.letters.length > 1 ? 12 : 16}
          fontWeight="700"
          textAnchor="middle"
          x="16"
          y="16"
          // `central` rather than a nudged baseline: the two letter counts have different cap
          // heights and a hand-tuned `y` would centre one of them and not the other.
          dominantBaseline="central"
        >
          {spec.letters}
        </text>
      ) : null}
      {spec.glyph === "bubble" ? (
        <g fill={spec.ink}>
          <ellipse cx="16" cy="14.5" rx="8" ry="6" />
          <path d="M12.5 19.5 L11 24 L15.5 20.5 Z" />
        </g>
      ) : null}
      {spec.glyph === "camera" ? (
        <g
          fill="none"
          stroke={spec.ink}
          strokeLinecap="round"
          strokeWidth="1.8"
        >
          <rect height="16" rx="5" width="16" x="8" y="8" />
          <circle cx="16" cy="16" r="4" />
          <circle cx="21.2" cy="10.8" fill={spec.ink} r="0.9" stroke="none" />
        </g>
      ) : null}
      {spec.glyph === "document" ? (
        <g
          fill="none"
          stroke={spec.ink}
          strokeLinecap="round"
          strokeWidth="1.8"
        >
          <path d="M11 8 h7 l4 4 v12 a1 1 0 0 1 -1 1 h-10 a1 1 0 0 1 -1 -1 v-15 a1 1 0 0 1 1 -1 z" />
          <path d="M13.5 17 h6 M13.5 20.5 h4" />
        </g>
      ) : null}
      {spec.glyph === "globe" ? (
        <g fill="none" stroke={spec.ink} strokeWidth="1.6">
          <circle cx="16" cy="16" r="7" />
          <path d="M9 16 h14 M16 9 a10 10 0 0 1 0 14 a10 10 0 0 1 0 -14" />
        </g>
      ) : null}
    </svg>
  );
};
