import { describe, expect, test } from "bun:test";
import { askOutcome, PERSON_WAIT_MS } from "../../shared/person-wait";
import {
  ControlError,
  ControlRequestError,
  type ControlState,
  createControl,
  REQUEST_TTL_MS,
  restoredControl,
} from "../src/control";

/**
 * The wheel, tested on both paths.
 *
 * This is the piece standing between two drivers and one page, and until now it had no tests at all, * it lived as a `let` inside the file that imports playwright, so a test could not reach it without
 * launching Chrome. What is checked here is mostly the refusal path, because that is where this
 * component earns its keep: a Bot clicking while a person types, a secret typed when nothing asked for
 * one, a request answered twice, a handover that leaves a password box open behind it.
 *
 * A fake clock is injected so `since` can be asserted rather than shrugged at.
 */
function fixture() {
  let tick = 0;
  const at = () => `2026-08-14T00:00:0${tick}.000Z`;
  const control = createControl(() => {
    tick += 1;
    return at();
  });
  return { control };
}

describe("the happy path: ask, hand over, hand back", () => {
  test("starts with the Bot driving and nothing pending", () => {
    const { control } = fixture();
    const state = control.get();
    expect(state.holder).toBe("bot");
    expect(state.requested).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(control.pendingSecret()).toBeNull();
    // Nothing to refuse yet.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the Bot asking for help does NOT hand itself the human's authority", () => {
    const { control } = fixture();
    const state = control.requestHelp("There is a login wall.");
    // The flag is raised and a person decides. A Bot that could take control on its own behalf could
    // also hand a person a page they never asked to see.
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("There is a login wall.");
    expect(state.holder).toBe("bot");
    // And it may still act while it waits: asking is not being blocked.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("taking the wheel keeps the reason and lowers the flag", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    const state = control.take();
    expect(state.holder).toBe("human");
    // The reason survives, because it is the thing the person was just asked to do.
    expect(state.reason).toBe("Sign in to continue.");
    // The request is answered, so the surface stops asking.
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive()).toBe(true);
  });

  test("handing back returns the wheel and clears the old request", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    control.take();
    const state = control.release();
    expect(state.holder).toBe("bot");
    // Dropped on purpose: leaving it set has the surface still showing a request that was dealt with.
    expect(state.reason).toBeUndefined();
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive()).toBe(false);
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("`since` moves on a handover and not on a request", () => {
    const { control } = fixture();
    const created = control.get().since;
    control.requestHelp("Stuck.");
    // Asking for help is not a change of driver, so the clock does not restart.
    expect(control.get().since).toBe(created);
    expect(control.take().since).not.toBe(created);
  });
});

describe("the crappy paths: two drivers, one page", () => {
  test("the Bot is refused while a person holds the wheel", () => {
    const { control } = fixture();
    control.take();
    expect(() => control.assertBotMayAct()).toThrow(ControlError);
    /*
     * Refused with a FACT, not a sentence. The refusal used to carry the English paragraph the
     * model reads; that paragraph is now Korean and lives in `shared/prompt/tool-results.ko.ts`,
     * and this container ships the code that selects it. What this pins is that the code is the
     * one the prompt table answers — a refusal carrying a code nothing translates would reach a
     * person as `laf:` and a machine identifier.
     */
    expect(() => control.assertBotMayAct()).toThrow("laf:human_has_control");
  });

  test("the refusal lifts the moment the person hands back", () => {
    const { control } = fixture();
    control.take();
    control.release();
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("a person's input is not applied merely because they asked", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    // The Bot asked for help and no person has taken the wheel. An open socket is not permission: this is
    // what stops anything that can reach the port from driving the browser mid-task.
    expect(control.humanMayDrive()).toBe(false);
  });

  test("taking the wheel twice is not a way to lose the reason", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    control.take();
    const state = control.take();
    expect(state.holder).toBe("human");
    expect(state.reason).toBe("Sign in.");
  });

  test("handing back when the Bot already has it is harmless", () => {
    const { control } = fixture();
    const state = control.release();
    expect(state.holder).toBe("bot");
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the caller cannot reach in and change the state it was handed", () => {
    const { control } = fixture();
    const state = control.get();
    state.holder = "human";
    // A copy, so reading the state is not a way to take the wheel.
    expect(control.get().holder).toBe("bot");
  });

  test("junk reasons fall back to something a person can read", () => {
    const { control } = fixture();
    // The wire carries whatever the caller sent. An empty or non-string reason must not leave the
    // person staring at a blank explanation of why they have just been handed a browser.
    for (const junk of ["", "   ", null, undefined, 42, {}]) {
      const { control: fresh } = fixture();
      expect(fresh.requestHelp(junk).reason).toBe(
        "The assistant needs a person to continue.",
      );
    }
    expect(control.requestHelp("  Trimmed.  ").reason).toBe("Trimmed.");
  });
});

