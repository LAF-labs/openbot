/**
 * Which controls of a look's list carry a mark the page put on an element.
 *
 * THE PAGE KNOWS WHICH ELEMENTS, AND THE LIST KNOWS WHICH REFS. What a person typed into is marked on
 * the node (`secret-fields.ts`), and the page says in one answer which elements matter and where
 * each is drawn (`scanTyped`) — but a ref resolves only through a locator, one at a time, and only
 * in the world the tree was taken in (`page-names.ts`). So the controls drawn where the page said a
 * marked element is are asked first — each control comes with its box as the tree wrote it — and
 * when that finds as many as the page counted, nothing else is asked: on a page where a person
 * typed into a search box and nothing draws on it, that is no question at all. When it finds fewer
 * — a control that moved between the tree and the count, or one the list does not keep — every
 * other control is asked the same thing, all at once.
 *
 * EVERY DEFAULT HERE IS THE CLOSED ONE. A control that does not answer, a ref that names nothing
 * any more, a look with no time left to ask: each is taken to carry the mark. What that costs is
 * the name or the contents of the controls that might have held what a person typed; what the open
 * default would cost is that typing, in a tool result.
 */
import type { Locator, Page } from "playwright";
import { fromDocument } from "./page-arrival";

/** A control of the list, with where the tree says it is drawn when the tree was taken with boxes. */
export type Control = { ref: string; box?: string };

/** Where the page says the marked elements are drawn, and how many of them there are. */
type Drawn = { boxes: ReadonlySet<string>; expected: number };

/**
 * What each control said to `question`, for the controls that said something or said nothing in
 * time: `""` answers are left out, and `undefined` is a control that did not answer.
 */
async function boxFirst(
  target: Page,
  kept: readonly Control[],
  drawn: Drawn,
  ms: number,
  question: (control: Locator, timeout: number) => Promise<string>,
): Promise<Map<string, string | undefined>> {
  const said = new Map<string, string | undefined>();
  if (drawn.expected === 0) return said;
  if (ms <= 0) {
    // No time to ask is not an answer that nothing carries it.
    for (const { ref } of kept) said.set(ref, undefined);
    return said;
  }
  const until = Date.now() + ms;
  const ask = async (controls: readonly Control[]): Promise<number> => {
    const answers = await Promise.all(
      controls.map(({ ref }) => {
        const left = until - Date.now();
        if (left <= 0) return undefined;
        return fromDocument(
          target,
          left,
          question(target.locator(`aria-ref=${ref}`), left).catch(
            () => undefined,
          ),
        );
      }),
    );
    let carrying = 0;
    controls.forEach(({ ref }, index) => {
      const answer = answers[index];
      if (answer === "") return;
      said.set(ref, answer);
      if (answer !== undefined) carrying += 1;
    });
    return carrying;
  };
  const drawnThere = kept.filter(
    (control) => control.box !== undefined && drawn.boxes.has(control.box),
  );
  if ((await ask(drawnThere)) >= drawn.expected) return said;
  const asked = new Set(drawnThere.map((control) => control.ref));
  await ask(kept.filter((control) => !asked.has(control.ref)));
  return said;
}

/**
 * Which of a look's two scans marked this element near a node a person typed into: `a` for the one
 * before the tree (alone or with the other), `b` for the one after only, nothing for neither.
 * Runs in the page, on that element; `packed` is the mark and the two tokens.
 */
function nearBy(node: Element, packed: string): string {
  const [mark = "", before = "", after = ""] = packed.split("|");
  const held = (node as unknown as Record<symbol, unknown>)[Symbol.for(mark)];
  const tokens = typeof held === "string" ? held.split(" ") : [];
  if (before && tokens.includes(before)) return "a";
  return after && tokens.includes(after) ? "b" : "";
}

/**
 * The controls of the list that could take their name from a node a person typed into.
 *
 * `before`: near one when the tree was about to be taken, or not answering. The name the tree read
 * for such a control is not to be trusted whatever the page says of it now — its region may have
 * gone in between — so it is listed under the page's name or under none, and without its contents
 * (`namesToList`). `after`: near one now and not before; the page says whether its name is drawn
 * from it.
 */
export async function nearRefs(
  target: Page,
  kept: readonly Control[],
  near: Drawn & { mark: string; tokens: readonly string[] },
  ms: number,
): Promise<{ before: Set<string>; after: Set<string> }> {
  const [first = "", second = ""] =
    near.tokens.length > 1 ? near.tokens : ["", near.tokens[0] ?? ""];
  const packed = `${near.mark}|${first}|${second}`;
  const said = await boxFirst(target, kept, near, ms, (control, timeout) =>
    control.evaluate(nearBy, packed, { timeout }),
  );
  const before = new Set<string>();
  const after = new Set<string>();
  for (const [ref, answer] of said) (answer === "b" ? after : before).add(ref);
  return { before, after };
}

/** Whether an element is a node a person typed into. Runs in the page, on that element. */
function typedInto(node: Element, mark: string): string {
  return (node as unknown as Record<symbol, unknown>)[Symbol.for(mark)] === true
    ? "1"
    : "";
}

/** The boxes of the list that are nodes a person typed into, or that did not say. */
export async function typedRefs(
  target: Page,
  kept: readonly Control[],
  typed: Drawn & { mark: string },
  ms: number,
): Promise<Set<string>> {
  const said = await boxFirst(target, kept, typed, ms, (control, timeout) =>
    control.evaluate(typedInto, typed.mark, { timeout }),
  );
  return new Set(said.keys());
}
