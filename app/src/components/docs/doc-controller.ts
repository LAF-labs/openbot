/**
 * One open document on this person's screen: its blocks as the editor draws them, what has been
 * typed and not yet saved, the one block this person holds, who else holds which, and the queue that
 * sends each change to the hub in order. Plain TypeScript with the doors handed in, so the rules are
 * held by tests that never draw a page (`app/tests/doc-controller.test.ts`); the editor
 * (`doc-editor.tsx`) draws what `snapshot()` says and tells it what the person did.
 *
 * ONE QUEUE, OPS BUILT WHEN THEY GO. Every change — a save, a split, a merge, a kind — joins one
 * queue, and its ops are written at the moment it is sent, not when the key was pressed: each op
 * reads the block as the previous answer left it, with its newest `version`. Two saves of one block
 * in flight at once would both carry the same version and the second would be refused as stale.
 *
 * A NEW BLOCK IS ON SCREEN BEFORE THE HUB HAS IT. Enter draws the block below at once, under an id
 * made here (`newBlockId`, which the hub keeps as the block's id), and puts the caret in it. What is
 * typed into it waits in the queue behind its `insert_after`; its hold is taken once the hub has it.
 *
 * THE PERSON'S TEXT WINS ON THEIR OWN SCREEN, AND THE HUB'S VERSION DECIDES. A fresh read never
 * overwrites the block being written or one with unsaved text: those keep what was typed and the
 * version it was typed against. If somebody else saved meanwhile, the save is refused (409), the
 * document is read again, the refused blocks are reopened with theirs, and the person is told in one
 * line.
 */
import type {
  DocBlock,
  DocBlockKind,
  DocHold,
  DocOp,
  OpenDoc,
} from "@/lib/hub/docs";
import { isStaleSave, newBlockId } from "@/lib/hub/docs";
import { RequestRefusedError } from "@/lib/refusals";
import {
  type BlockLock,
  createBlockLock,
  type LockAnswer,
  type LockClock,
} from "./block-lock";

export type DocRow = {
  /** The block's id — made here for a block drawn before the hub had it, and kept by the hub. */
  key: string;
  block: DocBlock;
  /** Drawn here, not yet taken by the hub. */
  isNew: boolean;
  /** Bumped when the open box must show `block.text` again (a refused save reopened). */
  reset: number;
};

export type DocNotice =
  | { kind: "stale" }
  | { kind: "busy"; name: string | null }
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
  /** One block again; null when it was deleted. */
  readBlock: (blockId: string) => Promise<DocBlock | null>;
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
  now: () => number;
};

const REAL_TIMERS: DocTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** How long after the last keystroke a block is saved. Short: others see it within a second. */
export const SAVE_AFTER_MS = 300;
/** Frames that arrive together (a batch of ops is several events) make one read. */
const READ_AFTER_MS = 60;

/** Kinds a person writes text into. A divider, a table, a file or a task link has no one box. */
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

const EMPTY_TABLE = (): string[][] => [
  ["", ""],
  ["", ""],
];

/** A table's cells, row by row, the first row the header (`attrs.rows`). */
export function tableRows(block: Pick<DocBlock, "attrs">): string[][] {
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
  return EMPTY_TABLE();
}

/**
 * What a block of `kind` carries beside its text when it becomes that kind: the hub refuses a key
 * another kind does not take, so a check turned into a paragraph sends `{}`, never its `checked`.
 */
function attrsFor(kind: DocBlockKind): Record<string, unknown> {
  if (kind === "check") return { checked: false };
  if (kind === "table") return { rows: EMPTY_TABLE() };
  return {};
}

export type DocController = ReturnType<typeof createDocController>;