describe("the crappy paths: secrets", () => {
  test("a secret request must name the field it goes in", () => {
    const { control } = fixture();
    // The version without this typed the value into whatever happened to have focus, and reported
    // success when that was nothing at all.
    for (const bad of [{}, { ref: "" }, { ref: "   " }, { ref: 7 }]) {
      expect(() => control.requestSecret(bad)).toThrow(ControlRequestError);
    }
    // A request error, not a control refusal: the caller asked wrongly and no driver changed.
    expect(() => control.requestSecret({})).toThrow(/which field/);
    expect(control.pendingSecret()).toBeNull();
  });

  test("a secret request records the label and the field, and nothing else", () => {
    const { control } = fixture();
    const state = control.requestSecret({
      label: "  the six-digit code  ",
      ref: "e12",
      snapshotId: 3,
    });
    expect(state.secretWanted).toBe("the six-digit code");
    expect(state.secretRef).toBe("e12");
    expect(state.secretSnapshotId).toBe(3);
    expect(control.pendingSecret()).toEqual({ ref: "e12", snapshotId: 3 });
  });

  test("an unlabelled request still says something honest", () => {
    const { control } = fixture();
    expect(control.requestSecret({ ref: "e1" }).secretWanted).toBe(
      "the value this page is asking for",
    );
  });

  test("a non-numeric snapshotId is dropped rather than carried as junk", () => {
    const { control } = fixture();
    const state = control.requestSecret({ ref: "e1", snapshotId: "3" });
    // Carried through to `locateRef`, where a string would prevent the numeric staleness check from
    // matching and could let a stale field accept the secret.
    expect(state.secretSnapshotId).toBeUndefined();
  });

  test("nothing is pending until the Bot asks", () => {
    const { control } = fixture();
    // What makes the masked box scoped rather than a general-purpose way to type into the page.
    expect(control.pendingSecret()).toBeNull();
  });

  test("a supplied secret closes the request, so it cannot be answered twice", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretWanted).toBeUndefined();
    expect(control.get().secretRef).toBeUndefined();
  });

  test("a FAILED attempt leaves the request open", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    // `secretSupplied` is called only after the value reached the field, so a field that could not be
    // found leaves this pending and the person can try again instead of starting over.
    expect(control.pendingSecret()).not.toBeNull();
  });

  test("handing the wheel over or back closes any pending secret", () => {
    for (const handover of ["take", "release"] as const) {
      const { control } = fixture();
      control.requestSecret({ ref: "e12", label: "password" });
      control[handover]();
      // A person who drove the browser themselves has dealt with the login. A masked box still asking
      // for a password afterwards is asking for a secret nothing is waiting for.
      expect(control.pendingSecret()).toBeNull();
      expect(control.get().secretWanted).toBeUndefined();
    }
  });

  test("the secret VALUE is never anywhere in the state", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "one-time code" });
    // The machine has no field that could hold it, and this test exists to fail if one is ever added.
    // The value passes through a single request, into the page, and is not kept.
    const serialised = JSON.stringify(control.get());
    expect(serialised).not.toContain("value:");
    expect(
      Object.keys(control.get())
        .filter((k) => /secret/i.test(k))
        .sort(),
    ).toEqual(["secretRef", "secretSnapshotId", "secretWanted"]);
  });
});

