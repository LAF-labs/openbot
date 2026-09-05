import { describe, expect, test } from "bun:test";
import {
  createDemonstrationRecorder,
  type DemonstrationStep,
} from "../src/computer/demonstration";

/**
 * The recorder sits in the middle of somebody's live typing in a browser they are signed in to.
 *
 * So the tests that matter are not "does it record a click". They are: does anything anybody typed
 * end up anywhere, and does a recorder that is having trouble ever slow down or break the thing a
 * person is doing. Both failures are silent and only one of them is recoverable.
 */

/** Everything the surface sends while somebody fills in a login form. */
const LOGIN = [
  { type: "mouse", event: "pressed", x: 100, y: 200, button: "left" },
  { type: "mouse", event: "released", x: 100, y: 200, button: "left" },
  { type: "key", event: "down", key: "h", code: "KeyH", text: "h" },
  { type: "key", event: "down", key: "u", code: "KeyU", text: "u" },
  { type: "key", event: "down", key: "n", code: "KeyN", text: "n" },
  { type: "key", event: "up", key: "n", code: "KeyN" },
  { type: "key", event: "down", key: "Tab", code: "Tab" },
  { type: "text", text: "s3cret-passw0rd" },
  { type: "key", event: "down", key: "Enter", code: "Enter" },
];

function recorderWith(name?: { role: string; name: string } | null) {
  return createDemonstrationRecorder({
    ...(name === undefined ? {} : { namePoint: async () => name }),
    now: () => 1,
  });
}

describe("what a demonstration keeps", () => {
  test("nothing anybody typed, anywhere in it", async () => {
    const recorder = recorderWith({ role: "input", name: "아이디" });
    recorder.start("bot-1", "boss");
    for (const message of LOGIN) recorder.observe("bot-1", message);
    await Promise.resolve();

    // The whole thing, serialised, must not contain the password or any character of the username.
    // Not "the field is absent" — the WHOLE RECORD, because a value that leaked into a label or a
    // key name would pass a narrower assertion and still be a password in a log.
    const written = JSON.stringify(recorder.read("bot-1", "boss"));
    expect(written).not.toContain("s3cret");
    expect(written).not.toContain("passw0rd");
    expect(written).toContain("아이디");
  });

  /**
   * NOR ANYTHING THE SCREEN WAS SHOWING, which is the same rule by the other door.
   *
   * `/describe-point` used to fall back to eighty characters of the clicked element's own
   * `innerText` when it had no label, and that text is whatever the page happened to be showing:
   * a one-time code, an account number, a balance. It arrived here as the element's `name` and went
   * straight into the recording a model is later asked to write up.
   *
   * It now returns role plus the author's label — aria-label, title, placeholder, alt — and null
   * when there is none (`agent-computer/src/index.ts`). These two pin the server's half of that:
   * whatever the namer says is what is kept, so a namer that has stopped reading page text produces
   * a record with no page text in it, and a press with no label is still a press.
   */
  test("nothing the screen was showing either, when a press has no label", async () => {
    const otp = "482913";
    // What the namer answers for an element whose only text is the code on screen: no aria-label,
    // no title, no placeholder — so no name at all.
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", {
      type: "mouse",
      event: "pressed",
      x: 210,
      y: 480,
    });
    await Promise.resolve();

    const written = JSON.stringify(recorder.read("bot-1", "boss"));
    expect(written).not.toContain(otp);
    // And the press is still in there. A procedure that skipped it would describe a task with a
    // hole in the middle.
    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
  });

  test("the author's label, where the page has one, and never the value beside it", async () => {
    const recorder = recorderWith({ role: "textbox", name: "인증번호" });
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "mouse", event: "pressed", x: 1, y: 1 });
    recorder.observe("bot-1", { type: "text", text: "482913" });
    await Promise.resolve();

    const written = JSON.stringify(recorder.read("bot-1", "boss"));
    expect(written).toContain("인증번호");
    expect(written).not.toContain("482913");
  });

  test("that typing happened, and where, once per run", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    for (const message of LOGIN) recorder.observe("bot-1", message);

    const kinds = recorder
      .read("bot-1", "boss")
      ?.steps.map((step) => step.kind);
    // One press, one run of typing, Tab, one more run (the paste), Enter. Forty keystrokes are one
    // fact about a form being filled in, not forty steps nobody will read.
    expect(kinds).toEqual(["pressed", "typed", "key", "typed", "key"]);
  });

  test("the named keys and none of the modifiers", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    for (const key of ["Shift", "Control", "Alt", "Meta", "Enter", "Escape"]) {
      recorder.observe("bot-1", { type: "key", event: "down", key });
    }
    const keys = (recorder.read("bot-1", "boss")?.steps ?? [])
      .filter(
        (step): step is Extract<DemonstrationStep, { kind: "key" }> =>
          step.kind === "key",
      )
      .map((step) => step.key);
    // Enter submits and Escape closes. A Shift on its own says nothing and would bury the rest.
    expect(keys).toEqual(["Enter", "Escape"]);
  });

  test("a press is kept even when nothing could name it", async () => {
    // A canvas, a PDF, the page background. The press happened, and a procedure that skipped it
    // would describe a task with a hole in the middle.
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "mouse", event: "pressed", x: 5, y: 5 });
    await Promise.resolve();
    expect(recorder.read("bot-1", "boss")?.steps).toEqual([
      { kind: "pressed", element: null, at: 1 },
    ]);
  });

  test("a namer that throws costs the step its name and nothing else", async () => {
    const recorder = createDemonstrationRecorder({
      namePoint: async () => {
        throw new Error("the page went away");
      },
      now: () => 1,
    });
    recorder.start("bot-1", "boss");
    // Nothing here may throw: this runs in the middle of somebody's live typing, and a recorder
    // that made the mouse stutter would be worse than no recorder at all.
    expect(() =>
      recorder.observe("bot-1", {
        type: "mouse",
        event: "pressed",
        x: 5,
        y: 5,
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
  });

  test("only the press, not the release", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "mouse", event: "pressed", x: 1, y: 1 });
    recorder.observe("bot-1", { type: "mouse", event: "released", x: 1, y: 1 });
    recorder.observe("bot-1", { type: "mouse", event: "moved", x: 2, y: 2 });
    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
  });
});

