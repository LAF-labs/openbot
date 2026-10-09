import { describe, expect, test } from "bun:test";
import { askOutcome, PERSON_WAIT_MS } from "../../shared/person-wait";
import {
  ControlRequestError,
  type ControlState,
  createControl,
  REQUEST_TTL_MS,
  restoredControl,
} from "../src/control";

/**
 * The Bot's asks, tested on both paths.
 *
 * It lived as a `let` inside the file that imports playwright until it had tests, so a test could
 * not reach it without launching Chrome. What is checked here is mostly the refusal path, because
 * that is where this component earns its keep: a secret typed when nothing asked for one, a request
 * answered twice, an answer that leaves a password box open behind it. Until 2026-10-09 it also
 * stood between two drivers and one page; nobody but the Bot drives now, and the tests of a person
 * holding the wheel went with it.
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

describe("the happy path: ask, and answer", () => {
  test("starts with the Bot's and nothing pending", () => {
    const { control } = fixture();
    const state = control.get();
    expect(state.holder).toBe("bot");
    expect(state.requested).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(control.pendingSecret()).toBeNull();
  });

  test("the Bot asking for help raises the flag and hands nobody anything", () => {
    const { control } = fixture();
    const state = control.requestHelp("There is a login wall.");
    // The flag is raised and a person answers. The browser stays the Bot's throughout.
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("There is a login wall.");
    expect(state.holder).toBe("bot");
  });

  test("an answer clears the old request", () => {
    const { control } = fixture();
    control.requestHelp("Approve the sign-in on your phone.");
    const state = control.release();
    expect(state.holder).toBe("bot");
    // Dropped on purpose: leaving it set has the surface still showing a request that was dealt with.
    expect(state.reason).toBeUndefined();
    expect(state.requested).toBe(false);
  });

  test("`since` moves on an answer and not on a request", () => {
    const { control } = fixture();
    const created = control.get().since;
    control.requestHelp("Stuck.");
    // Asking for help is not an answer, so the clock does not restart.
    expect(control.get().since).toBe(created);
    expect(control.release().since).not.toBe(created);
  });
});

describe("the crappy paths: asks", () => {
  test("an answer when nothing was asked is harmless", () => {
    const { control } = fixture();
    const state = control.release();
    expect(state.holder).toBe("bot");
    expect(state.requested).toBe(false);
  });

  test("the caller cannot reach in and change the state it was handed", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    const state = control.get();
    state.requested = false;
    state.reason = "something else";
    // A copy, so reading the state is not a way to answer the ask.
    expect(control.get()).toMatchObject({
      requested: true,
      reason: "Sign in.",
    });
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

  test("an answer closes any pending secret", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "password" });
    // 건너뛰기 on the masked box: the person said go on without it. A box still asking for a
    // password afterwards is asking for a secret nothing is waiting for.
    control.release();
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretWanted).toBeUndefined();
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
 * An ask belongs to the computer, not to a conversation, and it used to stand there for ever:
 * measured before this, `requestHelp` and `requestSecret` were both still there with the clock moved
 * on eleven minutes — `requested: true`, the label, and `pendingSecret()` still naming the field. The
 * Bot went on showing 도움 필요 through every later conversation, and the masked box went on taking a
 * password for a turn that was over (upstream OpenBot #145 and #457).
 *
 * The edge these pin is the one upstream's ten minutes would get wrong HERE. The Bot's own wait is
 * ten minutes, and it reads an ask that is gone as the person having answered it. So the ask has to
 * stand through the whole of that wait and a little past it, and only then go.
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

  test("answered a second before the wait runs out, the ask is still there to answer", () => {
    const { control, after } = asking();
    control.requestHelp("휴대폰에서 로그인 승인");
    after(PERSON_WAIT_MS - SECOND);
    expect(control.get()).toMatchObject({
      holder: "bot",
      requested: true,
      reason: "휴대폰에서 로그인 승인",
    });
    // What the Bot's wait reads as done: nothing asked, and nothing marked unanswered.
    const answered = control.release();
    expect(answered).toMatchObject({ holder: "bot", requested: false });
    expect(askOutcome(answered)).toBe("answered");
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
     * THE TRAP. `nothing asked` is what the waiting call reads as `laf:control_returned`, and `no value wanted` as `laf:secret_entered`. Its last look is made
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
    // And an answer says nothing of an old ask either.
    control.tabLost();
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

describe("a value that could not be put in its field", () => {
  /*
   * The route closes the ask when typing the value fails — the field is gone, and a person would
   * retype their password into a dead ref for ever. It closed it with `secretSupplied`, and an ask
   * that is simply gone is read by the Bot's wait as a value that was typed (2026-10-05).
   */
  test("closes the ask as nobody's answer, where a value that went in closes it as one", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e7", label: "비밀번호", snapshotId: 4 });
    control.secretNotSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretWanted).toBeUndefined();
    expect(control.get().secretRef).toBeUndefined();
    expect(askOutcome(control.get())).toBe("gave up");

    // The same ask, answered: gone the same way, and read as answered.
    control.requestSecret({ ref: "e7", label: "비밀번호", snapshotId: 5 });
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(askOutcome(control.get())).toBe("answered");
  });
});

