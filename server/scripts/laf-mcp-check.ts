/**
 * The conformance check a customer runs before submitting an MCP server — the
 * same questions the registration surface asks, answerable in CI.
 *
 * Three verdicts: FAIL breaks the contract (exit 1), WARN will work but costs
 * something (registered as highest risk, truncated results, slow polls), OK is
 * silent. The checker never writes anything anywhere: it connects, lists,
 * calls `laf.watch` once, and judges.
 *
 *   bun server/scripts/laf-mcp-check.ts <url> [--token <bearer>] [--json]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/*
 * DELIBERATELY SELF-CONTAINED — no imports from this repository.
 *
 * This exact file is vendored into the public template repository
 * (LAF-labs/laf-mcp-template), where a customer's CI runs it without our
 * monorepo. The signal normalization below is the contract's, and
 * server/tests/mcp-check-mirror.test.ts holds it to what docs/laf/mcp-contract.md
 * §1 publishes — a checker that quietly used other limits would fail servers
 * that are correct by the only description their authors have. Change the
 * contract and this together, then copy this file into the template repository
 * verbatim.
 */
export const MAX_SIGNALS = 64;
export const MAX_TEXT = 500;
const SIGNAL_STATUSES = ["ok", "warn", "fail"] as const;
type SignalStatus = (typeof SIGNAL_STATUSES)[number];
type WatchSignal = {
  key: string;
  status: SignalStatus;
  value?: number | string;
  since?: string;
  detail?: string;
};

const isStatus = (value: unknown): value is SignalStatus =>
  (SIGNAL_STATUSES as readonly unknown[]).includes(value);

