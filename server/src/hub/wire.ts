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
  /** The team's documents, newest change first. */
  docs: "/docs",
  /** A document drawn as markdown, each block after a `<!-- <id> <hash> -->` line. */
  docMarkdown: (id: string) => `/docs/${segment(id)}/markdown`,
  /** A batch of block ops, all or none; 라피's each name the hash it read (`expectHash`). */
  docBlocks: (id: string) => `/docs/${segment(id)}/blocks`,
} as const;

/** The kinds a search may be narrowed to, as the hub names them. */
export const HUB_SEARCH_KINDS = [
  "file",
  "doc",
  "skill",
  "room",
  "memory",
] as const;
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
export type HubDocHead = {
  id: string;
  title: string;
  folder: string;
  at: string | null;
};
export type HubDocMarkdown = { rev: number | null; markdown: string };
/** What a batch wrote: each block's id, kind and new hash, so a next op can name it. */
export type HubDocWritten = {
  blocks: { id: string; kind: string; hash: string }[];
  deleted: string[];
};
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

export const readDocs = (body: unknown): HubDocHead[] | null =>
  listOf(body, "docs", (doc) => {
    const id = str(doc.id);
    if (!id) return null;
    return {
      id,
      title: str(doc.title) ?? "",
      folder: str(doc.folder) ?? "/",
      at: str(doc.updatedAt),
    };
  });

export function readDocMarkdown(body: unknown): HubDocMarkdown | null {
  if (!isObject(body)) return null;
  const markdown = str(body.markdown);
  if (markdown === null) return null;
  return { rev: num(body.rev), markdown };
}

export function readDocWritten(body: unknown): HubDocWritten | null {
  const blocks = listOf(body, "blocks", (block) => {
    const id = str(block.id);
    const hash = str(block.hash);
    if (!id || hash === null) return null;
    return { id, kind: str(block.kind) ?? "", hash };
  });
  if (!blocks || !isObject(body)) return null;
  return { blocks, deleted: strings(body.deleted) };
}
