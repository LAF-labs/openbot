import type { ReactNode } from "react";

/**
 * The shipped Bots' faces, drawn rather than generated.
 *
 * `boring-avatars` gives every Bot a different arrangement of the same gradient, which is right for a
 * person whose face nobody chose and wrong for the three Bots a deployment starts with: those are the
 * product, they are the first thing anybody sees, and at 32 pixels three procedural gradients are
 * three smudges. A Bot somebody creates still gets a generated one — the point is to name what we
 * shipped, not to hand-draw everything.
 *
 * Drawn to the ip-as-logo brief (s1dashu/ip-as-logo-skill, MIT), which is a design document rather
 * than a program: one continuous silhouette from four to seven basic shapes, filling most of the
 * frame and running off its edges rather than floating inside them; exactly three colours, two for
 * the creature and one for the ground, with the second colour doing every facial mark; thick rounded
 * contours and no sharp corner, point or thin line anywhere; two eyes and nothing else unless it
 * earns its place; and a silhouette still recognisable at 32 × 32. The brief asks for generated
 * raster images and these are SVG, for the reason its own last rule implies — a raster mascot is
 * mush at the size an avatar is actually drawn, and a vector is not.
 *
 * The shading is one soft fall-off across the whole tile, which is what "flat-first, subtly
 * neo-skeomorphic" buys: enough to stop the shapes reading as stickers, not enough to be a gradient.
 * It is a shade of the ground rather than a fourth colour.
 *
 * Silhouette carries the distinction, not hue: a cream dog with dark ears down its sides, an owl that
 * is mostly eyes, a dark penguin with a pale front. Held against each other in grey they are still
 * three different Bots, which is the test the brief actually sets and the one a sidebar applies.
 */

type Mascot = {
  /** The ground. Solid, and chosen away from both creature colours. */
  background: string;
  /** The creature. The second is also every facial mark; the brief forbids a fourth colour. */
  ip: [string, string];
  shapes: ReactNode;
};

const MASCOTS: Record<string, Mascot> = {
  /** Everyday work: a dog. The ears take the second colour, or they vanish into the head. */
  "general-assistant": {
    background: "#C6613F",
    ip: ["#FFF3E6", "#6B3A25"],
    shapes: (
      <>
        <ellipse cx="14" cy="64" rx="14" ry="27" fill="#6B3A25" />
        <ellipse cx="82" cy="64" rx="14" ry="27" fill="#6B3A25" />
        <rect x="17" y="22" width="62" height="80" rx="31" fill="#FFF3E6" />
        <circle cx="37" cy="56" r="5.5" fill="#6B3A25" />
        <circle cx="59" cy="56" r="5.5" fill="#6B3A25" />
        <ellipse cx="48" cy="70" rx="6" ry="4.5" fill="#6B3A25" />
      </>
    ),
  },

  /** Company knowledge: an owl. Round tufts read as a bear, so the eyes carry it alone. */
  knowledge: {
    background: "#2E6E64",
    ip: ["#F5F1E2", "#143F38"],
    shapes: (
      <>
        <rect x="9" y="20" width="78" height="86" rx="32" fill="#F5F1E2" />
        <circle cx="33" cy="52" r="15" fill="#143F38" />
        <circle cx="63" cy="52" r="15" fill="#143F38" />
        <ellipse cx="48" cy="76" rx="5" ry="4" fill="#143F38" />
      </>
    ),
  },

  /** Risk and compliance: a penguin. The pale front runs off the bottom; floated, it reads as a ghost. */
  "risk-analyst": {
    background: "#4F4FA0",
    ip: ["#EFEFF7", "#22224C"],
    shapes: (
      <>
        <rect x="8" y="16" width="80" height="94" rx="38" fill="#22224C" />
        <rect x="23" y="50" width="50" height="66" rx="25" fill="#EFEFF7" />
        <circle cx="36" cy="40" r="6" fill="#EFEFF7" />
        <circle cx="60" cy="40" r="6" fill="#EFEFF7" />
      </>
    ),
  },
};

/** Whether this id or seed is one of the Bots we drew. */
export function hasMascot(key: string | undefined): boolean {
  return key !== undefined && key in MASCOTS;
}

/** The ground a drawn Bot sits on, for surfaces that want to carry its colour themselves. */
export function mascotBackground(key: string | undefined): string | undefined {
  return key === undefined ? undefined : MASCOTS[key]?.background;
}

/**
 * One drawn face.
 *
 * `aria-hidden`, always: every caller already labels the avatar with the Bot's name, and a second
 * announcement reads the same coworker out twice.
 */
export function Mascot({
  mascotKey,
  size,
  className,
}: {
  mascotKey: string;
  size: number;
  className?: string;
}) {
  const mascot = MASCOTS[mascotKey];
  if (!mascot) return null;

  const shadeId = `mascot-shade-${mascotKey}`;

  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <title>{mascotKey}</title>
      <defs>
        <linearGradient id={shadeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.35" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.13" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" fill={mascot.background} />
      {mascot.shapes}
      {/* One fall-off over everything, ground included: flat first, and only just skeuomorphic. */}
      <rect width="96" height="96" fill={`url(#${shadeId})`} />
    </svg>
  );
}
