import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticBundle } from "../src/lib/support/feedback";
import type {
  FeedbackScenario,
  FeedbackShown,
} from "./support/feedback-render";

/**
 * "진단 정보 같이 보내기", ON A KOREAN SCREEN: SHOWN FIRST, SENT BY THE ID OF WHAT WAS SHOWN.
 *
 * The server's half — what a bundle may hold, whose events are whose — is
 * `server/tests/diagnostics.test.ts` and its integration twin. This is what the person meets: nothing
 * is gathered until the box is ticked; the preview says, in Korean, exactly what the bundle holds,
 * with the bundle itself folded inside it; what the browser posts is the words and the ID, never a
 * bundle of its own; and a send the server refuses as stale gathers and shows the new bundle before
 * anything goes. Rendered in a process of its own (`support/feedback-render.tsx`).
 */

const bundle = (
  overrides: Partial<DiagnosticBundle> = {},
): DiagnosticBundle => ({
  assembledAt: "2026-09-14T08:59:00.000Z",
  version: { version: "edge", revision: "eeea9853c2d1", channel: "edge" },
  health: {
    status: "degraded",
    checks: { database: "ok", agentBot: "down" },
  },
  failureWindowDays: 7,
  failures: [
    {
      code: "laf:turn_unreachable",
      count: 3,
      lastAt: "2026-09-14T08:58:00.000Z",
    },
  ],
  events: [
    {
      at: "2026-09-14T08:57:00.000Z",
      source: "log",
      event: "agent_stream_stalled",
      level: "error",
      bot: "bot-owner-1",
      silentForMs: 60_000,
    },
    {
      at: "2026-09-14T08:58:00.000Z",
      source: "run",
      event: "run_failed",
      run: "run-owner-1",
      bot: "bot-owner-1",
      code: "laf:turn_unreachable",
      ms: 1_200,
    },
  ],
  ...overrides,
});

async function render(scenario: FeedbackScenario): Promise<FeedbackShown> {
  const directory = mkdtempSync(join(tmpdir(), "feedback-render-"));
  const file = join(directory, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/feedback-render.tsx"), file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("FEEDBACK_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the Korean render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("FEEDBACK_RENDER ".length)) as FeedbackShown;
}

describe("the diagnostic details in the 문의·의견 box", () => {
  test("are gathered only when ticked, shown in Korean, and sent as the id of what was shown", async () => {
    const shown = await render({
      bundles: [bundle()],
      expireFirstSend: false,
      message: "봇이 답을 안 해요",
    });

    expect(shown.gatheredBeforeTick).toBe(0);
    expect(shown.gathered).toBe(1);

    // The preview, read as a person reads it.
    for (const said of [
      "보낼 진단 정보 보기",
      "앱 버전",
      "edge (eeea985)",
      "서버 상태",
      "일부 멈춤",
      "데이터베이스 정상",
      "봇 서버 멈춤",
      "최근 7일 동안의 실패",
      "laf:turn_unreachable 3번",
      "최근 기록",
      "2개",
      "agent_stream_stalled · 60초",
      "run_failed · laf:turn_unreachable · 1.2초",
      "이름·코드·시간만 담겨요.",
      "보내는 그대로 보기",
    ]) {
      expect({ said, shown: shown.preview.includes(said) }).toEqual({
        said,
        shown: true,
      });
    }
    // No English sentence of the box's own: every word Latin letters make is a fact from the bundle.
    const facts = shown.preview
      .replace(/laf:[a-z_.:]+/g, "")
      .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, "")
      .replace(/edge \(eeea985\)/g, "");
    expect(facts).not.toMatch(/[A-Za-z]{2,}/);

    // The fold inside it is the bundle, exactly.
    expect(JSON.parse(shown.exact)).toEqual(bundle());

    // What left the browser: the words and the id. None of the bundle rode along.
    expect(shown.posts).toEqual([
      { text: "봇이 답을 안 해요", diagnostics: { id: "preview-1" } },
    ]);
    const posted = JSON.stringify(shown.posts);
    for (const inside of [
      "run_failed",
      "bot-owner-1",
      "laf:turn_unreachable",
    ]) {
      expect(posted).not.toContain(inside);
    }

    expect(shown.receipt).toContain("보냈어요.");
    expect(shown.receipt).toContain("진단 정보도 함께 보냈어요.");
  }, 120_000);

  test("a part of the screen that failed and the window's connection check are both said in Korean, and sent as they are", async () => {
    const withScreen = bundle({
      // The two parts of a bundle the other package and this one each added, side by side.
      connectionCheck: {
        at: "2026-09-14T08:59:40.000Z",
        surface: "shell",
        checks: [
          { id: "server", state: "pass", reason: "answered", ms: 40 },
          { id: "liveScreenSocket", state: "fail", reason: "closed_early" },
        ],
      },
      events: [
        ...bundle().events,
        {
          at: "2026-09-14T08:59:30.000Z",
          source: "log",
          event: "screen_failed",
          level: "warn",
          svc: "server",
          section: "sidebar",
          route: "/channel/$channelId",
          kind: "TypeError",
          fingerprint: "a41c09e2b7f3",
          build: "v0.5.1",
          revision: "eeea9853c2d1",
          surface: "shell",
        },
      ],
    });
    const shown = await render({
      bundles: [withScreen],
      expireFirstSend: false,
      message: "봇 목록이 안 보여요",
    });

    expect(shown.preview).toContain(
      "screen_failed · 문제가 생긴 곳: 봇 목록 · TypeError",
    );
    expect(shown.preview).toContain("3개");
    for (const said of [
      "연결 점검",
      "2개 중 1개에서 문제가 보였어요.",
      "봇 화면 실시간 연결",
    ]) {
      expect({ said, shown: shown.preview.includes(said) }).toEqual({
        said,
        shown: true,
      });
    }
    // Still no English of the box's own: the event name and the error's kind are facts.
    const facts = shown.preview
      .replace(/laf:[a-z_.:]+/g, "")
      .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, "")
      .replace(/edge \(eeea985\)/g, "")
      .replace(/\bTypeError\b/g, "");
    expect(facts).not.toMatch(/[A-Za-z]{2,}/);
    // The fold is the bundle, the screen's facts included, exactly.
    expect(JSON.parse(shown.exact)).toEqual(withScreen);
  }, 120_000);

  test("a bundle the server no longer holds is gathered again and shown before anything goes", async () => {
    const newer = bundle({
      failures: [
        {
          code: "laf:turn_rate_limited",
          count: 1,
          lastAt: "2026-09-14T09:10:00.000Z",
        },
      ],
    });
    const shown = await render({
      bundles: [bundle(), newer],
      expireFirstSend: true,
      message: "다시 보내요",
    });

    expect(shown.refusal).toBe(
      "보여 드린 뒤로 진단 정보가 바뀌었어요. 다시 확인하고 보내 주세요.",
    );
    expect(shown.gathered).toBe(2);
    expect(shown.previewAfterRefusal).toContain("laf:turn_rate_limited 1번");
    expect(shown.posts).toEqual([
      { text: "다시 보내요", diagnostics: { id: "preview-1" } },
      { text: "다시 보내요", diagnostics: { id: "preview-2" } },
    ]);
    expect(shown.receipt).toContain("진단 정보도 함께 보냈어요.");
  }, 120_000);
});
