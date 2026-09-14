import { eq, sql } from "drizzle-orm";
import {
  NOTEPAD_MAX_BYTES,
  NOTEPAD_MAX_KEYS,
  NOTEPAD_MAX_VALUE_CHARS,
  type NoteProblem,
  notepadBytes,
  noteProblem,
  type RoutineNote,
} from "../../../shared/prompt/notepad.ko";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import { ROUTINE_NOTE } from "../../../shared/tools/routine-note";
import {
  looksLikeAnInstruction,
  looksLikeASecret,
  looksLikePromptStructure,
} from "../agents/memory-store";
import type { Database } from "../db/client";
import { lafRoutineNotepads } from "../db/schema";
import type { Executor } from "../runner/thread-store";
import type { ToolOutcome, UnattendedToolkit } from "../runner/unattended";

/**
 * A routine's notepad: read when a run starts, written by that run through one tool, landed by its
 * settlement, cleared by a person.
 *
 * THE WRITE CHANNEL IS `routine_note`, OFFERED ONLY TO A ROUTINE'S OWN RUN (`withNotepad`). The
 * rung below it — a structured field the run's final answer carries — costs no schema, and was
 * skipped for the reason `shared/tools/routine-note.ts` writes down: a refused write has to reach
 * the run that made it, and the final answer is the one thing a run does after which it can be told
 * nothing. A cursor refused there stays where it was while the run that thought it moved it is
 * already over.
 *
 * NOTHING IS WRITTEN WHILE THE RUN IS OUT. Each call is checked and applied to a draft in memory;
 * the draft reaches the database in the settlement's transaction (`settlement.ts`), over the version
 * the run read, and only for a run whose record says it succeeded. So a run killed before its
 * record commits, a run that failed, and a run whose record rolled back all leave the cursor where
 * it was — the next run covers the same window again, which for a draft nobody received is the side
 * to fail on. And a person who cleared the notepad while the run was out is not overwritten by a
 * run that was working from the notepad they cleared.
 */

/** An entry as it is kept: what the prompt reads, and when the run that wrote it noted it. */
export type StoredNote = RoutineNote & { at: string };

export type Notepad = {
  entries: StoredNote[];
  /** 0 when the routine has never had one written. The fence a settlement writes over. */
  version: number;
  updatedAt: Date | null;
};

const EMPTY: Notepad = { entries: [], version: 0, updatedAt: null };

