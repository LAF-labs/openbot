/**
 * One open document on this person's screen: its blocks as the editor draws them, what has been
 * typed and not yet saved, the one block this person holds, and the queue that sends each change to
 * the hub in order. Plain TypeScript with the doors handed in, so the rules are held by tests that
 * never draw a page (`app/tests/doc-controller.test.ts`); the editor (`doc-editor.tsx`) only draws
 * what `snapshot()` says and tells it what the person did.
 *
 * ONE QUEUE, OPS BUILT WHEN THEY GO. Every change — a save, a split, a merge, a kind — joins one
 * queue and its ops are written at the moment it is sent, not when the key was pressed. Two Enters
 * in a row make two new blocks, and the second's `insert_after` needs the first's id, which only the
 * hub's answer to the first gives; a save typed into a new block needs its id too. Built late, each
 * op reads the block as the previous answer left it: its real id and its newest `version`.
 *
 * A NEW BLOCK IS ON SCREEN BEFORE THE HUB HAS IT. Enter draws the block below at once and puts the
 * caret in it, under a key of its own; when the hub answers, the block takes the hub's id and keeps
 * its key, so React never remounts the box the person is typing in.
 *
 * THE PERSON'S TEXT WINS ON THEIR OWN SCREEN, AND THE HUB'S VERSION DECIDES. A fresh read never
 * overwrites the block being written or one with unsaved text: those keep what was typed and the
 * version it was typed against, and if somebody else saved meanwhile the save is refused (409) —
 * then the block is read again, reopened with theirs, and the person is told in one line.
 */
import type {
  DocBlock,
  DocBlockKind,
  DocHold,
  DocOp,
  OpenDoc,
} from "@/lib/hub/docs";
import { isStaleSave } from "@/lib/hub/docs";
import { RequestRefusedError } from "@/lib/refusals";
import {
  type BlockLock,
  createBlockLock,
  type LockAnswer,
  type LockClock,
} from "./block-lock";

export type DocRow = {
  /** React's key: the hub's id, or the key a new block was drawn under before it had one. */
  key: string;
  block: DocBlock;
  /** Drawn here, not yet taken by the hub. */
  isNew: boolean;
  /** Bumped when the open box must show `block.text` again (a stale save reopened). */
  reset: number;
};

export type DocNotice =
  | { kind: "stale" }
  | { kind: "busy"; memberId: string | null }
  | { kind: "lost" }
  | { kind: "failed"; code: string | null };

export type DocState = {
  rows: DocRow[];
  activeKey: string | null;
  /** Where the caret goes when the active box opens: an offset, or the end. */
  caret: number | "end";
  /** Blocks other members hold now. Never this person's own. */
  holds: DocHold[];
  notice: DocNotice | null;
  /** True once the first read has arrived. */
  loaded: boolean;
};

export type DocDoors = {
  read: () => Promise<OpenDoc>;
  save: (ops: DocOp[], key: string) => Promise<DocBlock[]>;
  lock: (blockId: string) => Promise<LockAnswer>;
  unlock: (blockId: string) => Promise<void>;
};

type Patch = {
  text?: string;
  kind?: DocBlockKind;
  attrs?: Record<string, unknown>;
};

export type DocTimers = LockClock & {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_TIMERS: DocTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long after the last keystroke a block is saved. Short: others see it within a second. */
export const SAVE_AFTER_MS = 400;
/** Frames that arrive together (a batch of ops is several events) make one read. */
const READ_AFTER_MS = 80;

/** Kinds a person writes text into. A divider, a file or a task link has no box. */
export const WRITABLE: ReadonlySet<DocBlockKind> = new Set([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "quote",
  "code",
]);

/** What a new block made by Enter is: a list goes on as a list, a heading is followed by text. */
export function kindAfter(kind: DocBlockKind): DocBlockKind {
  return kind === "list" || kind === "check" ? kind : "paragraph";
}

/** A table's cells, from its attrs, or from its text when the attrs carry none (`a | b` lines). */
export function tableRows(block: Pick<DocBlock, "text" | "attrs">): string[][] {
  const rows = block.attrs.rows;
  if (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (row) =>
        Array.isArray(row) && row.every((cell) => typeof cell === "string"),
    )
  ) {
    return rows as string[][];
  }
  const lines = block.text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0)
    return [
      ["", ""],
      ["", ""],
    ];
  return lines.map((line) => line.split("|").map((cell) => cell.trim()));
}

