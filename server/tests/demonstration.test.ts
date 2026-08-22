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
    const written = JSON.stringify(recorder.read("bot-1"));
    expect(written).not.toContain("s3cret");
    expect(written).not.toContain("passw0rd");
    expect(written).toContain("아이디");
  });

  test("that typing happened, and where, once per run", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    for (const message of LOGIN) recorder.observe("bot-1", message);

    const kinds = recorder.read("bot-1")?.steps.map((step) => step.kind);
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
    const keys = (recorder.read("bot-1")?.steps ?? [])
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
    expect(recorder.read("bot-1")?.steps).toEqual([
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
    expect(recorder.read("bot-1")?.steps).toHaveLength(1);
  });

  test("only the press, not the release", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "mouse", event: "pressed", x: 1, y: 1 });
    recorder.observe("bot-1", { type: "mouse", event: "released", x: 1, y: 1 });
    recorder.observe("bot-1", { type: "mouse", event: "moved", x: 2, y: 2 });
    expect(recorder.read("bot-1")?.steps).toHaveLength(1);
  });
});

describe("what a demonstration refuses", () => {
  test("anything at all when nobody is being taught", () => {
    const recorder = recorderWith(null);
    // Taking the wheel to fix something is not teaching, and the input that follows is nobody's
    // business. Recording is entered by its own door.
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    expect(recorder.read("bot-1")).toBeNull();
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
    expect(recorder.read("bot-1")?.steps).toHaveLength(3);
  });

  test("more input after the wheel goes back", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    const finished = recorder.finish("bot-1");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Escape" });
    expect(finished?.finished).toBe(true);
    expect(recorder.read("bot-1")?.steps).toHaveLength(1);
    expect(recorder.recording("bot-1")).toBe(false);
  });

  test("to survive being thrown away", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-1", { type: "key", event: "down", key: "Enter" });
    recorder.discard("bot-1");
    // What somebody decides not to keep stops existing. There is no bin.
    expect(recorder.read("bot-1")).toBeNull();
  });

  test("one Bot's demonstration into another's", () => {
    const recorder = recorderWith(null);
    recorder.start("bot-1", "boss");
    recorder.observe("bot-2", { type: "key", event: "down", key: "Enter" });
    expect(recorder.read("bot-1")?.steps).toEqual([]);
    expect(recorder.read("bot-2")).toBeNull();
  });
});
