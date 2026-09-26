/**
 * `bun run eval:from-failures`: the week's 못 끝냄 turns, as eval scenario skeletons.
 *
 * THE LOOP THE TEAM-LEAD PLAN ASKS FOR (Tech §1): measure real success, and turn every turn the Bot
 * did not finish into a scenario the next model and the next harness must pass. The measuring is the
 * ledger's (`server/src/runner/run-ledger.ts`); this is the second half — one skeleton per unfinished
 * turn, in the shape `evals/scenarios.ts` runs.
 *
 * SKELETONS, BECAUSE NOTHING HERE MAY CARRY THE CONVERSATION. What a turn leaves behind is its day,
 * where it came from, the reason code it ended on and its counts (`insights/turns.ts`, `unfinished`):
 * no id, no label, no error text, no message. The owner's request and what finishing it looks like
 * are for a person to write — from what the operator knows of the failure, not from the transcript.
 *
 * Two sources, the same cells:
 *   - `DATABASE_URL` — this deployment's own database, read with the fleet's statement;
 *   - `--from <file>` — an insights answer saved from a VM (`GET /api/admin/metrics/insights`, or
 *     laf-control's copy of the section), so the fleet's failures become stubs without a shell.
 *
 * `--days N` sets the window (default 7); the zone is `BOT_TIME_ZONE`, as the server reads it.
 */
import { readFileSync } from "node:fs";
import { createDatabase } from "../server/src/db/client";
import type {
  TurnsInsight,
  UnfinishedTurnCell,
} from "../server/src/insights/report";
import { turnsStatement } from "../server/src/insights/turns";

const DEFAULT_DAYS = 7;
const DEFAULT_ZONE = "Asia/Seoul";

/** What one skeleton is named: the day, its place in the list, and its code, all closed shapes. */
function stubId(cell: UnfinishedTurnCell, index: number): string {
  const [day, , code] = cell;
  const reason = code.replace(/^laf:/, "").replace(/[^a-z0-9]+/g, "-");
  return `failure-${day}-${index + 1}-${reason}`;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The skeletons as the TypeScript a person pastes into `evals/`, one per cell. Only the cell's facts
 * are printed, each through a number or a closed shape; the rest is TODO.
 */
export function stubsFrom(
  cells: readonly UnfinishedTurnCell[],
  header: { days: number; to: string; zone: string },
): string {
  const lines = [
    `// eval:from-failures — ${header.days} days to ${header.to} (${header.zone}): ${plural(cells.length, "turn", "turns")} ended 못 끝냄.`,
    "// Skeletons for a person to fill in. Nothing below came from a conversation: write the owner's",
    "// request and the check from what is known of the failure, never from the transcript.",
    'import type { Scenario } from "./scenarios";',
    "",
    "export const FROM_FAILURES: Scenario[] = [",
  ];
  cells.forEach((cell, index) => {
    const [day, origin, code, requests, tools, asked, retries, seconds] = cell;
    lines.push(
      "  {",
      `    // ${day} · ${origin} · ${code} · ${plural(requests, "model request", "model requests")}, ${plural(tools, "tool call", "tool calls")}, ${plural(asked, "approval", "approvals")} asked, ${plural(retries, "retry", "retries")}, ${seconds} s`,
      `    id: ${JSON.stringify(stubId(cell, index))},`,
      '    dimension: "tool-calls", // TODO: the dimension this failure belongs to',
      ...(origin === "routine" ? ['    mode: "routine",'] : []),
      "    messages: [",
      "      // TODO: the owner's request, written by a person",
      "    ],",
      "    tools: [],",
      "    check: () => ({",
      "      pass: false,",
      '      notes: ["TODO: what finishing this turn looks like"],',
      "    }),",
      "  },",
    );
  });
  lines.push("];", "");
  return lines.join("\n");
}

/** The section out of whatever was saved: a whole insights answer, or the section alone. */
function sectionOf(saved: unknown): TurnsInsight | null {
  if (!saved || typeof saved !== "object") return null;
  const record = saved as Record<string, unknown>;
  const section = "turns" in record ? record.turns : record;
  return section &&
    typeof section === "object" &&
    Array.isArray((section as { unfinished?: unknown }).unfinished)
    ? (section as TurnsInsight)
    : null;
}

/** A cell kept only when every field is the shape the statement writes; anything else is dropped. */
function wellFormed(cell: unknown): cell is UnfinishedTurnCell {
  if (!Array.isArray(cell) || cell.length !== 8) return false;
  const [day, origin, code, ...counts] = cell as unknown[];
  return (
    typeof day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    typeof origin === "string" &&
    /^[a-z]{1,20}$/.test(origin) &&
    typeof code === "string" &&
    /^laf:[a-z0-9_]{1,60}$/.test(code) &&
    counts.every(
      (count) => typeof count === "number" && Number.isInteger(count),
    )
  );
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const days = Number(flag("--days") ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days is a whole number of days from 1 to 365.");
  }
  const zone = process.env.BOT_TIME_ZONE || DEFAULT_ZONE;
  const to = new Date();
  const from = flag("--from");
  let section: TurnsInsight | null;
  if (from) {
    section = sectionOf(JSON.parse(readFileSync(from, "utf8")));
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("Set DATABASE_URL, or pass --from <saved insights>.");
    }
    const database = createDatabase(url, { max: 1 });
    const rows = await database.execute<{ value: string | null }>(
      turnsStatement({
        since: new Date(to.getTime() - days * 86_400_000),
        to,
        timeZone: zone,
      }),
    );
    const value = [...rows][0]?.value;
    section = value ? (JSON.parse(value) as TurnsInsight) : null;
    await database.$client.close();
  }
  if (!section) {
    throw new Error("No turns section to read: an image older than P3?");
  }
  const cells = section.unfinished.filter(wellFormed);
  process.stdout.write(stubsFrom(cells, { days, to: to.toISOString(), zone }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