/** The text a table is searched and read by: one line per row, cells between bars. */
export function tableText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join(" | ")).join("\n");
}

function attrsFor(kind: DocBlockKind): Record<string, unknown> {
  if (kind === "check") return { checked: false };
  if (kind === "table")
    return {
      rows: [
        ["", ""],
        ["", ""],
      ],
    };
  return {};
}

export type DocController = ReturnType<typeof createDocController>;

export function createDocController(options: {
  doors: DocDoors;
  meId?: string;
  timers?: DocTimers;
  newKey?: () => string;
}) {
  const { doors } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  let meId = options.meId;

  let state: DocState = {
    rows: [],
    activeKey: null,
    caret: "end",
    holds: [],
    notice: null,
    loaded: false,
  };
  const listeners = new Set<() => void>();
  /** Typed and not yet sent, by row key. */
  const drafts = new Map<string, Patch>();
  const saveTimers = new Map<string, unknown>();
  /** The key a hub id is drawn under, for blocks that were new on this screen. */
  const keyOfId = new Map<string, string>();
  /**
   * The hub's id and newest version by row key — kept even after the row leaves the screen, so a
   * block deleted while its own insert was still on the way is deleted by the id that insert got.
   */
  const known = new Map<string, { id: string; version: number }>();
  let composing = false;
  let queue: Promise<void> = Promise.resolve();
  let readTimer: unknown = null;

  const set = (next: Partial<DocState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const rowOf = (key: string) => state.rows.find((row) => row.key === key);

  const updateRow = (key: string, change: (row: DocRow) => DocRow) => {
    set({
      rows: state.rows.map((row) => (row.key === key ? change(row) : row)),
    });
  };

  const holderOf = (blockId: string): string | null =>
    state.holds.find((hold) => hold.blockId === blockId)?.memberId ?? null;

  const lock: BlockLock = createBlockLock(
    { acquire: doors.lock, release: doors.unlock },
    (blockId) => {
      const key = keyOfId.get(blockId) ?? blockId;
      if (state.activeKey === key) set({ activeKey: null });
      set({ notice: { kind: "lost" } });
    },
    timers,
  );

  /* ── the queue ──────────────────────────────────────────────────────────────────────────── */

  /**
   * One change, sent after every change before it. `build` writes the ops when it is this change's
   * turn (null: nothing left to send); `done` takes the blocks the hub wrote.
   */
  const enqueue = (
    build: () => DocOp[] | null,
    done: (blocks: DocBlock[]) => void,
    undo: () => void = () => {},
  ) => {
    queue = queue.then(async () => {
      const ops = build();
      if (!ops || ops.length === 0) return;
      try {
        done(await doors.save(ops, newKey()));
      } catch (error) {
        undo();
        refused(error);
      }
    });
    return queue;
  };

  const refused = (error: unknown) => {
    if (isStaleSave(error)) {
      set({ notice: { kind: "stale" } });
      void refresh({ reopen: true });
      return;
    }
    if (
      error instanceof RequestRefusedError &&
      error.code === "laf:doc_block_busy"
    ) {
      set({ notice: { kind: "busy", memberId: null } });
      void refresh({ reopen: true });
      return;
    }
    set({
      notice: {
        kind: "failed",
        code: error instanceof RequestRefusedError ? error.code : null,
      },
    });
  };

  /** The hub's copy of a block onto its row, keeping text typed since the op was built. */
  const took = (key: string, block: DocBlock | undefined) => {
    if (!block) return;
    keyOfId.set(block.id, key);
    known.set(key, { id: block.id, version: block.version });
    updateRow(key, (row) => {
      const pending = drafts.get(key);
      return {
        ...row,
        isNew: false,
        block: {
          ...block,
          text: pending?.text ?? block.text,
          kind: pending?.kind ?? block.kind,
          attrs: pending?.attrs ?? block.attrs,
        },
      };
    });
  };

  /* ── saving what was typed ──────────────────────────────────────────────────────────────── */

  const cancelSave = (key: string) => {
    const timer = saveTimers.get(key);
    if (timer !== undefined) timers.clearTimeout(timer);
    saveTimers.delete(key);
  };

  const replaceOp = (key: string): DocOp | null => {
    const row = rowOf(key);
    const patch = drafts.get(key);
    if (!row || row.isNew || !patch) return null;
    drafts.delete(key);
    return {
      op: "replace",
      id: row.block.id,
      version: row.block.version,
      ...patch,
    };
  };

  const save = (key: string) => {
    cancelSave(key);
    if (!drafts.has(key)) return queue;
    let sent: Patch | undefined;
    return enqueue(
      () => {
        sent = drafts.get(key);
        const op = replaceOp(key);
        return op ? [op] : null;
      },
      (blocks) => took(key, blocks[0]),
      () => {
        // Kept for the next try unless something newer was typed meanwhile.
        if (sent && !drafts.has(key)) drafts.set(key, sent);
      },
    );
  };

  const scheduleSave = (key: string) => {
    cancelSave(key);
    if (composing) return;
    saveTimers.set(
      key,
      timers.setTimeout(() => {
        saveTimers.delete(key);
        void save(key);
      }, SAVE_AFTER_MS),
    );
  };

  const draft = (key: string, patch: Patch) => {
    drafts.set(key, { ...drafts.get(key), ...patch });
    updateRow(key, (row) => ({ ...row, block: { ...row.block, ...patch } }));
  };

  /* ── reading the hub ────────────────────────────────────────────────────────────────────── */

  /** The hub's document onto the screen, keeping what this person is writing. */
  const load = (open: OpenDoc, reopen = false) => {
    const before = new Map(state.rows.map((row) => [row.key, row]));
    const active = state.activeKey;
    const rows: DocRow[] = open.blocks.map((block) => {
      const key = keyOfId.get(block.id) ?? block.id;
      const mine = before.get(key);
      if (!known.has(key) || !(key === active || drafts.has(key))) {
        known.set(key, { id: block.id, version: block.version });
      }
      const isKept =
        mine !== undefined && !reopen && (key === active || drafts.has(key));
      if (isKept) return mine;
      if (mine && reopen && (key === active || drafts.has(key))) {
        drafts.delete(key);
        cancelSave(key);
        return { ...mine, block, isNew: false, reset: mine.reset + 1 };
      }
      return { key, block, isNew: false, reset: mine?.reset ?? 0 };
    });
    // New blocks still on their way stay where they were drawn: after the row they followed.
    state.rows.forEach((row, index) => {
      if (!row.isNew) return;
      const previous = state.rows[index - 1]?.key;
      const at = previous ? rows.findIndex((one) => one.key === previous) : -1;
      rows.splice(at + 1, 0, row);
    });
    const holds = open.holds.filter((hold) => hold.memberId !== meId);
    const stillActive = active && rows.some((row) => row.key === active);
    set({
      rows,
      holds,
      loaded: true,
      ...(stillActive ? {} : { activeKey: null }),
    });
    if (!stillActive && active) lock.release();
  };

  let reading: Promise<void> | null = null;
  let readAgain = false;
  const refresh = async (opts: { reopen?: boolean } = {}) => {
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      do {
        readAgain = false;
        try {
          // Wait for what is already queued: a read taken before a save lands would undo it here.
          await queue;
          load(await doors.read(), opts.reopen === true);
        } catch (error) {
          refused(error);
          return;
        }
      } while (readAgain);
    })();
    await reading;
    reading = null;
  };

  /* ── what the person did ────────────────────────────────────────────────────────────────── */

  const leave = () => {
    const key = state.activeKey;
    if (key) void save(key);
    lock.release();
    if (key) set({ activeKey: null });
  };

  const holdFor = (key: string) => {
    const row = rowOf(key);
    if (!row || row.isNew) return;
    void lock.hold(row.block.id).then((answer) => {
      if (state.activeKey !== key) return;
      if (answer === "busy") {
        set({
          activeKey: null,
          notice: { kind: "busy", memberId: holderOf(row.block.id) },
        });
        void refresh();
      } else if (answer === "gone") {
        set({ activeKey: null });
        void refresh();
      }
    });
  };

  /** Open a block for writing. Refused, with the reason on screen, when somebody else holds it. */
  const focus = (key: string, caret: number | "end" = "end"): boolean => {
    const row = rowOf(key);
    if (!row) return false;
    const holder = holderOf(row.block.id);
    if (holder) {
      set({ notice: { kind: "busy", memberId: holder } });
      return false;
    }
    if (state.activeKey === key) return true;
    leave();
    set({ activeKey: key, caret, notice: null });
    holdFor(key);
    return true;
  };

  const input = (key: string, text: string) => {
    draft(key, { text });
    scheduleSave(key);
  };

  /** The nearest block above that has a box, or null at the top. */
  const writableAbove = (key: string): DocRow | null => {
    const index = state.rows.findIndex((row) => row.key === key);
    for (let at = index - 1; at >= 0; at -= 1) {
      const row = state.rows[at];
      if (row && WRITABLE.has(row.block.kind)) return row;
    }
    return null;
  };

  const writableBelow = (key: string): DocRow | null => {
    const index = state.rows.findIndex((row) => row.key === key);
    for (let at = index + 1; at < state.rows.length; at += 1) {
      const row = state.rows[at];
      if (row && WRITABLE.has(row.block.kind)) return row;
    }
    return null;
  };

  /** A new block after `key`, drawn now and sent in turn; the caret goes into it. */
  const insertAfter = (
    key: string | null,
    kind: DocBlockKind,
    text: string,
    attrs: Record<string, unknown> = attrsFor(kind),
  ) => {
    if (key !== null && !rowOf(key)) return;
    const fresh: DocRow = {
      key: newKey(),
      block: { id: "", kind, text, attrs, version: 0, hash: "" },
      isNew: true,
      reset: 0,
    };
    const index =
      key === null ? -1 : state.rows.findIndex((one) => one.key === key);
    const rows = [...state.rows];
    rows.splice(index + 1, 0, fresh);
    lock.release();
    set({ rows, activeKey: WRITABLE.has(kind) ? fresh.key : null, caret: 0 });
    if (key !== null) cancelSave(key);
    enqueue(
      () => {
        const anchor = key === null ? null : rowOf(key);
        const now = rowOf(fresh.key);
        if ((key !== null && (!anchor || anchor.isNew)) || !now) return null;
        const ops: DocOp[] = [];
        const replace = key === null ? null : replaceOp(key);
        if (replace) ops.push(replace);
        const typed = drafts.get(fresh.key);
        drafts.delete(fresh.key);
        ops.push({
          op: "insert_after",
          id: anchor ? anchor.block.id : null,
          kind: typed?.kind ?? now.block.kind,
          text: typed?.text ?? now.block.text,
          attrs: typed?.attrs ?? now.block.attrs,
        });
        return ops;
      },
      (blocks) => {
        const anchorId = key === null ? null : rowOf(key)?.block.id;
        const made =
          blocks.find((block) => block.id !== anchorId) ?? blocks.at(-1);
        const replaced = blocks.find((block) => block.id === anchorId);
        if (key !== null && replaced) took(key, replaced);
        took(fresh.key, made);
        if (state.activeKey === fresh.key) holdFor(fresh.key);
        if (drafts.has(fresh.key)) scheduleSave(fresh.key);
      },
      () => {
        set({ rows: state.rows.filter((one) => one.key !== fresh.key) });
        if (state.activeKey === fresh.key) set({ activeKey: null });
      },
    );
  };

  /** Enter: this block keeps `head`, a block below takes `tail`. */
  const split = (key: string, head: string, tail: string) => {
    const row = rowOf(key);
    if (!row) return;
    if (head !== row.block.text) draft(key, { text: head });
    insertAfter(key, kindAfter(row.block.kind), tail);
  };

  /** Backspace in an empty block: it goes, and the caret goes to the end of the one above. */
  const remove = (key: string) => {
    const row = rowOf(key);
    const above = writableAbove(key);
    if (!row || !above || state.rows.length <= 1) return;
    if (holderOf(above.block.id)) {
      set({ notice: { kind: "busy", memberId: holderOf(above.block.id) } });
      return;
    }
    cancelSave(key);
    drafts.delete(key);
    lock.release();
    set({
      rows: state.rows.filter((one) => one.key !== key),
      activeKey: above.key,
      caret: "end",
    });
    holdFor(above.key);
    enqueue(
      () => {
        const last = known.get(key);
        return last
          ? [{ op: "delete", id: last.id, version: last.version }]
          : null;
      },
      () => {},
    );
  };

  /** Backspace at the start of a block with text: its text joins the end of the block above. */
  const mergeUp = (key: string) => {
    const row = rowOf(key);
    const above = writableAbove(key);
    if (!row || !above) return;
    if (holderOf(above.block.id)) {
      set({ notice: { kind: "busy", memberId: holderOf(above.block.id) } });
      return;
    }
    const joinAt = above.block.text.length;
    const text = above.block.text + row.block.text;
    cancelSave(key);
    drafts.delete(key);
    lock.release();
    draft(above.key, { text });
    set({
      rows: state.rows.filter((one) => one.key !== key),
      activeKey: above.key,
      caret: joinAt,
    });
    holdFor(above.key);
    cancelSave(above.key);
    enqueue(
      () => {
        const replace = replaceOp(above.key);
        const ops: DocOp[] = replace ? [replace] : [];
        const last = known.get(key);
        if (last)
          ops.push({ op: "delete", id: last.id, version: last.version });
        return ops;
      },
      (blocks) =>
        took(
          above.key,
          blocks.find((block) => block.id === above.block.id),
        ),
    );
  };

  /** The `/` menu's choice, or a markdown start: the block becomes `kind`. */
  const setKind = (key: string, kind: DocBlockKind, text?: string) => {
    const row = rowOf(key);
    if (!row) return;
    draft(key, {
      kind,
      attrs: attrsFor(kind),
      ...(text !== undefined ? { text } : {}),
      ...(kind === "divider" ? { text: "" } : {}),
    });
    updateRow(key, (one) => ({ ...one, reset: one.reset + 1 }));
    void save(key);
    // A divider has no box: writing goes on in a new block under it, as in Notion.
    if (!WRITABLE.has(kind) && kind !== "table")
      insertAfter(key, "paragraph", "");
  };

  const toggleCheck = (key: string) => {
    const row = rowOf(key);
    if (!row || holderOf(row.block.id)) return;
    draft(key, {
      attrs: { ...row.block.attrs, checked: row.block.attrs.checked !== true },
    });
    void save(key);
  };

  const setTable = (key: string, rows: string[][]) => {
    draft(key, {
      attrs: { ...rowOf(key)?.block.attrs, rows },
      text: tableText(rows),
    });
    scheduleSave(key);
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
    setMe(id: string | undefined) {
      meId = id;
    },
    load: (open: OpenDoc) => load(open),
    refresh,
    focus,
    leave,
    input,
    compositionStart() {
      composing = true;
      for (const key of [...saveTimers.keys()]) cancelSave(key);
    },
    compositionEnd(key: string, text: string) {
      composing = false;
      input(key, text);
    },
    split,
    remove,
    mergeUp,
    setKind,
    toggleCheck,
    setTable,
    insertAfter,
    focusAbove(key: string) {
      const above = writableAbove(key);
      if (above) focus(above.key, "end");
    },
    focusBelow(key: string) {
      const below = writableBelow(key);
      if (below) focus(below.key, 0);
    },
    dismiss: () => set({ notice: null }),
    /** A `hub.doc.*` frame about this document: read it again, once for a burst of frames. */
    changed() {
      if (readTimer !== null) return;
      readTimer = timers.setTimeout(() => {
        readTimer = null;
        void refresh();
      }, READ_AFTER_MS);
    },
    /** Waits until everything queued so far has been answered (for tests and for leaving). */
    settled: () => queue,
    /**
     * The page is going: what was typed is sent now and the hold let go. Not final — React's
     * strict mode closes a page's effects and opens them again, and the same controller goes on.
     */
    close() {
      for (const key of [...drafts.keys()]) void save(key);
      lock.release();
      if (state.activeKey) set({ activeKey: null });
      if (readTimer !== null) timers.clearTimeout(readTimer);
      readTimer = null;
    },
  };
}
