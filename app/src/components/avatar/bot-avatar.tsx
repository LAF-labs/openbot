import { useId } from "react";
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  type BotAvatarPalette,
  type BotAvatarShape,
  botAvatarParams,
  botAvatarPhase,
} from "@/lib/avatar/bot-avatar";

/**
 * One Bot's face, and — while it is on a screen big enough to see it — what that Bot is doing.
 *
 * THE AVATAR IS THE STATUS LIGHT. A roster row used to carry a spinning ring welded to the corner
 * of a drawing that could not react to anything; the face itself was a photograph. A generated face
 * can look up when work starts, widen when it is stuck and settle when it is done, which is the
 * whole reason to generate one — a person scanning a column of five Bots reads posture before they
 * read a badge, and long before they read the second line of text.
 *
 * Inline JSX, never `dangerouslySetInnerHTML`. The old set was a table of markup strings and had to
 * argue in a comment that setting them as HTML was merely ugly rather than dangerous. Elements
 * cannot make that argument necessary.
 */

export type BotAvatarState = "idle" | "working" | "blocked" | "done";

/**
 * Below this, nothing moves.
 *
 * A 20px avatar animating is three pixels of noise in the corner of a header — it cannot be read as
 * a state, only as flicker, and a page with six of them looks broken. The drawing still changes:
 * blocked still raises its brows and carries its mark at any size, because that is information and
 * not decoration. Only the motion is gated.
 */
const ANIMATION_FLOOR_PX = 28;

/**
 * The one colour in this file that is not the Bot's own.
 *
 * A blocked Bot's mark has to be legible on both themes and on all ten palettes, so it cannot be
 * drawn from the palette (white vanishes on a light page, ink vanishes on a dark one). Amber is
 * outside every palette here on purpose: it never reads as part of the character.
 */
const ALERT = "#ff9f2e";

/** A five-point star, about its own centre, so the accessory can just be translated into place. */
const STAR =
  "M0 -8.5L2.3 -3.2L8.1 -2.6L3.7 1.2L5 6.9L0 3.9L-5 6.9L-3.7 1.2L-8.1 -2.6L-2.3 -3.2Z";

const Eyes = ({
  shape,
  palette,
  eyes,
  happy,
}: {
  shape: BotAvatarShape;
  palette: BotAvatarPalette;
  eyes: number;
  /** Squinting with pleasure — the shape a finished Bot's eyes take, whatever style it wears. */
  happy: boolean;
}) => {
  const left = 48 - shape.eyeGap / 2;
  const right = 48 + shape.eyeGap / 2;
  const y = shape.eyeY;

  if (happy) {
    return (
      <>
        {[left, right].map((cx) => (
          <path
            d={`M${cx - 6} ${y + 2}q6 -8 12 0`}
            fill="none"
            key={cx}
            stroke={palette.ink}
            strokeLinecap="round"
            strokeWidth="4"
          />
        ))}
      </>
    );
  }

  if (eyes === 2) {
    /*
     * A half-moon: the UPPER half of a disc, flat side down.
     *
     * It was the lower half first, and measured on a page of them that is a Bot looking at the
     * floor — five colleagues in a roster all sulking. Turned over it reads as an eye creased by a
     * smile, which is the same two curves and the opposite mood. Still distinct from the happy arc
     * a finished Bot wears, which is a stroke rather than a filled shape.
     */
    return (
      <>
        {[left, right].map((cx) => (
          <path
            d={`M${cx - 5.4} ${y + 1.5}a5.4 5.4 0 0 1 10.8 0Z`}
            fill={palette.ink}
            key={cx}
          />
        ))}
      </>
    );
  }

  if (eyes === 3) {
    return (
      <>
        {[left, right].map((cx) => (
          <circle
            cx={cx}
            cy={y}
            fill="none"
            key={cx}
            r="5.4"
            stroke={palette.ink}
            strokeWidth="3.2"
          />
        ))}
      </>
    );
  }

  const isOval = eyes === 1;
  return (
    <>
      {[left, right].map((cx) => (
        <g key={cx}>
          <ellipse
            cx={cx}
            cy={y}
            fill={palette.ink}
            rx={isOval ? 4.4 : 5.2}
            ry={isOval ? 6.4 : 5.2}
          />
          {/* The catchlight is what stops a filled eye reading as a hole punched in the face. */}
          <circle
            cx={cx - 1.7}
            cy={y - 2}
            fill="#ffffff"
            opacity="0.85"
            r="1.7"
          />
        </g>
      ))}
    </>
  );
};

