import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createProfiles } from "../src/profiles";
import {
  DOWNLOAD_BODY,
  DOWNLOAD_NAME,
  FRAME_BUTTON,
  FRAME_CLICKED,
  FRAME_TEXT,
  HIDDEN_MENU_TEXT,
  serveFixture,
  VISIBLE_TEXT,
} from "./fixture-site";

/**
 * The whole process, driven over HTTP the way the server drives it.
 *
 * NOT the modules in isolation. Everything this wave fixed was invisible from a unit test: the page
 * text came back as one unbroken line of a menu nobody can see, a `target=_blank` link opened a tab
 * nothing held, an alert was answered and forgotten before the Bot heard about it. So this starts
 * the real `src/index.ts`, points it at a page carrying every one of those, and asks it the same
 * questions the gateway asks — with `x-openbot-bot-id`, because there is no longer any other way to
 * ask.
 *
 * Skipped where Playwright has no browser downloaded, which is the case on a checkout that has not
 * run `bunx playwright install chromium`. A skip says so out loud; a test that quietly launched
 * nothing would be worse than not having it.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "fixture-bot";
const TOKEN = "test-computer-token";

let base = "";
let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let profilesDir = "";
let workspaceDir = "";

/** A port nothing else has, found by taking one and giving it straight back. */
async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  return port;
}

