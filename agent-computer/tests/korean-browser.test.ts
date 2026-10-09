import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botTimeZone, botUserAgent } from "../src/browser-identity";
import { askOutcome } from "../../shared/person-wait";
import { createControl, restoredControl } from "../src/control";
import {
  createWorkspace,
  safeDownloadName,
  WorkspaceFileError,
  WorkspacePathError,
} from "../src/workspace";

/**
 * The decisions in the browser wave that do not need a browser.
 *
 * Everything that does — the page text, the tabs, the dialogs, the downloads — is exercised against
 * a real Chromium in `korean-sites.test.ts`. What is here is the part that would still be wrong if
 * that one passed: what a name from a website is allowed to become on this filesystem, and what the
 * Bot's asks are after a restart.
 */

describe("where the Bot lives", () => {
  test("a browser with nothing configured is in Seoul", () => {
    expect(botTimeZone({})).toBe("Asia/Seoul");
    expect(botTimeZone({ BOT_TIME_ZONE: "   " })).toBe("Asia/Seoul");
  });

  test("a deployment elsewhere is believed", () => {
    expect(botTimeZone({ BOT_TIME_ZONE: "Europe/Berlin" })).toBe(
      "Europe/Berlin",
    );
  });

  test("a typo does not stop every Bot having a computer", () => {
    // Chromium refuses an unknown zone at launch, which would make one bad character in a
    // deployment's environment the reason no browser starts at all.
    expect(botTimeZone({ BOT_TIME_ZONE: "Mars/Olympus" })).toBe("Asia/Seoul");
  });

  test("the user agent does not announce that nobody is looking, and reads as Chrome writes its own", () => {
    const agent = botUserAgent("151.0.7922.34");
    // The major version and zeros: the full build number was itself a mark no browser sends
    // (measured 2026-10-04, 쿠팡's seller centre: refused with it, opened without).
    expect(agent).toContain("Chrome/151.0.0.0");
    expect(agent).not.toContain("7922");
    expect(agent).not.toContain("Headless");
    // A version with no dots, as a stub might give, is still a version.
    expect(botUserAgent("151")).toContain("Chrome/151.0.0.0");
    // Linux, consistently. Claiming Windows here would disagree with everything else the browser
    // says about itself, which is a louder signal than the one being removed.
    expect(agent).toContain("X11; Linux x86_64");
  });
});