export function normalizeSignals(raw: unknown): WatchSignal[] {
  const list = Array.isArray((raw as { signals?: unknown[] })?.signals)
    ? ((raw as { signals: unknown[] }).signals as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  const seen = new Set<string>();
  const out: WatchSignal[] = [];
  for (const entry of list) {
    if (out.length >= MAX_SIGNALS) {
      break;
    }
    const candidate = entry as Record<string, unknown>;
    const key = typeof candidate?.key === "string" ? candidate.key.trim() : "";
    if (!key || key.length > MAX_TEXT || seen.has(key)) {
      continue;
    }
    if (!isStatus(candidate.status)) {
      continue;
    }
    seen.add(key);
    const signal: WatchSignal = { key, status: candidate.status };
    if (
      typeof candidate.value === "number" ||
      typeof candidate.value === "string"
    ) {
      signal.value =
        typeof candidate.value === "string"
          ? candidate.value.slice(0, MAX_TEXT)
          : candidate.value;
    }
    if (typeof candidate.since === "string") {
      signal.since = candidate.since.slice(0, MAX_TEXT);
    }
    if (typeof candidate.detail === "string") {
      signal.detail = candidate.detail.slice(0, MAX_TEXT);
    }
    out.push(signal);
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
/** The registration client truncates results here; near it is already a problem. */
const RESULT_CHAR_LIMIT = 20_000;
const RESULT_CHAR_WARN = 18_000;
const WATCH_LATENCY_WARN_MS = 5_000;
const WATCH_TOOL = "laf.watch";

type Verdict = { level: "ok" | "warn" | "fail"; check: string; note: string };

const verdicts: Verdict[] = [];
const record = (level: Verdict["level"], check: string, note: string) => {
  verdicts.push({ level, check, note });
};

function parseArguments(argv: string[]) {
  const positional: string[] = [];
  let token: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--token") {
      token = argv[index + 1];
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else if (argument) {
      positional.push(argument);
    }
  }
  return { url: positional[0], token, json };
}

async function main(): Promise<never> {
  const { url, token, json } = parseArguments(process.argv.slice(2));
  if (!url) {
    console.error(
      "사용법: bun laf-mcp-check.ts <url> [--token <bearer>] [--json]",
    );
    process.exit(64);
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "laf-mcp-check", version: "0.1.0" });

  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`${CONNECT_TIMEOUT_MS / 1000}초 안에 답하지 않음`),
            ),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    record("ok", "handshake", "initialize 성공");
  } catch (error) {
    record(
      "fail",
      "handshake",
      `접속 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    report();
  }

  type ListedTool = {
    name: string;
    annotations?: Record<string, unknown> | undefined;
  };

  let tools: ListedTool[] = [];
  try {
    const listed = await client.listTools();
    tools = (listed.tools ?? []) as ListedTool[];
    if (tools.length === 0) {
      record("fail", "tools/list", "툴이 하나도 없음");
    } else {
      record("ok", "tools/list", `툴 ${tools.length}개`);
    }
  } catch (error) {
    record(
      "fail",
      "tools/list",
      error instanceof Error ? error.message : String(error),
    );
  }

  const watch = tools.find((tool) => tool.name === WATCH_TOOL);
  if (!watch) {
    record("fail", WATCH_TOOL, "표준 툴이 없음 — 계약 §1");
  } else if (watch.annotations?.readOnlyHint !== true) {
    record(
      "fail",
      `${WATCH_TOOL} 어노테이션`,
      "readOnlyHint: true 여야 함 — 계약 §2",
    );
  } else {
    record("ok", `${WATCH_TOOL} 어노테이션`, "readOnlyHint 선언됨");
  }

  for (const tool of tools) {
    if (tool.name === WATCH_TOOL) {
      continue;
    }
    if (!tool.annotations || Object.keys(tool.annotations).length === 0) {
      record(
        "warn",
        `툴 '${tool.name}'`,
        "어노테이션 없음 — 등록 시 최고 위험(destructive) 취급됨",
      );
    }
  }

  if (watch) {
    const startedAt = Date.now();
    try {
      const result = (await client.callTool(
        { name: WATCH_TOOL, arguments: {} },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const elapsedMs = Date.now() - startedAt;
      if (result.isError) {
        record(
          "fail",
          `${WATCH_TOOL} 호출`,
          "서버가 에러를 반환 — 계약 §1.2: 장애도 신호로 답할 것",
        );
      } else {
        const text = (result.content ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("");
        if (text.length > RESULT_CHAR_WARN) {
          record(
            "warn",
            "결과 크기",
            `${text.length}자 — 등록 클라이언트는 ${RESULT_CHAR_LIMIT}자에서 자른다`,
          );
        }
        if (elapsedMs > WATCH_LATENCY_WARN_MS) {
          record("warn", "지연", `${elapsedMs}ms — 5초 안 권장`);
        } else {
          record("ok", "지연", `${elapsedMs}ms`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          record("fail", "응답 형식", "JSON 파싱 실패");
        }
        if (parsed !== undefined) {
          const rawCount = Array.isArray(
            (parsed as { signals?: unknown[] })?.signals,
          )
            ? (parsed as { signals: unknown[] }).signals.length
            : 0;
          const signals = normalizeSignals(parsed);
          if (rawCount === 0) {
            record(
              "warn",
              "signals",
              "빈 배열 — 감시할 것이 없다는 뜻인지 확인",
            );
          } else if (signals.length === 0) {
            record(
              "fail",
              "signals",
              `${rawCount}개 전부 스키마 불일치 — 계약 §1`,
            );
          } else {
            record(
              "ok",
              "signals",
              `유효 ${signals.length}개 (한도 ${MAX_SIGNALS})`,
            );
            if (signals.length < rawCount) {
              record(
                "warn",
                "signals",
                `${rawCount - signals.length}개는 스키마 불일치로 버려짐`,
              );
            }
          }
        }
      }
    } catch (error) {
      record(
        "fail",
        `${WATCH_TOOL} 호출`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  report();

  function report(): never {
    const failures = verdicts.filter((verdict) => verdict.level === "fail");
    const warnings = verdicts.filter((verdict) => verdict.level === "warn");
    if (json) {
      console.log(
        JSON.stringify({ url, verdicts, pass: failures.length === 0 }, null, 2),
      );
    } else {
      const mark = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
      for (const verdict of verdicts) {
        console.log(
          `${mark[verdict.level].padEnd(4)}  ${verdict.check}: ${verdict.note}`,
        );
      }
      console.log(
        failures.length === 0
          ? `\n등록 가능. (경고 ${warnings.length}건)`
          : `\n등록 불가 — FAIL ${failures.length}건을 고칠 것. (계약: mcp-contract.md)`,
      );
    }
    void client.close().catch(() => {});
    process.exit(failures.length === 0 ? 0 : 1);
  }
}

// Guarded so a test can import the normalization above without running a check.
if (import.meta.main) {
  await main();
}
