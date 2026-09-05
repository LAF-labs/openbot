import { useEffect, useId, useRef } from "react";
import { botAvatarParams } from "@/lib/avatar/bot-avatar";
import {
  type AvatarEngine,
  createAvatarEngine,
  type EngineState,
  isEngineState,
} from "@/lib/avatar/grok-engine";
import { bodyShape, CENTRE } from "@/lib/avatar/grok-shapes";

/**
 * A Bot's face.
 *
 * A single-coloured body with two eyes cut out of it — the eyes are the page showing through, which
 * is why they are dark on a dark page and light on a light one without anybody choosing. The body
 * is one of Grok Bot's eighteen; the motion is Grok Bot's engine (`grok-engine.ts`); the only thing
 * this component owns is the SVG the engine drives and when to let it run.
 *
 * WHEN IT RUNS. The engine is a frame loop, and a roster is several of these at once, so a face runs
 * only while it is on screen (an `IntersectionObserver` pauses one that scrolled away) and never
 * under `prefers-reduced-motion` (one still frame, in the mood's opening expression). A `paused`
 * caller — the picker's rows of thirty tiles — draws one frame and stops.
 */

export type BotAvatarState =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "asleep"
  | EngineState;

/** The app's five words for what a Bot is doing, in the engine's vocabulary. */
export const engineStateFor = (state: BotAvatarState): EngineState => {
  switch (state) {
    case "blocked":
      return "notifying";
    case "done":
      return "happy";
    case "asleep":
      return "sleeping";
    default:
      return isEngineState(state) ? state : "idle";
  }
};

const VIEW_BOX = "-15 -15 259 259";

const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const BotAvatar = ({
  seed,
  size,
  state = "idle",
  className,
  paused = false,
}: {
  seed: string | undefined;
  size: number;
  /** What this Bot is doing, where the surface knows. Idle is a face that breathes and blinks. */
  state?: BotAvatarState;
  className?: string;
  /** Draw once and hold still — for a row of tiles somebody is comparing. */
  paused?: boolean;
}) => {
  const clip = useId().replace(/:/g, "");
  const { shape: shapeId, palette } = botAvatarParams(seed);
  const shape = bodyShape(shapeId);
  const engineState = engineStateFor(state);

  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const rightRef = useRef<SVGPathElement>(null);
  const badgeRef = useRef<SVGCircleElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  // What the engine should currently show, readable from the one-time mount effect below.
  const wanted = useRef({ state: engineState, shape: shapeId, paused });
  wanted.current = { state: engineState, shape: shapeId, paused };

  useEffect(() => {
    const body = bodyRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!body || !left || !right) return;
    const engine = createAvatarEngine({
      shape: bodyShape(wanted.current.shape),
      state: wanted.current.state,
      elements: { body, eyes: [left, right], badge: badgeRef.current },
      reduceMotion: reducedMotion(),
    });
    engineRef.current = engine;
    engine.setPaused(wanted.current.paused);
    engine.start();

    // A face that scrolled off the roster stops moving until it is back.
    const svg = svgRef.current;
    let observer: IntersectionObserver | null = null;
    if (svg && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        engine.setPaused(wanted.current.paused || !visible);
      });
      observer.observe(svg);
    }
    return () => {
      observer?.disconnect();
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setState(engineState);
  }, [engineState]);

  useEffect(() => {
    engineRef.current?.setShape(bodyShape(shapeId));
  }, [shapeId]);

  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  return (
    <svg
      aria-hidden="true"
      className={`bot-avatar bot-avatar-color-${palette}${className ? ` ${className}` : ""}`}
      data-bot-state={engineState}
      height={size}
      ref={svgRef}
      viewBox={VIEW_BOX}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clip}>
          <path d={shape.path} />
        </clipPath>
      </defs>
      <g
        ref={bodyRef}
        transform={`translate(${CENTRE} ${CENTRE}) translate(${-CENTRE} ${-CENTRE})`}
      >
        <path className="bot-avatar-body" d={shape.path} />
        <g clipPath={`url(#${clip})`}>
          <path className="bot-avatar-eye" ref={leftRef} />
          <path className="bot-avatar-eye" ref={rightRef} />
        </g>
        <circle
          className="bot-avatar-badge"
          cx={CENTRE}
          cy={CENTRE}
          r={0}
          ref={badgeRef}
          visibility="hidden"
        />
      </g>
    </svg>
  );
};
