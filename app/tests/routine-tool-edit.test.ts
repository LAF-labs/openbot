import { describe, expect, test } from "bun:test";
import { MANAGE_ROUTINE } from "../../shared/tools/self";

/**
 * `manage_routine` changing a routine that already exists. 2026-09-18.
 *
 * "매일 7시 반 루틴 8시로 바꿔 줘" had no answer but delete and create: `update` reached the on/off
 * switch and nothing else, the tool's description said so, and a Bot that did the rewrite that way
 * lost the routine's history, notepad and webhook on the way. It edits in place now, names the
 * routine by id or by its exact name, sees its own routines with `list`, and reaches no routine on
 * any other Bot.
 *
 * What the tool SAYS OF ITSELF is here, because the window offers it to the turn as this object.
 * What it DOES was here too, against the handler the window ran; the server carries the call out
 * and those tests are in `server/tests/chat-tools.test.ts` since the window-driven path was
 * removed (2026-10-05).
 */

describe("the tool's own description", () => {
  test("says a routine is changed in place, not deleted and made again", () => {
    expect(MANAGE_ROUTINE.description).not.toContain("지우고 새로 만든다");
    expect(MANAGE_ROUTINE.description).toContain("고친다");
    const action = (
      MANAGE_ROUTINE.parameters.properties as Record<
        string,
        { enum?: string[]; description?: string }
      >
    ).action;
    expect(action?.enum).toEqual(["create", "list", "update", "delete"]);
  });

  test("is no larger than it was before it grew the summary", () => {
    /*
     * Every tool rides in front of every turn (CLAUDE.md, the footprint ladder). `summary` was
     * paid for by trimming the other descriptions; 1,399 characters is what the tool measured on
     * 2026-09-24 before it, and a description that creeps past it has to say why.
     */
    const serialised = JSON.stringify({
      name: MANAGE_ROUTINE.name,
      description: MANAGE_ROUTINE.description,
      parameters: MANAGE_ROUTINE.parameters,
    });
    expect(serialised.length).toBeLessThanOrEqual(1399);
  });

  test("offers no field that reaches keep-running, the Bot, or the review rule", () => {
    const fields = Object.keys(
      MANAGE_ROUTINE.parameters.properties as Record<string, unknown>,
    );
    // `summary` is the person's line on the Routines screen (UI/UX audit 0.5.3, item 8): words,
    // like the instruction, and nothing that decides whether the routine runs or is asked about.
    expect(fields.sort()).toEqual([
      "action",
      "enabled",
      "instruction",
      "name",
      "routineId",
      "schedule",
      "summary",
    ]);
  });
});