describe("a filename chosen by a website", () => {
  test("keeps an ordinary Korean name", () => {
    expect(safeDownloadName("정산내역.csv")).toBe("정산내역.csv");
  });

  test("cannot become a path", () => {
    expect(safeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(safeDownloadName("/etc/shadow")).toBe("shadow");
    expect(safeDownloadName("a\\b\\c.txt")).toBe("c.txt");
  });

  test("cannot become a dotfile, or nothing at all", () => {
    expect(safeDownloadName(".bashrc")).toBe("bashrc");
    expect(safeDownloadName("..")).toBe("download");
    expect(safeDownloadName("")).toBe("download");
    expect(safeDownloadName("   ")).toBe("download");
  });

  test("carries no control characters and no unbounded length", () => {
    expect(safeDownloadName("re\u0000port\u001f.pdf")).toBe("report.pdf");
    expect(safeDownloadName(`${"가".repeat(400)}.csv`).length).toBe(120);
  });
});

describe("a download arriving in the workspace", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "laf-downloads-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lands under downloads/ and is reported by the path a Bot can name", async () => {
    const workspace = createWorkspace(root);
    const saved = await workspace.saveDownload("정산내역.csv", async (to) => {
      await writeFile(to, "날짜,금액\n", "utf8");
    });
    expect(saved.path).toBe("downloads/정산내역.csv");
    expect(saved.bytes).toBeGreaterThan(0);
    // And it is readable through the ordinary file tool, by that same path.
    expect((await workspace.read(saved.path)).text).toContain("날짜");
  });

  test("a second file of the same name does not replace the first", async () => {
    const workspace = createWorkspace(root);
    await workspace.saveDownload("정산내역.csv", async (to) => {
      await writeFile(to, "8월", "utf8");
    });
    const second = await workspace.saveDownload("정산내역.csv", async (to) => {
      await writeFile(to, "9월", "utf8");
    });
    expect(second.path).toBe("downloads/정산내역 (2).csv");
    expect((await workspace.read("downloads/정산내역.csv")).text).toBe("8월");
  });

  test("one too big for the workspace is refused and not left behind", async () => {
    const workspace = createWorkspace(root, {
      readBytes: 100,
      writeBytes: 10,
      listEntries: 10,
    });
    await expect(
      workspace.saveDownload("big.csv", async (to) => {
        await writeFile(to, "x".repeat(50), "utf8");
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
    // Written and then removed: the limit is real, and the disk does not keep the proof.
    await expect(
      readFile(join(root, "downloads", "big.csv")),
    ).rejects.toThrow();
  });

  test("a name that tried to escape has already stopped being a path", async () => {
    const workspace = createWorkspace(root);
    const saved = await workspace.saveDownload(
      "../../../tmp/escaped.csv",
      async (to) => {
        await writeFile(to, "x", "utf8");
      },
    );
    expect(saved.path).toBe("downloads/escaped.csv");
  });

  test("the confinement still refuses a path a Bot names itself", async () => {
    const workspace = createWorkspace(root);
    await expect(
      workspace.resolvePath("../outside.txt", false),
    ).rejects.toBeInstanceOf(WorkspacePathError);
  });
});

/**
 * A PERSON'S HOLD ON THE WHEEL, SAVED BY A RELEASE THAT HAD ONE, IS THE BOT'S.
 *
 * Until 2026-10-09 a restart in the middle of a takeover restored the takeover, so the Bot stayed
 * refused while somebody finished a login. Nobody can hold the wheel now and nothing can hand it
 * back, so a deployment upgraded mid-takeover would have left its Bot refused every action for
 * ever. The file is still read — it is how a cut-short value request reaches the Bot — and its hold
 * is not believed.
 */
describe("what the Bot's asks are after a restart", () => {
  test("a person's hold from an earlier release is the Bot's, and reads as nobody's answer", () => {
    const restored = restoredControl({
      holder: "human",
      since: "2026-09-03T01:00:00.000Z",
      reason: "이 페이지가 인증번호를 묻고 있습니다.",
      requested: false,
    });
    expect(restored.state?.holder).toBe("bot");
    expect(restored.state?.requested).toBe(false);
    // What they were asked to do is not asked again: the call that asked went with the process.
    expect(restored.state?.reason).toBeUndefined();
    // And a wait still reading this does not hear that they came and did it.
    expect(restored.state?.unanswered).toBe(true);
    expect(askOutcome(restored.state ?? {})).toBe("gave up");
    expect(restored.secretLost).toBe(false);
  });

  test("a Bot that held it and asked nothing is simply the default, not something restored", () => {
    expect(restoredControl({ holder: "bot", requested: false }).state).toBe(
      undefined,
    );
  });

  /*
   * The server's wait outlives this process and reads an ask that is simply gone as one answered:
   * restored as nothing, this ask told the Bot the person had approved on their phone (review,
   * 2026-10-09).
   */
  test("an ask for a hand that a restart cut short reads as nobody's answer, not as one answered", () => {
    const restored = restoredControl({
      holder: "bot",
      since: "2026-09-03T01:00:00.000Z",
      requested: true,
      reason: "휴대폰 앱에서 로그인을 승인해 주세요",
    });
    expect(restored.state).toMatchObject({
      holder: "bot",
      requested: false,
      unanswered: true,
    });
    expect(restored.state?.reason).toBeUndefined();
    expect(askOutcome(restored.state ?? {})).toBe("gave up");
    expect(restored.secretLost).toBe(false);
  });

  test("nothing readable is the same as nothing", () => {
    expect(restoredControl(null).state).toBe(undefined);
    expect(restoredControl("{}").state).toBe(undefined);
    expect(restoredControl({ holder: "nonsense" }).state).toBe(undefined);
  });

  test("a pending secret request is dropped, and the Bot is told", () => {
    const restored = restoredControl({
      holder: "bot",
      since: "2026-09-03T01:00:00.000Z",
      requested: false,
      secretWanted: "문자로 온 인증번호",
      secretRef: "e12",
    });
    expect(restored.secretLost).toBe(true);
    // The ref named a snapshot of a page in a browser that no longer exists.
    expect(restored.state?.secretWanted).toBe(undefined);
    // And the wait still reading this state is not told a value was typed.
    expect(restored.state?.unanswered).toBe(true);
    expect(askOutcome(restored.state ?? {})).toBe("gave up");
  });

  test("a takeover cut short by a restart keeps no secret box open, and no ask standing", () => {
    const restored = restoredControl({
      holder: "human",
      since: "2026-09-03T01:00:00.000Z",
      requested: true,
      secretWanted: "비밀번호",
      secretRef: "e3",
    });
    expect(restored.state?.holder).toBe("bot");
    expect(restored.state?.secretRef).toBe(undefined);
    expect(restored.state?.requested).toBe(false);
    expect(restored.secretLost).toBe(true);
  });
});

describe("control state on its way to disk", () => {
  test("every change is offered to whoever is keeping it", () => {
    const written: string[] = [];
    const control = createControl(() => "2026-09-03T00:00:00.000Z", {
      onChange: (state) =>
        written.push(
          `${state.requested ? "asked" : "-"}/${state.secretWanted ?? "-"}`,
        ),
    });

    control.requestHelp("로그인이 필요합니다");
    control.requestSecret({ ref: "e1", label: "인증번호" });
    control.secretSupplied();
    control.release();

    expect(written).toEqual(["asked/-", "asked/인증번호", "asked/-", "-/-"]);
  });

  test("what survived the last life is where it starts — a takeover's file included", () => {
    // The whole way through: the file an upgrade finds, read, and handed to the machine.
    const restored = restoredControl({
      holder: "human",
      since: "2026-09-02T23:00:00.000Z",
      requested: false,
    });
    const control = createControl(() => "2026-09-03T00:00:00.000Z", {
      ...(restored.state ? { initial: restored.state } : {}),
    });
    expect(control.get()).toMatchObject({
      holder: "bot",
      requested: false,
      unanswered: true,
    });
    // And the next ask is asked and waited on afresh.
    control.requestHelp("휴대폰에서 승인해 주세요");
    expect(control.get()).toMatchObject({ requested: true });
    expect(control.get().unanswered).toBeUndefined();
  });

  test("a value is never in what gets written down", () => {
    const written: unknown[] = [];
    const control = createControl(undefined, {
      onChange: (state) => written.push(state),
    });
    control.requestSecret({ ref: "e1", label: "비밀번호" });
    control.secretSupplied();
    // The label is stored and the value never reaches this module at all, but the file is the one
    // thing here that outlives the process, so it is asserted directly.
    expect(JSON.stringify(written)).not.toContain("hunter2");
    expect(JSON.stringify(written)).toContain("비밀번호");
  });
});