export async function readNotepad(
  database: Pick<Database, "select">,
  routineId: string,
): Promise<Notepad> {
  const [row] = await database
    .select({
      entries: lafRoutineNotepads.entries,
      version: lafRoutineNotepads.version,
      updatedAt: lafRoutineNotepads.updatedAt,
    })
    .from(lafRoutineNotepads)
    .where(eq(lafRoutineNotepads.routineId, routineId));
  if (!row) return EMPTY;
  return {
    entries: Array.isArray(row.entries) ? row.entries : [],
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** One run's writes, held in memory until its settlement. */
export type NotepadDraft = {
  readonly routineId: string;
  /** The version the run read. Its settlement writes over exactly this one, or not at all. */
  readonly baseVersion: number;
  /** The entries as the run's prompt showed them, without the times the person reads. */
  readonly read: RoutineNote[];
  /** Whether any call changed anything. An unchanged draft writes nothing and bumps nothing. */
  readonly changed: boolean;
  /** The notepad this run will leave behind if it settles. */
  entries(): StoredNote[];
  /** One `routine_note` call, checked and applied — or refused with the fact the run reads. */
  apply(args: Record<string, unknown>): ToolOutcome;
};

/** Which argument a shape problem is about, as the model named it. */
const FIELD_OF: Record<Exclude<NoteProblem, "value_too_long">, string> = {
  key: "key",
  value: "value",
  id: "lastId",
  time: "lastAt",
  watermark_empty: "lastId",
};

/** A string as a model may send an id: text, or a number it did not think to quote. */
function textArgument(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** The scans read lines by `\n`; a value that breaks its lines some other way is read the same. */
const asLines = (text: string) => text.replace(/[\r\u0085\u2028\u2029]/g, "\n");

const sameNote = (a: RoutineNote, b: RoutineNote) =>
  a.kind === "note" && b.kind === "note"
    ? a.value === b.value
    : a.kind === "watermark" &&
      b.kind === "watermark" &&
      a.lastId === b.lastId &&
      a.lastAt === b.lastAt;

export function draftOf(
  routineId: string,
  notepad: Notepad,
  now: () => Date,
): NotepadDraft {
  let entries: StoredNote[] = notepad.entries.map((entry) => ({ ...entry }));
  let changed = false;

  const room = (next: readonly RoutineNote[]) => ({
    keys: next.length,
    maxKeys: NOTEPAD_MAX_KEYS,
    bytes: notepadBytes(next),
    maxBytes: NOTEPAD_MAX_BYTES,
  });
  const refused = (
    code: `laf:notepad_${string}`,
    facts: Record<string, unknown> = {},
  ): ToolOutcome => ({
    ok: false,
    code,
    reason: toolResultText(code),
    ...facts,
  });
  const invalid = (field: string) =>
    refused("laf:notepad_arguments_invalid", { field });

  const apply = (args: Record<string, unknown>): ToolOutcome => {
    const key = typeof args.key === "string" ? args.key.trim() : "";

    if (args.action === "delete") {
      if (!entries.some((entry) => entry.key === key)) {
        return refused("laf:notepad_no_such_key", { key });
      }
      entries = entries.filter((entry) => entry.key !== key);
      changed = true;
      return {
        ok: true,
        code: "laf:notepad_deleted",
        reason: toolResultText("laf:notepad_deleted"),
        ...room(entries),
      };
    }

    let note: RoutineNote;
    if (args.action === "set") {
      if (typeof args.value !== "string") return invalid("value");
      note = { key, kind: "note", value: args.value.trim() };
    } else if (args.action === "watermark") {
      const lastId = textArgument(args.lastId);
      const lastAt = textArgument(args.lastAt);
      note = {
        key,
        kind: "watermark",
        ...(lastId !== undefined ? { lastId } : {}),
        ...(lastAt !== undefined ? { lastAt } : {}),
      };
    } else {
      return invalid("action");
    }

    const problem = noteProblem(note);
    if (problem === "value_too_long" && note.kind === "note") {
      return refused("laf:notepad_value_too_long", {
        chars: note.value.length,
        maxChars: NOTEPAD_MAX_VALUE_CHARS,
      });
    }
    if (problem) return invalid(FIELD_OF[problem as keyof typeof FIELD_OF]);

    /*
     * THE MEMORY STORE'S SCANS, because a notepad is read as prompt exactly as a memory is — by every
     * later run of this routine, under a heading that asks the model to treat it as a record. A key
     * is an identifier and only its structure is scanned: "reply_count" is not an order, and the
     * sentence scan would read the word "reply" at its start as one.
     *
     * A watermark's id is scanned for instructions and NOT for secrets. The newest order a shop
     * handled is a sixteen-digit number, which is the shape `looksLikeASecret` refuses as a card —
     * and a cursor that cannot hold an order number is not a cursor. A note's value gets both, and
     * the refusal says where a long number that is a cursor belongs.
     */
    if (looksLikePromptStructure(key.replace(/[_.-]+/g, " "))) {
      return refused("laf:notepad_looks_like_instruction", { field: "key" });
    }
    if (note.kind === "note" && looksLikeASecret(asLines(note.value))) {
      return refused("laf:notepad_looks_like_a_secret", { field: "value" });
    }
    const said = note.kind === "note" ? note.value : (note.lastId ?? "");
    if (said && looksLikeAnInstruction(asLines(said))) {
      return refused("laf:notepad_looks_like_instruction", {
        field: note.kind === "note" ? "value" : "lastId",
      });
    }

    const at = now().toISOString();
    const existing = entries.find((entry) => entry.key === key);
    const next: StoredNote[] = existing
      ? entries.map((entry) => (entry.key === key ? { ...note, at } : entry))
      : [...entries, { ...note, at }];
    if (
      next.length > NOTEPAD_MAX_KEYS ||
      notepadBytes(next) > NOTEPAD_MAX_BYTES
    ) {
      return refused("laf:notepad_full", room(entries));
    }
    // The same fact again is not a change: it would bump the version for nothing.
    if (!existing || !sameNote(existing, note)) {
      entries = next;
      changed = true;
    }
    return {
      ok: true,
      code: "laf:notepad_staged",
      reason: toolResultText("laf:notepad_staged"),
      ...room(entries),
    };
  };

  return {
    routineId,
    baseVersion: notepad.version,
    read: notepad.entries.map(({ at: _at, ...note }) => note as RoutineNote),
    get changed() {
      return changed;
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    apply,
  };
}

/**
 * The routine's run's tools, with `routine_note` beside them.
 *
 * Here and nowhere else: `createUnattendedTools` builds the same toolkit for a room turn, and a room
 * has no notepad to write. The call never leaves this process — the draft answers it.
 */
export function withNotepad(
  toolkit: UnattendedToolkit,
  draft: NotepadDraft,
): UnattendedToolkit {
  return {
    tools: [
      ...toolkit.tools,
      {
        name: ROUTINE_NOTE.name,
        description: ROUTINE_NOTE.description,
        parameters: ROUTINE_NOTE.parameters,
      },
    ],
    execute: async (name, args, call) =>
      name === ROUTINE_NOTE.name
        ? draft.apply(args)
        : toolkit.execute(name, args, call),
  };
}

/**
 * What became of a draft that changed something: `written`; `superseded`, dropped because the
 * notepad moved under the run; or `discarded`, because the run failed or its record rolled back.
 */
export type NotepadWrite = "written" | "superseded" | "discarded";

/**
 * The draft, written on the settlement's transaction over the version its run read.
 *
 * `superseded` when the notepad is no longer that version — a person cleared it while the run was
 * out — and the run's writes are dropped: they were made against a cursor that was reset under
 * them. Never thrown, because the rest of the record is still true and still has to be written.
 * Null when there was nothing to write.
 */
export async function settleNotepad(
  executor: Pick<Executor, "insert">,
  draft: NotepadDraft,
  runId: string,
  at: Date,
): Promise<Exclude<NotepadWrite, "discarded"> | null> {
  if (!draft.changed) return null;
  const written = await executor
    .insert(lafRoutineNotepads)
    .values({
      routineId: draft.routineId,
      entries: draft.entries(),
      version: draft.baseVersion + 1,
      writtenByRun: runId,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: lafRoutineNotepads.routineId,
      set: {
        entries: sql`excluded.entries`,
        version: sql`excluded.version`,
        writtenByRun: sql`excluded.written_by_run`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: eq(lafRoutineNotepads.version, draft.baseVersion),
    })
    .returning({ version: lafRoutineNotepads.version });
  return written.length > 0 ? "written" : "superseded";
}

/**
 * Empty the notepad, as a person asks for it. How many entries went, and zero when there were none.
 *
 * The version moves, so a run that was out when this happened lands nothing (`settleNotepad`).
 * Locked for the read so the count is the count of what this clear removed, not of what a
 * settlement committing in the same instant left behind.
 */
export async function clearNotepad(
  database: Pick<Database, "transaction">,
  routineId: string,
  at: Date,
): Promise<number> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction
      .select({ entries: lafRoutineNotepads.entries })
      .from(lafRoutineNotepads)
      .where(eq(lafRoutineNotepads.routineId, routineId))
      .for("update");
    const cleared = Array.isArray(row?.entries) ? row.entries.length : 0;
    if (cleared === 0) return 0;
    await transaction
      .update(lafRoutineNotepads)
      .set({
        entries: [],
        version: sql`${lafRoutineNotepads.version} + 1`,
        writtenByRun: null,
        updatedAt: at,
      })
      .where(eq(lafRoutineNotepads.routineId, routineId));
    return cleared;
  });
}
