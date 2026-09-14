/**
 * What is at one point on the page, in the words a person would use for it.
 *
 * FOR TEACHING, and only for that. When somebody drives this browser to show a Bot how a task
 * is done, what arrives over the socket is `click at (412, 338)` — a fact about one render of
 * one page at one window size, worth nothing the next time. This turns it into "the 주문 확인
 * button", which is what the demonstration is actually about.
 *
 * ITS OWN ENDPOINT rather than geometry added to the snapshot. A snapshot goes out on every
 * governed action a Bot takes, so a bounding box per element would make every one of those
 * payloads larger, forever, to serve a feature that runs while a person is teaching. This is
 * called on clicks during a demonstration and at no other time.
 *
 * Climbs to the nearest thing a person would name. The element under the cursor is as often as
 * not a `<span>` inside the button that was actually pressed, and "clicked a span" describes
 * nothing.
 */
import type { BotRoute } from "./computer";
import { arrivalNote, arrivalOf, fromDocument } from "./page-arrival";
import { bodyOf, browserFailed, fact, invalid, json } from "./respond";

/**
 * How long the page is given to name a point.
 *
 * The server's own wait for this is three seconds (`describePointOn`), after which the press is
 * recorded with no name; a question to a document that is not answering had no bound at all, and on
 * a tab whose next document was on its way this answered 502 at 29.1 s (measured 2026-09-14, image
 * built from dbc1c67) — long after the server had stopped listening.
 */
const DESCRIBE_WAIT_MS = 1_500;

/** `POST /describe-point`. */
export const describePoint: BotRoute = async (
  { request, botId },
  { profiles },
) => {
  const body = await bodyOf<{ x?: unknown; y?: unknown }>(request);
  if (typeof body?.x !== "number" || typeof body?.y !== "number") {
    return invalid("point");
  }
  try {
    const target = await profiles.page(botId);
    const asked = await fromDocument(
      target,
      DESCRIBE_WAIT_MS,
      target
        .evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const NAMED = new Set([
              "a",
              "button",
              "input",
              "select",
              "textarea",
              "label",
              "summary",
              "option",
            ]);
            const NAMED_ROLES = new Set([
              "button",
              "link",
              "checkbox",
              "radio",
              "menuitem",
              "tab",
              "option",
              "switch",
            ]);
            const under = document.elementFromPoint(x, y);
            if (!under) return null;
            /*
             * Climb to the nearest thing a person would name, and KEEP WHAT WAS UNDER THE CURSOR IF
             * THERE IS NONE. The first version returned nothing in that case, walking to `<html>`
             * and past it, so a click on a heading or a paragraph — most of a page — was recorded
             * as unnameable. Measured against a real page: ten points across the content, ten nulls.
             *
             * Five steps is enough to escape the usual span-inside-a-span-inside-a-button and few
             * enough that a click on the page background is not attributed to the whole document.
             */
            let node: Element | null = under;
            let named: Element | null = null;
            for (let step = 0; node && step < 5; step += 1) {
              const role = node.getAttribute("role") ?? "";
              const tag = node.tagName.toLowerCase();
              if (NAMED.has(tag) || NAMED_ROLES.has(role)) {
                named = node;
                break;
              }
              node = node.parentElement;
            }
            /*
             * The page is not a thing that was pressed. Falling back to whatever was under the
             * cursor is right for a heading or a paragraph and wrong for `<html>` and `<body>`,
             * whose text is the whole document — measured, a press on the background came back
             * named with the entire page. A press on nothing nameable is a real thing that happens,
             * and saying so is what lets the step be written as one.
             */
            const backdrop = under.tagName.toLowerCase();
            if (!named && (backdrop === "html" || backdrop === "body")) {
              return null;
            }
            const element = (named ?? under) as HTMLElement;
            /*
             * THE LABEL, NEVER THE TEXT ON THE PAGE.
             *
             * This is read while a person is demonstrating a task in their own browser, and what it
             * returns is written into the recording that a model is later asked to write up. It used
             * to fall back to eighty characters of the element's own `innerText`, which is whatever
             * the page happened to be showing at that point: a one-time code, an account number, a
             * balance. The recorder is built so that nothing anybody typed is ever kept
             * (`demonstration.ts`), and this was the same secret arriving by the other door — read
             * off the screen instead of off the keyboard.
             *
             * A label is an author's name for a control and does not carry somebody's data. Where
             * there is none, the press is recorded as a press with no name, which the recorder
             * already handles and which a person reading the draft can correct.
             */
            const label =
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("placeholder") ??
              element.getAttribute("alt") ??
              "";
            return {
              role:
                element.getAttribute("role") ?? element.tagName.toLowerCase(),
              name: label.replace(/\s+/g, " ").trim(),
            };
          },
          { x: body.x, y: body.y },
        )
        .then(
          (found) => ({ found }),
          (error: unknown) => ({ error }),
        ),
    );
    if (!asked) {
      /*
       * Nothing named, because nothing on the page answers: its next document is on its way, and the
       * press is a press with no name, which is the fact. Not drained from the Bot's notes — this
       * answer goes to the recorder, not to the Bot.
       */
      const arrival = arrivalOf(target);
      if (arrival)
        return json({ element: null, notes: [arrivalNote(arrival)] });
      return fact("laf:browser_failed");
    }
    if ("error" in asked) return browserFailed(asked.error);
    const { found } = asked;
    // Null rather than an invented name. A click on nothing nameable is a real thing that
    // happens — a canvas, a PDF, the page background — and saying so lets the step be written
    // as "clicked somewhere on this page" instead of as a confident lie.
    return json({ element: found?.name ? found : null });
  } catch (error) {
    return browserFailed(error);
  }
};