/**
 * Whatever sits on the head, in the palette's contrast colour.
 *
 * Two of the seven are drawn INSIDE the body's clip and the rest outside it, which is why this
 * returns a pair rather than one fragment: a cap has to be cut to the shape of the head it is on,
 * and a leaf has to be allowed to stick out past it.
 */
const accessoryParts = (
  shape: BotAvatarShape,
  palette: BotAvatarPalette,
  accessory: number,
): { clipped: React.ReactNode; over: React.ReactNode } => {
  const accent = palette.accent;
  const crownY = shape.crownY;

  switch (accessory) {
    case 1:
      return {
        /*
         * A very large, very shallow ellipse whose lower edge crosses the head at `capY`. Cut to
         * the body it becomes a cap that fits any of the six shapes without a path per shape, and
         * the slight downward bulge in the middle is what makes it read as a cap rather than as a
         * swimming hat.
         */
        clipped: (
          <ellipse cx="48" cy={shape.capY - 60} fill={accent} rx="90" ry="60" />
        ),
        over: (
          // The brim: from just outside the head's left edge to just past the middle. It reached
          // 13 units past the head at first, which at 128px is a rectangle floating beside a face.
          <rect
            fill={accent}
            height="9"
            rx="4.5"
            width={shape.capW + 9}
            x={48 - shape.capW - 7}
            y={shape.capY - 5}
          />
        ),
      };
    case 2: {
      const y = crownY + 3;
      return {
        clipped: null,
        over: (
          <g>
            <path
              d={`M48 ${y}c-4 -6 -12 -7 -13 -1c-1 6 8 8 13 1Z`}
              fill={accent}
            />
            <path
              d={`M48 ${y}c4 -6 12 -7 13 -1c1 6 -8 8 -13 1Z`}
              fill={accent}
            />
            <circle cx="48" cy={y} fill={accent} r="3.4" />
          </g>
        ),
      };
    }
    case 3: {
      const left = 48 - shape.eyeGap / 2;
      const right = 48 + shape.eyeGap / 2;
      const r = Math.min(9, shape.eyeGap / 2 - 0.5);
      return {
        clipped: null,
        over: (
          <g fill="none" stroke={accent} strokeWidth="3">
            <circle cx={left} cy={shape.eyeY} r={r} />
            <circle cx={right} cy={shape.eyeY} r={r} />
            <path d={`M${left + r} ${shape.eyeY}H${right - r}`} />
          </g>
        ),
      };
    }
    case 4:
      return {
        clipped: null,
        over: (
          <g>
            <path
              d={`M48 ${crownY + 4}V${crownY - 7}`}
              stroke={accent}
              strokeLinecap="round"
              strokeWidth="3.4"
            />
            <circle cx="48" cy={crownY - 10} fill={accent} r="4" />
          </g>
        ),
      };
    case 5:
      return {
        clipped: null,
        over: (
          <g>
            <path
              d={`M48 ${crownY + 6}Q52 ${crownY - 1} 58 ${crownY - 3}`}
              fill="none"
              stroke={accent}
              strokeLinecap="round"
              strokeWidth="3"
            />
            <path
              d={`M58 ${crownY - 3}C60 ${crownY - 13} 70 ${crownY - 15} 78 ${crownY - 11}C74 ${crownY - 2} 63 ${crownY + 2} 58 ${crownY - 3}Z`}
              fill={accent}
            />
          </g>
        ),
      };
    case 6: {
      /*
       * ON THE HEAD, AND ON THE SIDE THE MARK DOES NOT OWN.
       *
       * It was `translate(79 15)`: a fixed point in the top-right of the box, ignoring the shape
       * under it. Measured on a roster card at 144px, a triangle wore its star a third of a box
       * from its apex, so it read as a badge pinned to the CARD rather than as anything on the
       * face — and at 36px in the sidebar it read as an unread dot. Worse, (79,15) is where the
       * blocked mark is drawn: a Bot that stopped to ask lost its star under the amber circle
       * entirely.
       *
       * Anchored to the shape now, like every other accessory in this table, and on the left,
       * because the top-right corner belongs to that mark. `Math.max` is for the triangle, whose
       * head is a point: proportional to `capW` alone it would sit inside the face.
       */
      const x = 48 - Math.max(13, shape.capW * 0.6);
      return {
        clipped: null,
        over: (
          <path
            d={STAR}
            fill={accent}
            stroke={accent}
            strokeLinejoin="round"
            strokeWidth="2.5"
            transform={`translate(${x} ${crownY + 3})`}
          />
        ),
      };
    }
    default:
      return { clipped: null, over: null };
  }
};