/**
 * A CALLER THAT STOPPED TAKES BACK ITS OWN ASK FOR A VALUE, AND NOTHING ELSE.
 *
 * The server used to let go of the whole state with a person's own door, `release`, which ends a
 * hand another turn is waiting on as well and marks neither: that turn was told the person had
 * done it (Codex's second read of the change that began taking asks back, 2026-10-10).
 */
describe("a value whose caller stopped before anybody answered", () => {
  const ASK = { label: "네이버 비밀번호", ref: "e7", snapshotId: 4 };

  test("is taken back as nobody's answer, and a hand somebody else asked for stays asked", () => {
    const control = createControl();
    control.requestHelp("네이버 앱에서 로그인 승인을 눌러 주세요.");
    control.requestSecret(ASK);

    expect(control.withdrawSecret({ ref: "e7", snapshotId: 4 })).toBe(true);
    const state = control.get();
    expect(control.pendingSecret()).toBeNull();
    expect(state.secretWanted).toBeUndefined();
    // The hand is still asked for, in its own words, and its waiter still waits.
    expect(state).toMatchObject({
      requested: true,
      reason: "네이버 앱에서 로그인 승인을 눌러 주세요.",
    });
    // And answered by a person afterwards, it reads as answered — not as given up on.
    control.release();
    expect(askOutcome(control.get())).toBe("answered");

    // What the person's own door does, for contrast: both asks, at once.
    const both = createControl();
    both.requestHelp("x");
    both.requestSecret(ASK);
    both.release();
    expect(both.get()).toMatchObject({ requested: false });
    expect(both.pendingSecret()).toBeNull();
  });

  test("alone, it ends as an ask nobody answered", () => {
    const control = createControl();
    control.requestSecret(ASK);
    expect(control.withdrawSecret({ ref: "e7", snapshotId: 4 })).toBe(true);
    expect(control.get()).toMatchObject({ requested: false, unanswered: true });
    expect(askOutcome(control.get())).toBe("gave up");
  });

  test("only the ask that caller made: another field, another snapshot, an answered one and none at all are left as they are", () => {
    const control = createControl();
    expect(control.withdrawSecret({ ref: "e7", snapshotId: 4 })).toBe(false);
    expect(control.get().unanswered).toBeUndefined();

    control.requestSecret(ASK);
    const standing = control.get();
    for (const other of [
      { ref: "e8", snapshotId: 4 },
      { ref: "e7", snapshotId: 5 },
      { ref: "e7" },
      {},
    ]) {
      expect([other, control.withdrawSecret(other)]).toEqual([other, false]);
      expect(control.get()).toEqual(standing);
    }
    // A later ask replaced it: the stopped caller's late word does not take the new one back.
    control.requestSecret({ ...ASK, ref: "e9", label: "인증번호" });
    expect(control.withdrawSecret({ ref: "e7", snapshotId: 4 })).toBe(false);
    expect(control.pendingSecret()).toEqual({ ref: "e9", snapshotId: 4 });

    // And one a person already answered is not turned into one nobody did.
    control.secretSupplied();
    expect(control.withdrawSecret({ ref: "e9", snapshotId: 4 })).toBe(false);
    expect(askOutcome(control.get())).toBe("answered");
  });
});