/**
 * AN ASK NOBODY ANSWERED DOES NOT OUTLIVE THE TURN THAT MADE IT BY MUCH — AND NEVER ENDS INSIDE IT.
 *
 * The wheel belongs to the computer, not to a conversation, and an ask used to stand on it for ever:
 * measured before this, `requestHelp` and `requestSecret` were both still there with the clock moved
 * on eleven minutes — `requested: true`, the label, and `pendingSecret()` still naming the field. The
 * Bot went on showing 도움 필요 through every later conversation, and the masked box went on taking a
 * password for a turn that was over (upstream OpenBot #145 and #457).
 *
 * The edge these pin is the one upstream's ten minutes would get wrong HERE. The Bot's own wait is
 * ten minutes, and it reads an ask that is gone as the person having handed the wheel back. So the
 * ask has to stand through the whole of that wait and a little past it, and only then go.
 */
describe("an ask nobody answered", () => {
  const ASKED = Date.parse("2026-10-02T03:00:00.000Z");
  const SECOND = 1_000;

  function asking(onChange?: (state: ControlState) => void) {
    let elapsed = 0;
    const control = createControl(
      () => new Date(ASKED + elapsed).toISOString(),
      onChange ? { onChange } : {},
    );
    return {
      control,
      /** Move the clock to this long after the ask. */
      after: (ms: number) => {
        elapsed = ms;
      },
    };
  }

  test("stands for longer than the Bot waits, and only a little", () => {
    expect(REQUEST_TTL_MS).toBeGreaterThan(PERSON_WAIT_MS);
    // The server gives the ask's own answer, and the wait's last look, 45 s each at most.
    expect(REQUEST_TTL_MS - PERSON_WAIT_MS).toBeGreaterThanOrEqual(90 * SECOND);
    expect(REQUEST_TTL_MS).toBeLessThanOrEqual(PERSON_WAIT_MS * 1.5);
  });

  test("answered a second before the wait runs out, the wheel still changes hands and comes back", () => {
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    after(PERSON_WAIT_MS - SECOND);
    expect(control.get()).toMatchObject({
      holder: "bot",
      requested: true,
      reason: "네이버 로그인",
    });
    expect(control.take()).toMatchObject({
      holder: "human",
      reason: "네이버 로그인",
    });
    // What the Bot's wait reads as done: the wheel back, and nothing asked.
    expect(control.release()).toMatchObject({
      holder: "bot",
      requested: false,
    });
  });

  test("a value typed a second before the wait runs out still has its field", () => {
    const { control, after } = asking();
    control.requestSecret({ ref: "e12", label: "인증번호", snapshotId: 4 });
    after(PERSON_WAIT_MS - SECOND);
    expect(control.get().secretWanted).toBe("인증번호");
    expect(control.pendingSecret()).toEqual({ ref: "e12", snapshotId: 4 });
  });

  test("still stands when the Bot's wait gives up, so giving up is never read as a hand-back", () => {
    /*
     * THE TRAP. `nothing asked, the Bot holds the wheel` is what the waiting call reads as
     * `laf:control_returned`, and `no value wanted` as `laf:secret_entered`. Its last look is made
     * just before its own ten minutes are up, counted from after the ask was answered — so on this
     * clock it lands at ten minutes and some. An ask gone by then turns "nobody came" into "done".
     */
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    control.requestSecret({ ref: "e12", label: "인증번호" });
    for (const late of [0, 1, 45, 90]) {
      after(PERSON_WAIT_MS + late * SECOND);
      expect(control.get()).toMatchObject({
        requested: true,
        secretWanted: "인증번호",
      });
      expect(control.pendingSecret()).not.toBeNull();
    }
  });

  test("is gone once its time is up, and its reason with it", () => {
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    after(REQUEST_TTL_MS);
    expect(control.get().requested).toBe(true);

    after(REQUEST_TTL_MS + 1);
    const state = control.get();
    expect(state.requested).toBe(false);
    // The reason is what 도움 필요 was drawn with in the next conversation, so it goes too.
    expect(state.reason).toBeUndefined();
    expect(state.holder).toBe("bot");
  });

  test("a value stops being wanted, and takes the field it named with it", () => {
    const { control, after } = asking();
    control.requestSecret({ ref: "e12", label: "인증번호", snapshotId: 4 });
    after(REQUEST_TTL_MS + 1);
    const state = control.get();
    expect(state.secretWanted).toBeUndefined();
    expect(state.secretRef).toBeUndefined();
    expect(state.secretSnapshotId).toBeUndefined();
  });

  test("a value stops being answerable at the moment it stops being shown", () => {
    /*
     * Asked through `pendingSecret` alone, with no `get` before it. That is the call the masked
     * box's own door makes before it types (`control-routes.ts`): letting go only on the path the
     * surface polls would leave a box nobody is shown still able to take a password.
     */
    const { control, after } = asking();
    control.requestSecret({ ref: "e12", label: "인증번호" });
    after(REQUEST_TTL_MS + 1);
    expect(control.pendingSecret()).toBeNull();
  });

  test("never takes the wheel back from a person who holds it", () => {
    // The one thing that must not run out: somebody may be half-way through typing a code.
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    after(60 * SECOND);
    control.take();
    after(6 * 60 * 60 * SECOND);
    expect(control.get()).toMatchObject({
      holder: "human",
      reason: "네이버 로그인",
    });
    expect(control.humanMayDrive()).toBe(true);
  });

  test("asking again starts the time again, for each ask by itself", () => {
    // A Bot that asks twice waits twice, and the first ask's time must not run out under the second.
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    control.requestSecret({ ref: "e12", label: "인증번호" });
    after(PERSON_WAIT_MS);
    control.requestHelp("다시 로그인");

    after(REQUEST_TTL_MS + 1);
    const state = control.get();
    // The second ask is two minutes old; the value was asked for once, at the start.
    expect(state).toMatchObject({ requested: true, reason: "다시 로그인" });
    expect(state.secretWanted).toBeUndefined();

    after(PERSON_WAIT_MS + REQUEST_TTL_MS + 1);
    expect(control.get().requested).toBe(false);
  });

  test("a fresh ask after one that ran out is shown, not swallowed by it", () => {
    // What ran out must take its own bookkeeping with it, or the next ask is stale on arrival.
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    control.requestSecret({ ref: "e12", label: "인증번호" });
    after(REQUEST_TTL_MS + 1);
    expect(control.get().requested).toBe(false);
    expect(control.pendingSecret()).toBeNull();

    control.requestHelp("다시 로그인");
    control.requestSecret({ ref: "e40", label: "인증번호 다시" });
    expect(control.get()).toMatchObject({
      requested: true,
      reason: "다시 로그인",
      secretWanted: "인증번호 다시",
    });
    expect(control.pendingSecret()).toEqual({
      ref: "e40",
      snapshotId: undefined,
    });
  });

  test("a person who takes the wheel after it ran out is not handed its reason", () => {
    // With no look in between: taking the wheel is itself the next look.
    const { control, after } = asking();
    control.requestHelp("네이버 로그인");
    after(REQUEST_TTL_MS + 1);
    const state = control.take();
    expect(state.holder).toBe("human");
    expect(state.reason).toBeUndefined();
  });

  test("whoever keeps the state is told once, when it runs out, and not by a look before that", () => {
    /*
     * What is written to `control.json`. A file that went on saying a value was wanted would have
     * the next life of this process tell the Bot its request was lost (`restoredControl`) — about an
     * ask that had only run out, in some conversation long after.
     */
    const kept: ControlState[] = [];
    const { control, after } = asking((state) => kept.push(state));
    control.requestHelp("네이버 로그인");
    control.requestSecret({ ref: "e12", label: "인증번호" });
    expect(kept).toHaveLength(2);

    after(PERSON_WAIT_MS);
    control.get();
    control.pendingSecret();
    expect(kept).toHaveLength(2);

    after(REQUEST_TTL_MS + 1);
    control.get();
    control.get();
    control.pendingSecret();
    expect(kept).toHaveLength(3);
    expect(restoredControl(JSON.parse(JSON.stringify(kept[2])))).toEqual({
      secretLost: false,
    });
    expect(kept[2]).toMatchObject({ holder: "bot", requested: false });
  });
});