async function call(
  path: string,
  init?: RequestInit & { bot?: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bot = init?.bot === undefined ? BOT : init.bot;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      ...(bot ? { "x-openbot-bot-id": bot } : {}),
    },
  });
  return {
    status: response.status,
    body: ((await response.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

const post = (path: string, payload: unknown, bot?: string | null) =>
  call(path, {
    method: "POST",
    body: JSON.stringify(payload),
    ...(bot === undefined ? {} : { bot }),
  });

type Note = { code: string } & Record<string, unknown>;

const notesOf = (body: Record<string, unknown>): Note[] =>
  Array.isArray(body.notes) ? (body.notes as Note[]) : [];

/**
 * Wait for a fact the browser produces on its own schedule.
 *
 * A download finishes after the click that started it returns, so the note rides on whichever call
 * comes next. Polling `/read` is what the Bot itself would do.
 */
async function waitForNote(
  code: string,
  from: Record<string, unknown> = {},
): Promise<Note | undefined> {
  const found = notesOf(from).find((note) => note.code === code);
  if (found) return found;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const read = await call("/read");
    const note = notesOf(read.body).find((entry) => entry.code === code);
    if (note) return note;
    await Bun.sleep(100);
  }
  return undefined;
}

async function snapshot() {
  const result = await post("/snapshot", {});
  return result.body as {
    snapshotId: number;
    elements: { ref: string; role: string; name: string; type?: string }[];
    tabs?: { index: number; title: string; url: string; active: boolean }[];
  };
}

const refFor = (
  elements: { ref: string; name: string }[],
  name: string,
): string => {
  const found = elements.find((element) => element.name.includes(name));
  if (!found) {
    throw new Error(
      `The snapshot has nothing called ${name}: ${elements.map((e) => e.name).join(" | ")}`,
    );
  }
  return found.ref;
};

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${base}/health`).catch(() => null);
    if (alive?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("the computer did not start");
});

afterAll(async () => {
  child?.kill();
  fixture?.stop();
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_BROWSER)("the Bot's browser on a Korean page", () => {
  test("a call that names no Bot is refused, and only /health is not", async () => {
    const refused = await call("/read", { bot: null });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("laf:bot_header_missing");

    // The one route an orchestrator has to be able to reach without knowing about Bots.
    const health = await call("/health", { bot: null });
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const listed = await call("/computers", { bot: null });
    expect(listed.status).toBe(200);
  }, 20_000);

  test("the page reads as a person sees it, iframe included and the hidden menu left out", async () => {
    const opened = await post("/navigate", { url: fixture?.url });
    expect(opened.status).toBe(200);
    const text = String(opened.body.text ?? "");

    expect(text).toContain(VISIBLE_TEXT);
    // The failure this wave started from: a detached clone's `innerText` is `textContent`, so a
    // `display:none` mega-menu was most of what a Bot read.
    expect(text).not.toContain(HIDDEN_MENU_TEXT);
    // And it has the shape a person sees, rather than one unbroken line.
    expect(text).toContain("\n");
    // The iframe's own text, merged in. Nothing in the main frame says this.
    expect(text).toContain(FRAME_TEXT);
    expect(
      (opened.body.frames as { url: string; chars: number }[]).some((frame) =>
        frame.url.endsWith("/frame"),
      ),
    ).toBe(true);
  }, 30_000);

  test("the snapshot lists the tabs and marks the password box", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    expect(shot.tabs?.length).toBe(1);
    expect(shot.tabs?.[0]?.active).toBe(true);
    const password = shot.elements.find(
      (element) => element.type === "password",
    );
    expect(password?.name).toContain("비밀번호");
  }, 30_000);

  test("the snapshot reaches into a same-origin iframe, and so does a click", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    /*
     * MEASURED, not assumed. `snapshotPage`'s comment claimed Playwright's aria snapshot descends
     * into iframes and nothing here had ever checked. It does: a control inside the frame comes
     * back with a frame-scoped ref (`f1e4`), and `aria-ref=` resolves it, so a Bot can press the
     * button in a 세금계산서 frame the same way it presses one on the page. Cross-origin frames are
     * a different question, and `laf:frame_opaque` is what a Bot is told about those.
     */
    const inside = refFor(shot.elements, FRAME_BUTTON);
    expect(inside).toMatch(/^f\d+e\d+$/);

    const clicked = await post("/click", {
      ref: inside,
      snapshotId: shot.snapshotId,
    });
    expect(clicked.status).toBe(200);
    const read = await call("/read");
    expect(String(read.body.text)).toContain(FRAME_CLICKED);
  }, 30_000);

  test("a target=_blank link becomes the tab the Bot is on, and it can switch back", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    const clicked = await post("/click", {
      ref: refFor(shot.elements, "주문 상세 보기"),
      snapshotId: shot.snapshotId,
    });
    expect(clicked.status).toBe(200);

    // The newest page is adopted, so what the Bot reads next is the tab that just opened.
    const after = await snapshot();
    expect(after.tabs?.length).toBe(2);
    expect(after.tabs?.[1]?.active).toBe(true);
    const read = await call("/read");
    expect(String(read.body.text)).toContain("주문 상세 화면");

    const back = await post("/tabs/switch", { index: 0 });
    expect(back.status).toBe(200);
    expect(String(back.body.url)).toContain(fixture?.url ?? "");
    const home = await call("/read");
    expect(String(home.body.text)).toContain(VISIBLE_TEXT);
  }, 40_000);

  test("an alert is answered and reported, and a confirm is dismissed and reported", async () => {
    await post("/navigate", { url: fixture?.url });
    let shot = await snapshot();
    const alerted = await post("/click", {
      ref: refFor(shot.elements, "알림"),
      snapshotId: shot.snapshotId,
    });
    const alertNote = await waitForNote("laf:dialog", alerted.body);
    expect(alertNote?.kind).toBe("alert");
    expect(alertNote?.message).toBe("로그인이 필요합니다");
    expect(alertNote?.accepted).toBe(true);

    shot = await snapshot();
    const confirmed = await post("/click", {
      ref: refFor(shot.elements, "삭제"),
      snapshotId: shot.snapshotId,
    });
    const confirmNote = await waitForNote("laf:dialog", confirmed.body);
    expect(confirmNote?.kind).toBe("confirm");
    expect(confirmNote?.accepted).toBe(false);
    // Dismissed, not accepted: the page took the "no" branch. A Bot must not be the thing that
    // presses 확인 on 정말 삭제하시겠습니까.
    const read = await call("/read");
    expect(String(read.body.text)).toContain("삭제하지 않음");
  }, 40_000);

  test("a download lands in the workspace and says so", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    const clicked = await post("/click", {
      ref: refFor(shot.elements, "정산내역 내려받기"),
      snapshotId: shot.snapshotId,
    });
    const note = await waitForNote("laf:downloaded", clicked.body);
    expect(note?.path).toBe(`downloads/${DOWNLOAD_NAME}`);
    expect(note?.bytes).toBe(Buffer.byteLength(DOWNLOAD_BODY));

    const onDisk = await readFile(
      join(workspaceDir, "downloads", DOWNLOAD_NAME),
      "utf8",
    );
    expect(onDisk).toBe(DOWNLOAD_BODY);

    // And the Bot can find it the way it finds anything else it saved.
    const listed = await post("/files/list", {});
    expect(JSON.stringify(listed.body)).toContain(DOWNLOAD_NAME);
  }, 40_000);

  test("a workspace file can be handed to a file input", async () => {
    await post("/files/write", { path: "송장.txt", contents: "송장 내용" });
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    const uploaded = await post("/upload", {
      ref: refFor(shot.elements, "첨부 파일"),
      snapshotId: shot.snapshotId,
      path: "송장.txt",
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.action).toBe("upload_file");

    const read = await call("/read");
    expect(String(read.body.text)).toContain("올린 파일: 송장.txt");
  }, 40_000);

  test("a file outside the workspace cannot be handed to a page", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    const refused = await post("/upload", {
      ref: refFor(shot.elements, "첨부 파일"),
      snapshotId: shot.snapshotId,
      path: "../../etc/passwd",
    });
    expect(refused.status).toBe(403);
  }, 30_000);

  test("a ref with no snapshotId is stale, on every action including a keypress", async () => {
    await post("/navigate", { url: fixture?.url });
    const shot = await snapshot();
    const ref = refFor(shot.elements, "비밀번호");

    // The hole this closes: `/key` skipped the check when the id was left out.
    const keyed = await post("/key", { key: "Enter", ref });
    expect(keyed.status).toBe(409);
    expect(keyed.body.error).toBe("laf:stale_refs");

    // And an old generation is refused with the same code, not an English paragraph.
    const clicked = await post("/click", {
      ref,
      snapshotId: shot.snapshotId - 1,
    });
    expect(clicked.status).toBe(409);
    expect(clicked.body.error).toBe("laf:stale_refs");
  }, 30_000);

  test("who has the wheel is written down where a restart can find it", async () => {
    const taken = await post("/control/take", {});
    expect(taken.status).toBe(200);
    const saved = JSON.parse(
      await readFile(join(profilesDir, BOT, "control.json"), "utf8"),
    ) as { holder: string };
    expect(saved.holder).toBe("human");

    await post("/control/release", {});
    const back = JSON.parse(
      await readFile(join(profilesDir, BOT, "control.json"), "utf8"),
    ) as { holder: string };
    expect(back.holder).toBe("bot");
  }, 30_000);

  test("a browser nobody has used closes, and the next call opens it again with its cookies", async () => {
    // Its own profiles instance with its own clock, rather than the running process's: the sweep
    // is on a one-minute timer, and a test that waited for a real ten minutes would not be run.
    let clock = Date.now();
    const root = await mkdtemp(join(tmpdir(), "laf-idle-"));
    const profiles = createProfiles(root, {
      idleCloseMs: 10 * 60_000,
      now: () => clock,
    });
    try {
      const page = await profiles.page("idle-bot");
      await page.goto(`${fixture?.url}`);
      await page.evaluate(() => localStorage.setItem("장부", "8월 정산 완료"));
      expect((await profiles.tabs("idle-bot")).length).toBe(1);

      // Nine minutes is not idle enough.
      clock += 9 * 60_000;
      expect(await profiles.closeIdle()).toEqual([]);

      clock += 2 * 60_000;
      expect(await profiles.closeIdle()).toEqual(["idle-bot"]);
      expect(await profiles.tabs("idle-bot")).toEqual([]);

      const reopenedAt = Date.now();
      const again = await profiles.page("idle-bot");
      const cost = Date.now() - reopenedAt;
      await again.goto(`${fixture?.url}`);
      // What the browser knew is on the volume, so closing it signs nothing out.
      expect(await again.evaluate(() => localStorage.getItem("장부"))).toBe(
        "8월 정산 완료",
      );
      console.info(`reopening an idle browser took ${cost}ms`);
      // Generous: the assertion is that it is a cold start and not an outage. The number that
      // matters is the one printed above, and it is in docs/laf/browser-limits.md.
      expect(cost).toBeLessThan(20_000);
    } finally {
      await profiles.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("stopping and using it again, three times over, leaves a browser that works", async () => {
    /*
     * Measured against the container: three stop-and-navigate cycles in a row left a Bot whose every
     * call then hung until its timeout, with no Chromium of its own in the process list — one
     * browser having been started on a profile directory the previous one had not finished letting
     * go of. The close waits for the browser to actually be gone now, and a launch waits for an
     * in-flight close of the same Bot.
     */
    for (let round = 0; round < 3; round += 1) {
      const stopped = await post("/computers/stop", {});
      expect(stopped.status).toBe(200);
      const opened = await post("/navigate", { url: fixture?.url });
      expect(opened.status).toBe(200);
      expect(String(opened.body.text ?? "")).toContain(VISIBLE_TEXT);
    }
  }, 60_000);

  test("the browser it launches is Korean, in Seoul, and does not announce itself as headless", async () => {
    // Read off the page rather than out of the launch options: the options are a claim, and what
    // matters is what a site actually sees. The fixture prints all three onto itself.
    const opened = await post("/navigate", { url: fixture?.url });
    const text = String(opened.body.text ?? "");
    expect(text).toContain("언어=ko-KR");
    expect(text).toContain("시간대=Asia/Seoul");
    expect(text).toMatch(/브라우저=.*Chrome\/\d+/);
    // The single cheapest automation signal there is, and it used to be in every request.
    expect(text).not.toContain("Headless");
  }, 30_000);
});