export const BotAvatar = ({
  seed,
  size,
  state = "idle",
  className,
}: {
  seed: string | undefined;
  size: number;
  /**
   * What this Bot is doing, where the surface knows. Idle everywhere else, which is a face that
   * blinks and breathes rather than a face that is switched off.
   */
  state?: BotAvatarState;
  className?: string;
}) => {
  /*
   * The clip path is referenced by url(#id), which is document-wide: two avatars sharing an id put
   * every face on the page inside the FIRST one's silhouette. `useId` is per instance.
   */
  const clip = useId().replace(/:/g, "");
  const {
    shape: shapeIndex,
    palette: paletteIndex,
    eyes,
    accessory,
  } = botAvatarParams(seed);
  const shape = BOT_AVATAR_SHAPES[shapeIndex] as BotAvatarShape;
  const palette = BOT_AVATAR_PALETTES[paletteIndex] as BotAvatarPalette;
  const parts = accessoryParts(shape, palette, accessory);

  const left = 48 - shape.eyeGap / 2;
  const right = 48 + shape.eyeGap / 2;
  const animated = size >= ANIMATION_FLOOR_PX;

  return (
    <svg
      aria-hidden="true"
      className={`bot-avatar bot-avatar-phase-${botAvatarPhase(seed)}${className ? ` ${className}` : ""}`}
      data-bot-state={animated ? state : undefined}
      focusable="false"
      height={size}
      viewBox="0 0 96 96"
      width={size}
    >
      <defs>
        <clipPath id={`${clip}c`}>
          <path d={shape.d} />
        </clipPath>
        {/*
         * THE DEPTH IS A GRADIENT, AND THE FIRST VERSION WAS NOT.
         *
         * It was one soft ellipse of the shade colour cut to the body, on the argument that a
         * gradient was extravagance. On screen the ellipse's own edge was a horizon: a visible line
         * across the middle of the pill, the hexagon and the triangle, with the cheeks sitting on
         * it looking like bumps in the outline. A two-stop linear gradient has no edge, is still
         * one paint, and needs no filter — which was the constraint that actually mattered.
         */}
        <linearGradient id={`${clip}s`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0.4" stopColor={palette.shade} stopOpacity="0" />
          <stop offset="1" stopColor={palette.shade} stopOpacity="0.62" />
        </linearGradient>
      </defs>
      <g className="bot-avatar-body">
        <path d={shape.d} fill={palette.fill} />
        <g clipPath={`url(#${clip}c)`}>
          <rect fill={`url(#${clip}s)`} height="96" width="96" x="0" y="0" />
          {/* Below the eyes and outside them, where a cheek is. Faint: at 20px this is one pixel
           * of warmth, and anything stronger reads as a smudge rather than as a face. */}
          <ellipse
            cx={left - 7}
            cy={shape.eyeY + 9}
            fill={palette.shade}
            opacity="0.4"
            rx="5.5"
            ry="3.4"
          />
          <ellipse
            cx={right + 7}
            cy={shape.eyeY + 9}
            fill={palette.shade}
            opacity="0.4"
            rx="5.5"
            ry="3.4"
          />
          {parts.clipped}
        </g>
        <g className="bot-avatar-eyes">
          {/* Widened as an SVG attribute, not as CSS, so the class above keeps its animation. */}
          <g
            transform={
              state === "blocked"
                ? `translate(48 ${shape.eyeY}) scale(1.14) translate(-48 ${-shape.eyeY})`
                : undefined
            }
          >
            <Eyes
              eyes={eyes}
              happy={state === "done"}
              palette={palette}
              shape={shape}
            />
          </g>
        </g>
        {state === "blocked"
          ? [left, right].map((cx) => (
              <path
                d={`M${cx - 6} ${shape.eyeY - 12}q6 -4 12 0`}
                fill="none"
                key={cx}
                stroke={palette.ink}
                strokeLinecap="round"
                strokeWidth="3"
              />
            ))
          : null}
        {parts.over}
        {state === "blocked" ? (
          <g className="bot-avatar-mark">
            <circle cx="76" cy="18" fill={ALERT} r="10" />
            <rect
              fill="#ffffff"
              height="7.5"
              rx="1.4"
              width="2.8"
              x="74.6"
              y="12"
            />
            <circle cx="76" cy="23" fill="#ffffff" r="1.7" />
          </g>
        ) : null}
      </g>
    </svg>
  );
};
