/**
 * What 라피's two hub tools ask the company hub, and how they read what it answers — the one place.
 *
 * THE HUB'S FEATURE ROUTES ARE BEING WRITTEN BESIDE THIS (files and search, rooms, skills and team
 * memory), each in a pull request of its own against the hub. This module is written against the
 * design's message formats and the rooms pull request's types; where a route lands with another
 * path or another field, the change is here and nowhere else — the tools (`tools.ts`) never spell a
 * path or read a hub body themselves.
 *
 * READ LENIENTLY, SHAPED STRICTLY. A hub one protocol version ahead may add fields; they are left
 * out of what the Bot reads, so a field the Bot has never been told about does not appear in a
 * result. A body that is not the shape at all is `null`, and the tool says the hub answered
 * something it could not read rather than handing the Bot half of it.
 */

/** A path segment from a model's argument: encoded, so an id cannot climb out of its route. */
const segment = (value: string) => encodeURIComponent(value);

export const HUB_TOOL_PATHS = {
  /** `POST /search {q, kinds?, limit}` — a read, sent as a POST because it carries a body. */
  search: "/search",
  /** `GET /files/:id/text?from=&limit=` — the file's extracted text, a range of it. */
  fileText: (id: string, from: number, limit: number) =>
    `/files/${segment(id)}/text?from=${from}&limit=${limit}`,
  skills: "/skills",
  skill: (slug: string) => `/skills/${segment(slug)}`,
  /** Confirmed lines only: the hub never lists a proposal here. */
  memory: "/memory",
  memoryProposals: "/memory/proposals",
  members: "/members",
  rooms: "/rooms",
  /** No `since` and no `before` is the newest page — what a 라피 reads before it answers. */
  roomMessages: (id: string, limit: number) =>
    `/rooms/${segment(id)}/messages?limit=${limit}`,
  roomPost: (id: string) => `/rooms/${segment(id)}/messages`,
} as const;

/**
 * The task board, as this VM's 라피 works it (`task-pickup.ts`). The hub's side is #253's
 * `hub/src/tasks.ts`; the shapes below are written against it.
 */
