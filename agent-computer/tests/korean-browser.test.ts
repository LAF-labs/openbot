import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControl, restoredControl } from "../src/control";
import { botTimeZone, botUserAgent } from "../src/profiles";
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
 * that one passed: what a name from a website is allowed to become on this filesystem, and who has
 * the wheel after a restart.
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

  test("the user agent does not announce that nobody is looking", () => {
    const agent = botUserAgent("151.0.7922.34");
    expect(agent).toContain("Chrome/151.0.7922.34");
    expect(agent).not.toContain("Headless");
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

describe("who has the wheel after a restart", () => {
  test("a person who held it still holds it", () => {
    const restored = restoredControl({
      holder: "human",
      since: "2026-09-03T01:00:00.000Z",
      reason: "이 페이지가 인증번호를 묻고 있습니다.",
      requested: false,
    });
    expect(restored.state?.holder).toBe("human");
    expect(restored.state?.since).toBe("2026-09-03T01:00:00.000Z");
    // What they were asked to do survives with them; they are still standing in front of it.
    expect(restored.state?.reason).toContain("인증번호");
    expect(restored.secretLost).toBe(false);
  });

  test("a Bot that held it is simply the default, not something restored", () => {
    expect(restoredControl({ holder: "bot", requested: true }).state).toBe(
      undefined,
    );
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
  });

  test("a takeover that survived a restart keeps no secret box open behind it", () => {
    const restored = restoredControl({
      holder: "human",
      since: "2026-09-03T01:00:00.000Z",
      requested: true,
      secretWanted: "비밀번호",
      secretRef: "e3",
    });
    expect(restored.state?.holder).toBe("human");
    expect(restored.state?.secretRef).toBe(undefined);
    // Somebody holding the wheel is not somebody waiting to be given it.
    expect(restored.state?.requested).toBe(false);
    expect(restored.secretLost).toBe(true);
  });
});

describe("control state on its way to disk", () => {
  test("every change is offered to whoever is keeping it", () => {
    const written: string[] = [];
    const control = createControl(() => "2026-09-03T00:00:00.000Z", {
      onChange: (state) => written.push(state.holder),
    });

    control.requestHelp("로그인이 필요합니다");
    control.take();
    control.requestSecret({ ref: "e1", label: "인증번호" });
    control.secretSupplied();
    control.release();

    expect(written).toEqual(["bot", "human", "human", "human", "bot"]);
  });

  test("what survived the last life is where it starts", () => {
    const control = createControl(() => "2026-09-03T00:00:00.000Z", {
      initial: {
        holder: "human",
        since: "2026-09-02T23:00:00.000Z",
        requested: false,
      },
    });
    expect(control.get().holder).toBe("human");
    // And the Bot is still refused, which is the whole point of restoring it.
    expect(() => control.assertBotMayAct()).toThrow();
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
