import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CheckRow,
  CheckScenario,
  CheckShown,
} from "./support/connection-check-render";

/**
 * 연결 점검 ON A KOREAN SCREEN, REACHED THE THREE WAYS A PERSON REACHES IT.
 *
 * The logic is `connection-check.test.ts`; this is what somebody meets: the help page's button, the
 * line that says the connection was lost, and the 문의·의견 box — each opening the check over the
 * screen they were on, every row in Korean, a sentence under each one that did not pass, and 복사
 * putting codes on the clipboard. Rendered in a process of its own
 * (`support/connection-check-render.tsx`), because Base UI's dialog decides once per process
 * whether it can portal.
 */

const HEALTHY = {
  status: 200,
  body: {
    status: "ok",
    checks: { database: "ok", agentBot: "ok", computer: "ok" },
  },
};

async function render(scenario: CheckScenario): Promise<CheckShown> {
  const directory = mkdtempSync(join(tmpdir(), "connection-check-render-"));
  const file = join(directory, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/connection-check-render.tsx"), file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("CHECK_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the Korean render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("CHECK_RENDER ".length)) as CheckShown;
}

const row = (shown: CheckShown, id: string): CheckRow => {
  const found = shown.rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

describe("연결 점검 in the app", () => {
  test("from the help page, with everything up: every row passes, in Korean, and 복사 copies codes", async () => {
    const shown = await render({
      health: HEALTHY,
      sockets: "answer",
      serverClockAheadMs: 0,
      bots: ["agent_one"],
      via: "help",
    });

    expect(shown.rows.map((each) => [each.name, each.state])).toEqual([
      ["앱 서버", "pass"],
      ["데이터베이스", "pass"],
      ["봇 서버", "pass"],
      ["봇의 컴퓨터", "pass"],
      ["로그인", "pass"],
      ["보안 연결", "pass"],
      ["대화 실시간 연결", "pass"],
      ["봇 화면 실시간 연결", "pass"],
      ["기기 시계", "pass"],
    ]);
    expect(shown.summary).toStartWith("문제가 보이지 않았습니다.");
    // Latency where it means something, and the fact where it does not.
    expect(row(shown, "server").detail).toMatch(/^\d+ms$/);
    expect(row(shown, "conversationSocket").detail).toMatch(/^\d+ms$/);
    expect(row(shown, "botService").detail).toBe("정상");
    expect(row(shown, "secure").detail).toBe("개발용 로컬 주소");
    expect(row(shown, "clock").detail).toBe("1초 이내 차이");
    expect(shown.rows.every((each) => each.advice === "")).toBe(true);

    // The check's own sockets: the feed's and the screen's doors, each as a probe, for the person's Bot.
    expect(shown.sockets).toContain("/api/channels/events?probe=1");
    expect(shown.sockets).toContain("/api/computers/agent_one/stream?probe=1");

    const copied = shown.copied ?? "";
    expect(copied.split("\n")).toHaveLength(10);
    expect(copied).toMatch(/^connection-check \S+ surface=browser\n/);
    expect(copied).toContain("\nbotService pass ok\n");
    expect(copied).not.toMatch(/[가-힣]/);
  }, 60_000);

  test("from the lost-connection line: a stopped Bot service, blocked sockets and a fast clock each say what to try", async () => {
    const shown = await render({
      health: {
        status: 503,
        body: {
          status: "degraded",
          checks: { database: "ok", agentBot: "down", computer: "ok" },
        },
      },
      sockets: "refuse",
      serverClockAheadMs: -5 * 60_000,
      bots: ["agent_one"],
      via: "notice",
    });

    expect(shown.summary).toStartWith("9개 중 4개에서 문제가 보였습니다.");
    expect(row(shown, "server").state).toBe("pass");
    expect(row(shown, "botService")).toMatchObject({
      state: "fail",
      detail: "실패",
      advice:
        "봇이 답하게 하는 서버가 응답하지 않아 지금은 봇이 답할 수 없습니다 — 이 기기 문제는 아니니 몇 분 뒤에 다시 점검해 주세요.",
    });
    expect(row(shown, "conversationSocket").advice).toBe(
      "일반 요청은 서버에 닿지만 실시간 연결은 닿지 않습니다 — 회사·학교 네트워크나 보안 프로그램이 막고 있을 수 있으니 휴대폰 핫스팟 같은 다른 네트워크로 해 보세요.",
    );
    expect(row(shown, "liveScreenSocket").advice).toBe(
      "봇 화면도 같은 실시간 연결을 쓰니 위와 같습니다.",
    );
    expect(row(shown, "clock").advice).toBe(
      "이 기기의 시계가 서버보다 5분 빠릅니다 — 루틴 시각과 남은 시간이 어긋나 보이니 기기 설정에서 시간 자동 설정을 켜 주세요.",
    );

    const copied = shown.copied ?? "";
    expect(copied).toContain("\nbotService fail down\n");
    expect(copied).toMatch(
      /\nconversationSocket fail not_opened \d+ms close=1006\n/,
    );
    expect(copied).toMatch(/\nclock fail skewed skew=\+300s$/);
  }, 60_000);

  test("on the unreachable screen: it runs where the shell could not load, and says it is the server", async () => {
    // A bare 500 with no body: the development server's answer for a stopped API (measured).
    const shown = await render({
      health: { status: 500, body: null },
      sockets: "answer",
      serverClockAheadMs: 0,
      bots: [],
      via: "unreachable",
    });

    expect(row(shown, "server")).toMatchObject({
      state: "fail",
      advice:
        "주소는 답했지만 그 뒤의 앱 서버가 답하지 않았습니다 — 대개 저절로 풀리니 몇 분 뒤에 다시 점검해 주세요.",
    });
    for (const id of [
      "database",
      "botService",
      "computer",
      "session",
      "conversationSocket",
      "liveScreenSocket",
      "clock",
    ]) {
      expect(row(shown, id)).toMatchObject({
        state: "skip",
        advice: "서버가 답하지 않아 확인하지 않았습니다.",
      });
    }
    // Nothing behind a server that is not there is asked: no probe socket was opened.
    expect(shown.sockets.some((path) => path.includes("probe"))).toBe(false);
    expect(shown.copied).toContain("\nserver fail gateway ");
  }, 60_000);

  test("from the 문의·의견 box: it runs over the box, and the last result goes with the diagnostic details", async () => {
    const shown = await render({
      health: {
        status: 200,
        body: { status: "ok", checks: { database: "ok", agentBot: "ok" } },
      },
      sockets: "answer",
      serverClockAheadMs: 0,
      bots: [],
      via: "feedback",
    });

    // A deployment without a computer has no screen to check: skipped, and said why.
    expect(row(shown, "computer")).toMatchObject({
      state: "skip",
      detail: "건너뜀",
      advice: "이 서버에는 봇의 컴퓨터가 없습니다.",
    });
    expect(row(shown, "liveScreenSocket").state).toBe("skip");
    expect(shown.alsoSends).toBe(true);

    // What went with the read is the result — the same facts the rows were drawn from, and no words.
    const sent = shown.sentWithDiagnostics as {
      checks: Array<{ id: string; state: string }>;
    };
    expect(sent.checks.map((check) => [check.id, check.state])).toEqual(
      shown.rows.map((each) => [each.id, each.state]),
    );
    expect(JSON.stringify(sent)).not.toMatch(/[가-힣]/);
    expect(shown.preview).toContain("연결 점검문제가 보이지 않았습니다.");
  }, 60_000);
});