export function createDocController(options: {
  doors: DocDoors;
  meId?: string;
  timers?: DocTimers;
  /** The idempotency key of each batch. */
  newKey?: () => string;
  newBlockId?: () => string;
}) {
  const { doors } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  const makeBlockId = options.newBlockId ?? newBlockId;
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
  /** Typed and not yet sent, by block id. */
  const drafts = new Map<string, Patch>();
  const saveTimers = new Map<string, unknown>();
  /**
   * The newest version the hub gave each block — kept after the row leaves the screen, so a block
   * deleted while its own insert was still on the way is deleted with the version that insert got.
   */
  const versions = new Map<string, number>();
  let composing = false;
  let queue: Promise<void> = Promise.resolve();
  let readTimer: unknown = null;
  let pruneTimer: unknown = null;

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

  /** Who else holds `blockId` now, or null — a hold past its `until` is nobody's. */
  const holdOn = (blockId: string): DocHold | null =>
    state.holds.find(
      (hold) => hold.blockId === blockId && hold.until > timers.now(),
    ) ?? null;

  const busy = (blockId: string): DocNotice => ({
    kind: "busy",
    name: holdOn(blockId)?.name ?? null,
  });

  const lock: BlockLock = createBlockLock(
    { acquire: doors.lock, release: doors.unlock },
    (blockId) => {
      if (state.activeKey === blockId) set({ activeKey: null });
      set({ notice: { kind: "lost" } });
    },
    timers,
  );

  /* ── who else is writing ────────────────────────────────────────────────────────────────── */

  /**
   * Holds past their end are dropped when the first of them ends: a colleague whose tab died stops
   * being shown as writing when the hub stops honouring the hold, without waiting for a read.
   */
  const setHolds = (holds: DocHold[]) => {
    const now = timers.now();
    const live = holds.filter(
      (hold) => hold.memberId !== meId && hold.until > now,
    );
    if (pruneTimer !== null) timers.clearTimeout(pruneTimer);
    pruneTimer = null;
    const first = Math.min(...live.map((hold) => hold.until));
    if (Number.isFinite(first)) {
      pruneTimer = timers.setTimeout(
        () => {
          pruneTimer = null;
          setHolds(state.holds);
        },
        first - now + 50,
      );
    }
    set({ holds: live });
  };

  /* ── the queue ──────────────────────────────────────────────────────────────────────────── */

  /**
   * One change, sent after every change before it. `build` writes the ops when it is this change's
   * turn (null: nothing left to send); `done` takes the blocks the hub wrote; `undo` puts the screen
   * back when the hub refused.
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
        refused(
          error,
          ops.flatMap((op) =>
            op.op === "insert_after" ? [op.newId] : [op.id],
          ),
        );
      }
    });
    return queue;
  };

  const refused = (error: unknown, touched: readonly string[]) => {
    if (isStaleSave(error)) {
      set({ notice: { kind: "stale" } });
      void refresh(touched);
      return;
    }
    if (
      error instanceof RequestRefusedError &&
      error.code === "laf:doc_block_busy"
    ) {
      set({ notice: { kind: "busy", name: null } });
      if (state.activeKey && touched.includes(state.activeKey)) {
        set({ activeKey: null });
        lock.release();
      }
      void refresh(touched);
      return;
    }
    set({
      notice: {
        kind: "failed",
        code: error instanceof RequestRefusedError ? error.code : null,
      },
    });
  };

  /** The hub's copy of a block onto its row, keeping what was typed since the op was built. */
  const took = (block: DocBlock | undefined) => {
    if (!block) return;
    versions.set(block.id, block.version);
    updateRow(block.id, (row) => {
      const pending = drafts.get(block.id);
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

  /** The `replace` for what was typed into `key`, taking it out of the drafts; null if nothing. */
  const replaceOp = (key: string): DocOp | null => {
    const row = rowOf(key);
    const patch = drafts.get(key);
    if (!row || row.isNew || !patch) return null;
    drafts.delete(key);
    return {
      op: "replace",
      id: key,
      version: versions.get(key) ?? row.block.version,
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
      (blocks) => took(blocks.find((block) => block.id === key)),
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

  /** Whether a read must leave this block as the person has it. */
  const isMine = (key: string) => key === state.activeKey || drafts.has(key);

  /**
   * The hub's document onto the screen, keeping what this person is writing — except the blocks
   * in `reopen`, whose save was refused: those take the hub's copy and the box shows it.
   */
  const load = (open: OpenDoc, reopen: readonly string[] = []) => {
    const before = new Map(state.rows.map((row) => [row.key, row]));
    const rows: DocRow[] = open.blocks.map((block) => {
      const mine = before.get(block.id);
      if (mine && reopen.includes(block.id)) {
        drafts.delete(block.id);
        cancelSave(block.id);
        versions.set(block.id, block.version);
        return { ...mine, block, isNew: false, reset: mine.reset + 1 };
      }
      if (mine && isMine(block.id)) return mine;
      versions.set(block.id, block.version);
      return { key: block.id, block, isNew: false, reset: mine?.reset ?? 0 };
    });
    // New blocks still on their way stay where they were drawn: after the row they followed.
    state.rows.forEach((row, index) => {
      if (!row.isNew || rows.some((one) => one.key === row.key)) return;
      const previous = state.rows[index - 1]?.key;
      const at = previous ? rows.findIndex((one) => one.key === previous) : -1;
      rows.splice(at + 1, 0, row);
    });
    const active = state.activeKey;
    const stillActive =
      active !== null && rows.some((row) => row.key === active);
    set({ rows, loaded: true, ...(stillActive ? {} : { activeKey: null }) });
    setHolds(open.holds);
    if (active && !stillActive) lock.release();
  };

  let reading: Promise<void> | null = null;
  let readAgain = false;
  let reopenNext: string[] = [];
  /** The document read again — once at a time, and once more if asked meanwhile. */
  const refresh = async (reopen: readonly string[] = []) => {
    reopenNext.push(...reopen);
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      do {
        readAgain = false;
        try {
          // After what is already queued: a read taken before a save lands would undo it on screen.
          await queue;
          const open = await doors.read();
          const reopening = reopenNext;
          reopenNext = [];
          load(open, reopening);
        } catch (error) {
          set({
            notice: {
              kind: "failed",
              code: error instanceof RequestRefusedError ? error.code : null,
            },
          });
          return;
        }
      } while (readAgain);
    })();
    await reading;
    reading = null;
  };

  /** One block read again after a colleague's save (`hub.doc.block_changed`). */
  const blockChanged = async (blockId: string) => {
    if (!rowOf(blockId)) {
      // A block this screen has never drawn: where it goes is in the whole document.
      await refresh();
      return;
    }
    await queue;
    let block: DocBlock | null;
    try {
      block = await doors.readBlock(blockId);
    } catch {
      await refresh();
      return;
    }
    if (isMine(blockId)) return;
    if (block === null) {
      set({ rows: state.rows.filter((row) => row.key !== blockId) });
      return;
    }
    const known = block;
    versions.set(blockId, known.version);
    updateRow(blockId, (row) => ({ ...row, block: known }));
  };

  /* ── what the person did ────────────────────────────────────────────────────────────────── */

  /** Writing stops: what was typed is saved and the hold let go. */
  const leave = () => {
    const key = state.activeKey;
    if (key) void save(key);
    lock.release();
    if (key) set({ activeKey: null });
  };

  const holdFor = (key: string) => {
    const row = rowOf(key);
    if (!row || row.isNew) return;
    void lock.hold(key).then((answer) => {
      if (state.activeKey !== key) return;
      if (answer === "busy") {
        set({ activeKey: null, notice: busy(key) });
        void refresh();
      } else if (answer === "gone") {
        set({ activeKey: null });
        void refresh();
      }
    });
  };

  /** Open a block for writing. Refused, with the reason on screen, when somebody else holds it. */
  const focus = (key: string, caret: number | "end" = "end"): boolean => {
    if (!rowOf(key)) return false;
    if (holdOn(key)) {
      set({ notice: busy(key) });
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

  /** The nearest block above (or below) that has a box, or null at the end. */
  const writableNear = (key: string, step: 1 | -1): DocRow | null => {
    const index = state.rows.findIndex((row) => row.key === key);
    for (let at = index + step; at >= 0 && at < state.rows.length; at += step) {
      const row = state.rows[at];
      if (row && WRITABLE.has(row.block.kind)) return row;
    }
    return null;
  };

  /** A new block after `key` (null: at the top), drawn now and sent in turn. */
  const insertAfter = (
    key: string | null,
    kind: DocBlockKind,
    text: string,
    attrs: Record<string, unknown> = attrsFor(kind),
  ) => {
    if (key !== null && !rowOf(key)) return;
    const id = makeBlockId();
    const fresh: DocRow = {
      key: id,
      block: { id, kind, text, attrs, version: 0, hash: "" },
      isNew: true,
      reset: 0,
    };
    const index =
      key === null ? -1 : state.rows.findIndex((one) => one.key === key);
    const rows = [...state.rows];
    rows.splice(index + 1, 0, fresh);
    const opens = WRITABLE.has(kind);
    if (opens) lock.release();
    set({
      rows,
      ...(opens ? { activeKey: id, caret: 0 } : {}),
    });
    if (key !== null) cancelSave(key);
    enqueue(
      () => {
        if (key !== null && (!rowOf(key) || rowOf(key)?.isNew)) return null;
        const now = rowOf(id);
        if (!now) return null;
        const ops: DocOp[] = [];
        const replace = key === null ? null : replaceOp(key);
        if (replace) ops.push(replace);
        const typed = drafts.get(id);
        drafts.delete(id);
        ops.push({
          op: "insert_after",
          id: key,
          newId: id,
          kind: typed?.kind ?? now.block.kind,
          text: typed?.text ?? now.block.text,
          attrs: typed?.attrs ?? now.block.attrs,
        });
        return ops;
      },
      (blocks) => {
        for (const block of blocks) took(block);
        if (state.activeKey === id) holdFor(id);
        if (drafts.has(id)) scheduleSave(id);
      },
      () => {
        set({ rows: state.rows.filter((one) => one.key !== id) });
        if (state.activeKey === id) set({ activeKey: null });
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

  /** The delete of `key`, by its id and the newest version the hub gave it. */
  const deleteOp = (key: string): DocOp | null => {
    const version = versions.get(key);
    return version === undefined ? null : { op: "delete", id: key, version };
  };

  /** Backspace in an empty block: it goes, and the caret goes to the end of the one above. */
  const remove = (key: string) => {
    const above = writableNear(key, -1);
    if (!rowOf(key) || !above || state.rows.length <= 1) return;
    if (holdOn(above.key)) {
      set({ notice: busy(above.key) });
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
        const op = deleteOp(key);
        return op ? [op] : null;
      },
      () => {},
    );
  };

  /** Backspace at the start of a block with text: its text joins the end of the block above. */
  const mergeUp = (key: string) => {
    const row = rowOf(key);
    const above = writableNear(key, -1);
    if (!row || !above) return;
    if (holdOn(above.key)) {
      set({ notice: busy(above.key) });
      return;
    }
    const joinAt = above.block.text.length;
    cancelSave(key);
    drafts.delete(key);
    lock.release();
    draft(above.key, { text: above.block.text + row.block.text });
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
        const remove = deleteOp(key);
        return [replace, remove].filter((op): op is DocOp => op !== null);
      },
      (blocks) => took(blocks.find((block) => block.id === above.key)),
    );
  };

  /** The `/` menu's choice, a markdown start, or a list ended: the block becomes `kind`. */
  const setKind = (key: string, kind: DocBlockKind, text?: string) => {
    if (!rowOf(key)) return;
    draft(key, {
      kind,
      attrs: attrsFor(kind),
      ...(text !== undefined ? { text } : {}),
      ...(kind === "divider" || kind === "table" ? { text: "" } : {}),
    });
    updateRow(key, (one) => ({ ...one, reset: one.reset + 1 }));
    void save(key);
    // A divider has no box: writing goes on in a new block under it, as in Notion.
    if (kind === "divider") insertAfter(key, "paragraph", "");
  };

  const toggleCheck = (key: string) => {
    const row = rowOf(key);
    if (!row || holdOn(key)) return;
    draft(key, {
      attrs: { ...row.block.attrs, checked: row.block.attrs.checked !== true },
    });
    void save(key);
  };

  /** A table's cells changed: its rows are the block, and its text stays empty. */
  const setTable = (key: string, rows: string[][]) => {
    draft(key, { attrs: { ...rowOf(key)?.block.attrs, rows }, text: "" });
    scheduleSave(key);
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    setMe(id: string | undefined) {
      meId = id;
    },
    load: (open: OpenDoc) => load(open),
    refresh: () => refresh(),
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
      const above = writableNear(key, -1);
      if (above) focus(above.key, "end");
    },
    focusBelow(key: string) {
      const below = writableNear(key, 1);
      if (below) focus(below.key, 0);
    },
    dismiss: () => set({ notice: null }),
    /** `hub.doc.changed`: the document read whole again, once for a burst of frames. */
    changed() {
      if (readTimer !== null) return;
      readTimer = timers.setTimeout(() => {
        readTimer = null;
        void refresh();
      }, READ_AFTER_MS);
    },
    /** `hub.doc.block_changed`: that one block read again. */
    blockChanged,
    /** `hub.doc.lock`: somebody took, renewed (`hold`) or let go (`null`) of a block. */
    held(blockId: string, hold: DocHold | null) {
      const others = state.holds.filter((one) => one.blockId !== blockId);
      setHolds(hold ? [...others, hold] : others);
    },
    /** Waits until everything queued so far has been answered (for tests and for leaving). */
    settled: () => queue,
    /**
     * The page is going: what was typed is sent now and the hold let go. Not final — React's strict
     * mode closes a page's effects and opens them again, and the same controller goes on.
     */
    close() {
      for (const key of [...drafts.keys()]) void save(key);
      lock.release();
      if (state.activeKey) set({ activeKey: null });
      if (readTimer !== null) timers.clearTimeout(readTimer);
      if (pruneTimer !== null) timers.clearTimeout(pruneTimer);
      readTimer = null;
      pruneTimer = null;
    },
  };
}
