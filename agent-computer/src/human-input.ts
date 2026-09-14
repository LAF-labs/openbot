/**
 * A person's input, by pixel: `/human/click`, `/human/type`, `/human/key` and `/human/scroll`.
 *
 * The Bot addresses elements by reference because it reads a list; a person addresses them by
 * pointing, because they are looking at a picture. Different problem, different endpoint, and only
 * usable while they hold the wheel.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
import type { Page } from "playwright";
import type { BotRoute } from "./computer";
import { TAKE_CONTROL_FIRST } from "./control";
import { VIEWPORT } from "./profiles";
import {
  bodyOf,
  browserFailed,
  fact,
  invalid,
  json,
  RequestInvalidError,
} from "./respond";

export const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RequestInvalidError("point");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") throw new RequestInvalidError("text");
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new RequestInvalidError("key");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/** `POST /human/*`, while the person holds the wheel and at no other time. */
export const humanInput: BotRoute = async (
  { request, url, botId, session },
  { profiles },
) => {
  if (!session.control.humanMayDrive()) return fact(TAKE_CONTROL_FIRST);
  const body = await bodyOf<Record<string, unknown>>(request);
  try {
    const target = await profiles.page(botId);
    return json(await performHumanInput(target, url.pathname, body ?? {}));
  } catch (error) {
    // A malformed input is the caller's, and a 400 — not the browser failing, which it used to be
    // reported as because the check was thrown from inside the input.
    if (error instanceof RequestInvalidError) return invalid(error.field);
    return browserFailed(error);
  }
};