/**
 * AN ASK WHOSE TAB WENT FROM UNDER THE BOT (2026-10-05).
 *
 * The one ask the computer ends in the middle of the Bot's wait: a value wanted for a box on a tab
 * whose renderer has died, or a hand for a page its site has closed. Left standing, the masked box
 * took a person's password into whatever the Bot's other tab called that ref
 * (`tests/crashed-tab.test.ts`). And an ask that is gone is read as one that was answered, so the
 * state has to say this one was not (`shared/person-wait.ts`, `askOutcome`).
 */
describe("an ask whose tab is gone", () => {
  test("ends, both kinds, as nobody's answer — and the value's door closes with it", () => {
    const { control } = fixture();
    control.requestHelp("네이버 로그인");
    control.requestSecret({ ref: "e7", label: "비밀번호", snapshotId: 4 });

    expect(control.tabLost()).toBe(true);

    const state = control.get();
    expect(state).toMatchObject({
      holder: "bot",
      requested: false,
      unanswered: true,
    });
    expect(state.reason).toBeUndefined();
    expect(state.secretWanted).toBeUndefined();
    expect(state.secretRef).toBeUndefined();
    expect(control.pendingSecret()).toBeNull();
    // What a wait reads, either kind: the ask is gone, and nobody came.
    expect(askOutcome(state)).toBe("gave up");
  });

  test("with nothing asked changes nothing, and marks nothing as unanswered", () => {
    const kept: ControlState[] = [];
    const control = createControl(undefined, {
      onChange: (state) => kept.push(state),
    });
    expect(control.tabLost()).toBe(false);
    expect(kept).toEqual([]);
    expect(control.get().unanswered).toBeUndefined();
    expect(askOutcome(control.get())).toBe("answered");
  });

  test("never takes the wheel from a person who holds it", () => {
    const { control } = fixture();
    control.requestHelp("네이버 로그인");
    control.take();
    expect(control.tabLost()).toBe(false);
    // Still theirs, with what they were asked to do: they are looking at the screen.
    expect(control.get()).toMatchObject({
      holder: "human",
      reason: "네이버 로그인",
    });
    expect(control.get().unanswered).toBeUndefined();
  });

  test("is forgotten by the next ask, which is waited on afresh", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e7", label: "비밀번호" });
    control.tabLost();

    control.requestSecret({ ref: "e3", label: "비밀번호 다시" });
    expect(control.get().unanswered).toBeUndefined();
    control.secretSupplied();
    expect(askOutcome(control.get())).toBe("answered");

    control.requestHelp("다시 로그인");
    control.tabLost();
    control.requestHelp("한 번 더");
    expect(control.get()).toMatchObject({
      requested: true,
      reason: "한 번 더",
    });
    expect(control.get().unanswered).toBeUndefined();
    // And a hand-over or a hand-back says nothing of an old ask either.
    control.tabLost();
    expect(control.take().unanswered).toBeUndefined();
    expect(control.release().unanswered).toBeUndefined();
  });

  test("is written down, and the next life of the process does not call it a lost request", () => {
    const kept: ControlState[] = [];
    const control = createControl(undefined, {
      onChange: (state) => kept.push(state),
    });
    control.requestSecret({ ref: "e7", label: "비밀번호" });
    control.tabLost();
    expect(kept).toHaveLength(2);
    // The Bot was told when its wait ended; a restart has nothing to add.
    const restored = restoredControl(JSON.parse(JSON.stringify(kept[1])));
    expect(restored.secretLost).toBe(false);
    expect(restored.state).toBeUndefined();
  });
});