describe("what a demonstration refuses", () => {
  test("anything at all when nobody is being taught", () => {
    const recorder = recorderWith(null);
    // Taking the wheel to fix something is not teaching, and the input that follows is nobody's
    // business. Recording is entered by its own door.
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    expect(recorder.read("bot-1", "boss")).toBeNull();
    expect(recorder.recording("bot-1")).toBe(false);
  });

  test("more than it can hold, keeping the beginning", () => {
    const recorder = createDemonstrationRecorder({ now: () => 1, maxSteps: 3 });
    recorder.start("bot-1", "boss");
    for (let index = 0; index < 50; index += 1) {
      recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    }
    // Somebody who left the tab open and did their afternoon's work in it should not produce a
    // summary nobody can read. The start is the part that explains what the task was.
    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(3);
  });

  test("more input after the wheel goes back", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    const finished = recorder.finish("bot-1");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Escape" });
    expect(finished?.finished).toBe(true);
    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
    expect(recorder.recording("bot-1")).toBe(false);
  });

  test("to survive being thrown away", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    recorder.discard("bot-1", "boss");
    // What somebody decides not to keep stops existing. There is no bin.
    expect(recorder.read("bot-1", "boss")).toBeNull();
  });

  test("one Bot's demonstration into another's", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-2", { type: "key", event: "down", key: "Enter" });
    expect(recorder.read("bot-1", "boss")?.steps).toEqual([]);
    expect(recorder.read("bot-2", "boss")).toBeNull();
  });
});

/**
 * WHOSE IT IS.
 *
 * `startedBy` was recorded from the first version and read by nothing: `read` and `discard` took a
 * Bot's id alone, so every recording was legible to anybody with a session on the deployment — a
 * shop owner showing their Bot how the bank's transfer page works, listed step by step for a member
 * of staff who could also throw it away before it was written up. The asker is a parameter rather
 * than a check in the route because that is the version a later caller cannot forget to make.
 */
describe("whose a demonstration is", () => {
  test("the person who started it reads it, and nobody else does", async () => {
    const recorder = recorderWith({ role: "button", name: "이체" });
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "mouse", event: "pressed", x: 1, y: 1 });
    await Promise.resolve();

    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
    // The same answer as "nothing is being recorded", deliberately: telling the two apart would
    // say who is teaching which Bot to somebody who may not read the recording.
    expect(recorder.read("bot-1", "staff")).toBeNull();
  });

  test("a stranger's discard throws nothing away", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });

    recorder.discard("bot-1", "staff");

    expect(recorder.read("bot-1", "boss")?.steps).toHaveLength(1);
    recorder.discard("bot-1", "boss");
    expect(recorder.read("bot-1", "boss")).toBeNull();
  });

  test("handing back is not scoped, because one wheel means one driver", () => {
    // A recording left open by somebody who has walked away goes on collecting whatever happens
    // next, so whoever ends the takeover ends the showing.
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    expect(recorder.finish("bot-1")?.startedBy).toBe("boss");
    expect(recorder.recording("bot-1")).toBe(false);
  });
});
