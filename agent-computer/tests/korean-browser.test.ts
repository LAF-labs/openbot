import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botTimeZone, botUserAgent } from "../src/browser-identity";
import { askOutcome } from "../../shared/person-wait";
import { createControl, restoredControl } from "../src/control";
import { landDownload, watchRoom } from "../src/page-watch";
import {
  createWorkspace,
  LANDED_MAX_BYTES,
  SPARE_BYTES,
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
  let incoming = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "laf-downloads-"));
    incoming = await mkdtemp(join(tmpdir(), "laf-incoming-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(incoming, { recursive: true, force: true });
  });

  /** A file as the browser leaves one when a download ends: in a place of its own, outside the folder. */
  let landings = 0;
  async function landed(body: string | Buffer): Promise<string> {
    landings += 1;
    const path = join(incoming, `artifact-${landings}`);
    await writeFile(path, body);
    return path;
  }
  /** What is in `downloads/`, or nothing where the folder was never made. */
  const kept = () =>
    readdir(join(root, "downloads")).then(
      (names) => names.sort(),
      () => [] as string[],
    );
  const small = { readBytes: 100, writeBytes: 10, listEntries: 10 };

  test("lands under downloads/ and is reported by the path a Bot can name", async () => {
    const workspace = createWorkspace(root);
    const saved = await workspace.saveDownload(
      "정산내역.csv",
      await landed("날짜,금액\n"),
    );
    expect(saved.path).toBe("downloads/정산내역.csv");
    expect(saved.bytes).toBe(Buffer.byteLength("날짜,금액\n"));
    // And it is readable through the ordinary file tool, by that same path.
    expect((await workspace.read(saved.path)).text).toContain("날짜");
  });

  test("a second file of the same name does not replace the first", async () => {
    const workspace = createWorkspace(root);
    await workspace.saveDownload("정산내역.csv", await landed("8월"));
    const second = await workspace.saveDownload(
      "정산내역.csv",
      await landed("9월"),
    );
    expect(second.path).toBe("downloads/정산내역 (2).csv");
    expect((await workspace.read("downloads/정산내역.csv")).text).toBe("8월");
  });

  test("one larger than a Bot may write is kept: a download is bounded by the disk, not by the write", async () => {
    // It was the write's megabyte, and an ordinary workbook a site hands over is larger than that.
    const workspace = createWorkspace(root, small);
    const saved = await workspace.saveDownload(
      "big.csv",
      await landed("x".repeat(50)),
    );
    expect(saved).toEqual({ path: "downloads/big.csv", bytes: 50 });
    expect(await readFile(join(root, "downloads", "big.csv"), "utf8")).toBe(
      "x".repeat(50),
    );
    // And the Bot's own write is still held to its own bound.
    await expect(
      workspace.write("notes/big.txt", "x".repeat(50)),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  test("the shipped bounds keep a file of three megabytes, and say what they are", async () => {
    const workspace = createWorkspace(root);
    const saved = await workspace.saveDownload(
      "정산내역.xlsx",
      await landed(Buffer.alloc(3_000_000, 1)),
    );
    expect(saved).toEqual({
      path: "downloads/정산내역.xlsx",
      bytes: 3_000_000,
    });
    expect([LANDED_MAX_BYTES, SPARE_BYTES]).toEqual([
      1_000_000_000, 2_000_000_000,
    ]);
  });

  test("one over the ceiling for a single file is refused before a byte of it is copied", async () => {
    let copies = 0;
    const workspace = createWorkspace(root, {
      ...small,
      landedBytes: 40,
      copyLanded: async (from, to) => {
        copies += 1;
        await copyFile(from, to);
      },
    });
    const refused = await workspace
      .saveDownload("big.csv", await landed("x".repeat(41)))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkspaceFileError);
    expect((refused as WorkspaceFileError).code).toBe("laf:file_too_large");
    // Not written and then removed, which is how it used to be: never written at all.
    expect([copies, await kept()]).toEqual([0, []]);
    // At the ceiling exactly, it is kept.
    const at = await workspace.saveDownload(
      "at.csv",
      await landed("x".repeat(40)),
    );
    expect([at.bytes, copies, await kept()]).toEqual([40, 1, ["at.csv"]]);
  });

  test("one the volume has no room to copy is refused before a byte of it is copied, whatever its size", async () => {
    // The disk is the deployment's one disk: the bound on a download is what it leaves the rest.
    // Asked as if the copy were all new bytes, so the spare holds while the file is there twice.
    let free = 600;
    let copies = 0;
    const workspace = createWorkspace(root, {
      ...small,
      spareBytes: 500,
      freeBytes: async () => free,
      copyLanded: async (from, to) => {
        copies += 1;
        await copyFile(from, to);
      },
    });
    const refused = await workspace
      .saveDownload("second.csv", await landed("x".repeat(101)))
      .catch((error: unknown) => error);
    expect((refused as WorkspaceFileError).code).toBe("laf:file_too_large");
    expect([copies, await kept()]).toEqual([0, []]);

    // One byte less leaves the spare exactly, and is kept.
    const fits = await workspace.saveDownload(
      "first.csv",
      await landed("x".repeat(100)),
    );
    expect([fits.bytes, copies, await kept()]).toEqual([100, 1, ["first.csv"]]);

    // While one lands, the same line is what the watch asks about.
    expect(await workspace.hasRoom()).toBe(true);
    free = 500;
    expect(await workspace.hasRoom()).toBe(true);
    free = 499;
    expect(await workspace.hasRoom()).toBe(false);
  });

  test("two that finish together are let in one at a time: the second is asked of the disk the first left", async () => {
    // Each used to ask before either had copied, and both were let in past the room they must leave.
    let free = 1_100;
    const order: string[] = [];
    const workspace = createWorkspace(root, {
      ...small,
      spareBytes: 500,
      freeBytes: async () => free,
      copyLanded: async (from, to) => {
        order.push("copy starts");
        // A turn of the loop: the other one would have asked by now, were it allowed to.
        await new Promise((resolve) => setImmediate(resolve));
        await copyFile(from, to);
        free -= 400;
        order.push("copy ends");
      },
    });
    const [first, second] = await Promise.allSettled([
      workspace.saveDownload("a.csv", await landed("x".repeat(400))),
      workspace.saveDownload("b.csv", await landed("x".repeat(400))),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    const refused = (second as PromiseRejectedResult)
      .reason as WorkspaceFileError;
    expect(refused.code).toBe("laf:file_too_large");
    // What it is told is the room there was above the spare, not the ceiling for one file.
    expect(refused.facts).toEqual({ bytes: 400, limit: 200 });
    expect([order, await kept(), free]).toEqual([
      ["copy starts", "copy ends"],
      ["a.csv"],
      700,
    ]);

    // And one that fails does not hold up the one behind it.
    let failing = true;
    const other = createWorkspace(root, {
      ...small,
      copyLanded: async (from, to) => {
        if (!failing) return copyFile(from, to);
        failing = false;
        throw new Error("the disk went away");
      },
    });
    const [lost, after] = await Promise.allSettled([
      other.saveDownload("c.csv", await landed("c")),
      other.saveDownload("d.csv", await landed("d")),
    ]);
    expect([lost.status, after.status]).toEqual(["rejected", "fulfilled"]);
    expect(await kept()).toEqual(["a.csv", "d.csv"]);
  });

  test("a copy that fails leaves nothing of the file behind, and what was already kept is untouched", async () => {
    // A disk that filled from something else half-way, or a source that went: the part that had
    // arrived used to stay.
    let failing = false;
    const workspace = createWorkspace(root, {
      ...small,
      copyLanded: async (from, to) => {
        if (!failing) return copyFile(from, to);
        await writeFile(to, "half of i");
        throw new Error("ENOSPC: no space left on device");
      },
    });
    await workspace.saveDownload("kept.csv", await landed("whole"));
    failing = true;
    const failed = await workspace
      .saveDownload("lost.csv", await landed("half of it"))
      .catch((error: unknown) => error);
    // Not a refusal for size: a download that failed, which is what the Bot is told.
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WorkspaceFileError);
    expect(await kept()).toEqual(["kept.csv"]);
    expect(await readFile(join(root, "downloads", "kept.csv"), "utf8")).toBe(
      "whole",
    );
  });

  test("a volume that cannot be asked refuses nobody's file: the ceiling still holds, and the watch does not stop a download", async () => {
    const workspace = createWorkspace(root, {
      ...small,
      landedBytes: 40,
      freeBytes: async () => {
        throw new Error("no such volume");
      },
    });
    expect(await workspace.hasRoom()).toBe(true);
    const saved = await workspace.saveDownload(
      "a.csv",
      await landed("x".repeat(40)),
    );
    expect(saved.bytes).toBe(40);
    await expect(
      workspace.saveDownload("b.csv", await landed("x".repeat(41))),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  test("a download that never landed, or landed as something that is no file, is said not to have arrived", async () => {
    const workspace = createWorkspace(root);
    for (const nowhere of [join(incoming, "never-written"), incoming]) {
      const refused = await workspace
        .saveDownload("x.csv", nowhere)
        .catch((error: unknown) => error);
      expect((refused as WorkspaceFileError).code).toBe("laf:file_not_found");
    }
    expect(await kept()).toEqual([]);
  });

  test("while one lands the volume is watched: out of room, it is cancelled once, and said to be that", async () => {
    // Each look is made to happen and waited for: nothing here sleeps and hopes.
    let room = true;
    let cancelled = 0;
    let look: () => Promise<void> = async () => undefined;
    let stops = 0;
    const watch = watchRoom(
      async () => room,
      async () => {
        cancelled += 1;
      },
      (each) => {
        look = each;
        return () => {
          stops += 1;
        };
      },
    );
    await look();
    expect([watch.ranOut(), cancelled]).toEqual([false, 0]);
    room = false;
    await look();
    await look();
    await look();
    // Asked three times since, and cancelled once.
    expect([watch.ranOut(), cancelled]).toEqual([true, 1]);
    watch.stop();
    expect(stops).toBe(1);
  });

  test("a look already on its way when the download landed cancels nothing, and neither does a volume that cannot be asked", async () => {
    // Cancelling does nothing to a download that has finished — and must not be said to have.
    let answer: (room: boolean) => void = () => undefined;
    let cancelled = 0;
    let look: () => Promise<void> = async () => undefined;
    const watch = watchRoom(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      async () => {
        cancelled += 1;
      },
      (each) => {
        look = each;
        return () => undefined;
      },
    );
    const looking = look();
    watch.stop();
    answer(false);
    await looking;
    expect([watch.ranOut(), cancelled]).toEqual([false, 0]);
    // And once stopped, a later look does not even ask.
    await look();
    expect([watch.ranOut(), cancelled]).toEqual([false, 0]);

    const blind = watchRoom(
      async () => {
        throw new Error("no such volume");
      },
      async () => {
        cancelled += 1;
      },
      (each) => {
        look = each;
        return () => undefined;
      },
    );
    await look();
    expect([blind.ranOut(), cancelled]).toEqual([false, 0]);
  });

  /** A download as Playwright hands one over, with what was asked of it written down. */
  function download(lands: () => Promise<string>) {
    const asked: string[] = [];
    return {
      asked,
      suggestedFilename: () => "정산내역.csv",
      path: async () => {
        asked.push("path");
        return lands();
      },
      cancel: async () => {
        asked.push("cancel");
      },
      delete: async () => {
        asked.push("delete");
      },
    };
  }
  /** `landDownload` with a clock nobody winds, and everything it said written down. */
  async function land(
    one: ReturnType<typeof download>,
    workspace: Parameters<typeof landDownload>[1],
    clock: Parameters<typeof landDownload>[4] = () => () => undefined,
  ) {
    const told: unknown[] = [];
    const failures: unknown[] = [];
    await landDownload(
      one,
      workspace,
      (entry) => told.push(entry),
      (reason) => failures.push(reason),
      clock,
    );
    return { told, failures };
  }

  test("kept, refused or failed, the browser's own copy is deleted — once, and after the folder has what it will have", async () => {
    // Chromium keeps a finished download until the browser closes, and a Bot's browser stays open
    // for days: a kept file was on the disk twice, and a file refused for its size was still there.
    const workspace = createWorkspace(root, { ...small, landedBytes: 40 });

    const good = download(async () => landed("x".repeat(40)));
    expect((await land(good, workspace)).told).toEqual([
      { code: "laf:downloaded", path: "downloads/정산내역.csv", bytes: 40 },
    ]);
    expect(good.asked).toEqual(["path", "delete"]);

    const large = download(async () => landed("x".repeat(41)));
    const refused = await land(large, workspace);
    expect(refused.told).toEqual([{ code: "laf:download_too_large" }]);
    expect(refused.failures).toHaveLength(1);
    expect(large.asked).toEqual(["path", "delete"]);

    const broken = download(async () => {
      throw new Error("the connection was reset");
    });
    expect((await land(broken, workspace)).told).toEqual([
      { code: "laf:download_failed" },
    ]);
    expect(broken.asked).toEqual(["path", "delete"]);
    // One file in the folder for the three.
    expect(await kept()).toEqual(["정산내역.csv"]);
  });

  test("the watch is over the moment a download has landed: nothing is looking for room while the folder decides", async () => {
    // From there its size is known, and cancelling does nothing to a download that has finished.
    let stops = 0;
    let stoppedWhenSaving = -1;
    const one = download(async () => landed("x"));
    const { told } = await land(
      one,
      {
        hasRoom: async () => true,
        saveDownload: async () => {
          stoppedWhenSaving = stops;
          return { path: "downloads/x.csv", bytes: 1 };
        },
      },
      () => () => {
        stops += 1;
      },
    );
    expect(stoppedWhenSaving).toBe(1);
    expect(told).toEqual([
      { code: "laf:downloaded", path: "downloads/x.csv", bytes: 1 },
    ]);
  });

  test("one that runs the volume out while it lands is cancelled, said to be too large, and its copy deleted", async () => {
    let free = 1_000;
    const workspace = createWorkspace(root, {
      ...small,
      spareBytes: 500,
      freeBytes: async () => free,
    });
    let look: () => Promise<void> = async () => undefined;
    let fail: (reason: Error) => void = () => undefined;
    const one = download(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const landing = land(one, workspace, (each) => {
      look = each;
      return () => undefined;
    });
    await look();
    expect(one.asked).toEqual(["path"]);
    // It has taken the room it must leave: the next look cancels it, and waiting for it fails.
    free = 499;
    await look();
    expect(one.asked).toEqual(["path", "cancel"]);
    fail(new Error("download was cancelled"));
    expect((await landing).told).toEqual([{ code: "laf:download_too_large" }]);
    expect(one.asked).toEqual(["path", "cancel", "delete"]);
    expect(await kept()).toEqual([]);
  });

  test("a name that tried to escape has already stopped being a path", async () => {
    const workspace = createWorkspace(root);
    const saved = await workspace.saveDownload(
      "../../../tmp/escaped.csv",
      await landed("x"),
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