export const HUB_TASK_PATHS = {
  /** `GET /tasks?stage=todo&limit=&cursor=` — newest first, a page at a time. */
  waiting: (limit: number, cursor: string | null) =>
    `/tasks?stage=todo&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  /** `GET /tasks/:id` — the task and its notes. */
  task: (id: string) => `/tasks/${segment(id)}`,
  /** `POST {runId}` — one conditional UPDATE on the hub: of any number of runs asking, one wins. */
  checkout: (id: string) => `/tasks/${segment(id)}/checkout`,
  /** `POST {runId}` — the claim lasts five more minutes. */
  heartbeat: (id: string) => `/tasks/${segment(id)}/heartbeat`,
  /** `POST {runId}` — the claim ends; a task still `doing` goes back to `todo`. */
  release: (id: string) => `/tasks/${segment(id)}/release`,
  /** `PATCH {as:"bot", runId, stage, note}` — the move and its one line, in one transaction. */
  move: (id: string) => `/tasks/${segment(id)}`,
} as const;

/** The facts the task routes answer with that this VM acts on (`HUB_TASK_FACTS` on the hub). */
export const HUB_TASK_CODES = {
  /** Another run holds it, or it is not waiting. The run that asked stops and does not ask again. */
  taken: "laf:task_taken",
  /** This run no longer holds it: a person moved it, or the sweep freed it. The run stops. */
  notHeld: "laf:task_not_held",
} as const;

/**
 * How often a run holding a task says it is still at it: two beats inside the hub's five-minute
 * claim (`HUB_TASK_HEARTBEAT_MS` on the hub), so one lost beat does not lose the task.
 */
export const HUB_TASK_HEARTBEAT_MS = 2 * 60 * 1000;

/** The longest note a 라피 may leave: one line (`HUB_TASK_LIMITS.botNote` on the hub). */
export const HUB_TASK_BOT_NOTE_MAX = 500;

/** A page of waiting tasks, read at boot. */
export const HUB_TASK_PAGE = 100;

/** The kinds a search may be narrowed to, as the hub names them. */
export const HUB_SEARCH_KINDS = ["file", "skill", "room", "memory"] as const;
export type HubSearchKind = (typeof HUB_SEARCH_KINDS)[number];

export type HubSearchHit = {
  kind: string;
  id: string;
  title: string;
  where: string;
  snippet: string;
  at: string | null;
  by: string | null;
};

export type HubFileText = { text: string; truncated: boolean };
export type HubSkillHead = { slug: string; title: string; summary: string };
export type HubSkill = HubSkillHead & { instructions: string };
export type HubMemoryLine = { id: string; content: string; at: string | null };
export type HubMember = { id: string; name: string | null; role: string };
export type HubRoomHead = {
  id: string;
  name: string;
  members: string[];
  lastSeq: number;
};
export type HubRoomLine = {
  seq: number;
  by: string;
  text: string;
  mentions: string[];
  at: string | null;
};

/* ── request bodies ────────────────────────────────────────────────────────────────────────── */

export const searchBody = (input: {
  q: string;
  kinds: readonly HubSearchKind[];
  limit: number;
}) => ({
  q: input.q,
  ...(input.kinds.length > 0 ? { kinds: [...input.kinds] } : {}),
  limit: input.limit,
});

/**
 * A message 라피 posts. `as: "bot"` because it is this person's 라피 speaking, not the person — the
 * hub files it as `bot:<member>` and refuses a `lafi` mention from it, so two members' 라피 cannot
 * call each other back and forth.
 */
export const roomPostBody = (input: { text: string; mentions: string[] }) => ({
  text: input.text,
  mentions: input.mentions,
  as: "bot" as const,
});

/** A line put up for the team to confirm, with where it came from. */
export const memoryProposalBody = (input: {
  content: string;
  evidence: string;
}) => ({
  content: input.content,
  evidence: { kind: "chat", id: null, excerpt: input.evidence },
});

export const skillBody = (input: {
  title: string;
  summary: string;
  instructions: string;
}) => ({
  title: input.title,
  summary: input.summary,
  instructions: input.instructions,
});

/** `POST /checkout`, `/heartbeat` and `/release` all carry the run and nothing else. */
export const taskClaimBody = (runId: string) => ({ runId });

/**
 * A 라피's move of a task its run holds: `review` or `blocked` (never `done`, which the hub refuses
 * from a Bot), with its one line. Sent as one PATCH so a crash cannot leave the note without the
 * move or the move without the note.
 */
export const taskMoveBody = (input: {
  runId: string;
  stage: "review" | "blocked";
  note: string;
}) => ({
  as: "bot" as const,
  runId: input.runId,
  stage: input.stage,
  note: input.note,
});

/* ── answers ───────────────────────────────────────────────────────────────────────────────── */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** The array under `key`, each item read by `read` and dropped when it is not the shape. */
function listOf<T>(
  body: unknown,
  key: string,
  read: (item: Record<string, unknown>) => T | null,
): T[] | null {
  if (!isObject(body) || !Array.isArray(body[key])) return null;
  return (body[key] as unknown[])
    .filter(isObject)
    .map(read)
    .filter((item): item is T => item !== null);
}

export const readSearchHits = (body: unknown): HubSearchHit[] | null =>
  listOf(body, "hits", (hit) => {
    const id = str(hit.id);
    const kind = str(hit.kind);
    if (!id || !kind) return null;
    return {
      kind,
      id,
      title: str(hit.title) ?? "",
      where: str(hit.where) ?? "",
      snippet: str(hit.snippet) ?? "",
      at: str(hit.at),
      by: str(hit.by),
    };
  });

export function readFileText(body: unknown): HubFileText | null {
  if (!isObject(body)) return null;
  const text = str(body.text);
  if (text === null) return null;
  return { text, truncated: body.truncated === true };
}

const readSkillHead = (skill: Record<string, unknown>): HubSkillHead | null => {
  const slug = str(skill.slug);
  if (!slug) return null;
  return {
    slug,
    title: str(skill.title) ?? slug,
    summary: str(skill.summary) ?? "",
  };
};

export const readSkills = (body: unknown): HubSkillHead[] | null =>
  listOf(body, "skills", readSkillHead);

/** `GET /skills/:slug` answers the skill under `skill`, or at the top level. */
export function readSkill(body: unknown): HubSkill | null {
  const held = isObject(body) && isObject(body.skill) ? body.skill : body;
  if (!isObject(held)) return null;
  const head = readSkillHead(held);
  const instructions = str(held.instructions);
  if (!head || instructions === null) return null;
  return { ...head, instructions };
}

export const readMemory = (body: unknown): HubMemoryLine[] | null =>
  listOf(body, "lines", (line) => {
    const id = str(line.id);
    const content = str(line.content);
    if (!id || content === null) return null;
    return { id, content, at: str(line.at) };
  });

export const readMembers = (body: unknown): HubMember[] | null =>
  listOf(body, "members", (member) => {
    const id = str(member.id);
    if (!id) return null;
    return {
      id,
      name: str(member.name),
      role: str(member.role) ?? "member",
    };
  });

export const readRooms = (body: unknown): HubRoomHead[] | null =>
  listOf(body, "rooms", (room) => {
    const id = str(room.id);
    if (!id) return null;
    return {
      id,
      name: str(room.name) ?? "",
      members: strings(room.members),
      lastSeq: num(room.lastSeq) ?? 0,
    };
  });

export const readRoomMessages = (body: unknown): HubRoomLine[] | null =>
  listOf(body, "messages", (message) => {
    const seq = num(message.seq);
    const text = str(message.text);
    if (seq === null || text === null) return null;
    return {
      seq,
      by: str(message.by) ?? "",
      text,
      mentions: strings(message.mentions),
      at: str(message.at),
    };
  });

/** A task as this VM needs it: enough to decide whether it is this 라피's to take, and to run it. */
export type HubTaskView = {
  id: string;
  title: string;
  description: string | null;
  stage: string;
  assignee: string | null;
  /** Moves with every write, the sweep's included. */
  version: number;
  checkout: { runId: string; by: string } | null;
};

export type HubTaskNoteView = { by: string; runId: string | null };

const readTask = (task: Record<string, unknown>): HubTaskView | null => {
  const id = str(task.id);
  const stage = str(task.stage);
  const version = num(task.version);
  if (!id || !stage || version === null) return null;
  const held = isObject(task.checkout) ? task.checkout : null;
  const runId = held ? str(held.runId) : null;
  return {
    id,
    title: str(task.title) ?? "",
    description: str(task.description),
    stage,
    assignee: str(task.assignee),
    version,
    checkout: held && runId ? { runId, by: str(held.by) ?? "" } : null,
  };
};

/** `GET /tasks?…`: the page and where the next one starts. */
export function readTaskPage(
  body: unknown,
): { tasks: HubTaskView[]; next: string | null } | null {
  const tasks = listOf(body, "tasks", readTask);
  if (tasks === null || !isObject(body)) return null;
  return { tasks, next: str(body.next) };
}

/** `GET /tasks/:id`, a checkout's answer and a release's: the task under `task`; notes beside it. */
export function readTaskDetail(
  body: unknown,
): { task: HubTaskView; notes: HubTaskNoteView[] } | null {
  if (!isObject(body) || !isObject(body.task)) return null;
  const task = readTask(body.task);
  if (!task) return null;
  const notes =
    listOf(body, "notes", (note) => ({
      by: str(note.by) ?? "",
      runId: str(note.runId),
    })) ?? [];
  return { task, notes };
}

/* ── the budget ledger and the sub-Bot register ─────────────────────────────────────────────── */

/**
 * The hub's budget ledger and its register of sub-Bots, as this VM uses them (`budget.ts`,
 * `jobs.ts`). The hub's side is being written beside this (`/budget`, `/jobs`); the shapes are the
 * contract its pull request names, and where a route lands with another path the change is here.
 *
 * A SCOPE IS ONE STRING: `workspace` (always counted, named or not), `job:<id>` (a sub-Bot) or
 * `task:<id>` (a task on the board). The hub refuses a reservation that would take any of them over
 * its day, naming the first one that would.
 */
export type HubBudgetScope = "workspace" | `job:${string}` | `task:${string}`;

export const HUB_BUDGET_PATHS = {
  /** `POST {runId, scopes, amount}` — ok, or 409 `laf:budget_reached {scope}`. */
  reserve: "/budget/reserve",
  /** `POST {runId, actual}` — idempotent; a settle with no reservation is taken and recorded. */
  settle: "/budget/settle",
} as const;

export const HUB_BUDGET_CODES = {
  /** A scope's day is spent. The run does not start, and is not asked again. */
  reached: "laf:budget_reached",
} as const;

/**
 * What a run sets aside before it starts: one question's ceiling on this VM (agent-bot's
 * `MAX_QUESTION_COST_USD`), which is the most a run can spend before the VM's own guard stops it.
 */
export const HUB_BUDGET_RESERVE_USD = 0.2;

export const budgetReserveBody = (input: {
  runId: string;
  scopes: readonly HubBudgetScope[];
  amount: number;
}) => ({ runId: input.runId, scopes: [...input.scopes], amount: input.amount });

/** What the run cost, to the dollar's sixth place: the provider's figure, never rounded up. */
export const budgetSettleBody = (input: { runId: string; actual: number }) => ({
  runId: input.runId,
  actual:
    Number.isFinite(input.actual) && input.actual > 0
      ? Math.round(input.actual * 1e6) / 1e6
      : 0,
});

export const HUB_JOB_PATHS = {
  /** `GET` — every sub-Bot in the register: names, members, schedule lines. */
  list: "/jobs",
  /** `PUT {name, schedule, dailyUsd}` registers or renames; `GET` reads; `DELETE` takes it off. */
  job: (id: string) => `/jobs/${segment(id)}`,
  /**
   * The sub-Bot's definition on its way from the VM that ran it to the VM that runs it now. `PUT`
   * by the old runner, `GET` then `DELETE` by the new one. Never part of the register: the register
   * holds a name, two members, a schedule line and a limit, and this is gone once it is taken.
   */
  handoff: (id: string) => `/jobs/${segment(id)}/handoff`,
} as const;

/** A sub-Bot as the register holds it: no instruction, no result, nothing it found. */
export type HubJobView = {
  id: string;
  name: string;
  owner: string;
  runner: string;
  schedule: string | null;
};

export const jobRegisterBody = (input: {
  name: string;
  schedule: string | null;
}) => ({ name: input.name, schedule: input.schedule });

export function readJob(body: unknown): HubJobView | null {
  const held = isObject(body) && isObject(body.job) ? body.job : body;
  if (!isObject(held)) return null;
  const id = str(held.id);
  const owner = str(held.owner);
  const runner = str(held.runner) ?? owner;
  if (!id || !owner || !runner) return null;
  return {
    id,
    name: str(held.name) ?? "",
    owner,
    runner,
    schedule: str(held.schedule),
  };
}

/**
 * A routine's definition as it travels between two members' VMs: what the person wrote and when it
 * runs, and nothing the routine has done — no notepad, no answers, no token.
 */
export type JobDefinition = {
  name: string;
  instruction: string;
  summary: string | null;
  schedule:
    | { kind: "interval"; minutes: number }
    | { kind: "daily"; time: string; timeZone: string; days: number[] | null };
  delivery: "chat" | "feed";
};

export const jobHandoffBody = (input: {
  to: string;
  definition: JobDefinition;
}) => ({ to: input.to, definition: input.definition });

export function readJobHandoff(body: unknown): JobDefinition | null {
  const held =
    isObject(body) && isObject(body.handoff) ? body.handoff : (body ?? null);
  const definition =
    isObject(held) && isObject(held.definition) ? held.definition : null;
  if (!definition) return null;
  const name = str(definition.name);
  const instruction = str(definition.instruction);
  const schedule = isObject(definition.schedule) ? definition.schedule : null;
  if (!name || !instruction || !schedule) return null;
  const delivery = definition.delivery === "feed" ? "feed" : "chat";
  if (schedule.kind === "interval") {
    const minutes = num(schedule.minutes);
    if (minutes === null) return null;
    return {
      name,
      instruction,
      summary: str(definition.summary),
      schedule: { kind: "interval", minutes },
      delivery,
    };
  }
  if (schedule.kind === "daily") {
    const time = str(schedule.time);
    const timeZone = str(schedule.timeZone);
    if (!time || !timeZone) return null;
    const days = Array.isArray(schedule.days)
      ? schedule.days.filter(
          (day): day is number =>
            typeof day === "number" && Number.isInteger(day),
        )
      : null;
    return {
      name,
      instruction,
      summary: str(definition.summary),
      schedule: { kind: "daily", time, timeZone, days },
      delivery,
    };
  }
  return null;
}

/**
 * The person's "이 일감에서는 해도 돼", as the board is told it: the task goes back to waiting, with
 * one note saying who allowed what kind of action — the topic, the same facts the stop's own note
 * gave — and never a value. Sent as the member (no `as: "bot"`), because it is the member's decision;
 * the note's author on the hub is `m:<member>` and its time is the hub's, which is the who and the
 * when. `version` is the one the VM just read, so a person's edit in between wins (`laf:task_stale`).
 */
export const taskApprovalGrantedBody = (input: {
  version: number;
  topic: string;
}) => ({
  version: input.version,
  stage: "todo" as const,
  note: `laf:task_approval_granted topic:${input.topic}`.slice(
    0,
    HUB_TASK_BOT_NOTE_MAX,
  ),
});
