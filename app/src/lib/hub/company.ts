/**
 * 회사: what the company hub holds for this person — its members, the rooms they are in, the team's
 * files and skills, and the team memory an admin confirms — read through this VM's own server
 * (`server/src/hub/routes-ui.ts`). Nothing here can reach the hub: the browser never learns its
 * address or the pass.
 *
 * LIVE BY NAME, NOT BY CONTENT. The hub's events say what changed and never carry it; the server
 * passes each to the app's socket as a `hub.<type>` frame (`lib/channels/use-channel-events.ts`),
 * and `hubKeysForFrame` says which of the reads below that frame makes stale. A message in one room
 * asks that room again, not every room and not the files.
 */
import { queryOptions } from "@tanstack/react-query";
import { HUB_UPLOAD_FILE_MAX_BYTES } from "@shared/hub/upload";
import { t } from "@/lib/i18n";
import { RequestRefusedError, requestOrRefusal } from "@/lib/refusals";
import { hubFactText, hubKeys } from "./status";

export type HubRole = "owner" | "admin" | "member";

export type CompanyMember = { id: string; name: string | null; role: HubRole };

export type CompanyMe = {
  ok: true;
  member: { id: string; role: HubRole; name: string | null };
  workspace: { id: string; name: string } | null;
};

export type CompanyRoom = {
  id: string;
  name: string;
  members: string[];
  lastSeq: number;
  createdBy: string | null;
  createdAt: string;
};

export type CompanyMessage = {
  seq: number;
  /** `m:<member id>` for a person, `bot:<member id>` for that person's Bot. */
  by: string;
  text: string;
  mentions: string[];
  at: string;
};

export type CompanyFile = {
  id: string;
  name: string;
  folder: string;
  size: number;
  version: number;
  mime: string | null;
  by: string | null;
  at: string;
};

export type CompanySkill = {
  slug: string;
  title: string;
  summary: string;
  version: number;
  at: string;
};

export type CompanyMemoryLine = {
  id: string;
  content: string;
  confirmedBy: string;
  at: string;
};

export type CompanyProposal = {
  id: string;
  content: string;
  proposedBy: string;
  evidence: { kind: string; id: string; excerpt: string };
  at: string;
};

export const companyKeys = {
  me: [...hubKeys.all, "me"] as const,
  members: [...hubKeys.all, "members"] as const,
  rooms: [...hubKeys.all, "rooms"] as const,
  messages: (roomId: string) => [...hubKeys.all, "room", roomId] as const,
  files: [...hubKeys.all, "files"] as const,
  skills: [...hubKeys.all, "skills"] as const,
  skill: (slug: string) => [...hubKeys.all, "skills", slug] as const,
  memory: [...hubKeys.all, "memory"] as const,
  proposals: [...hubKeys.all, "memory", "proposals"] as const,
};

type Key = readonly unknown[];

/**
 * The reads a hub frame makes stale. A kind this build does not know makes none: it names nothing
 * this screen draws, and asking everything again on every unknown event would be a storm on a hub
 * newer than the app.
 */
export function hubKeysForFrame(frame: {
  kind: string;
  refId?: unknown;
}): Key[] {
  const ref = typeof frame.refId === "string" ? frame.refId : null;
  switch (frame.kind) {
    case "hub.status":
      return [hubKeys.status];
    case "hub.member.changed":
      // A role or a name changed, or somebody joined or left: the roster, and who this person is.
      return [companyKeys.members, companyKeys.me, hubKeys.status];
    case "hub.room.changed":
      // Made, or somebody added or taken out. The ref is the room; its messages may be gone to us.
      return ref
        ? [companyKeys.rooms, companyKeys.messages(ref)]
        : [companyKeys.rooms];
    case "hub.room.message":
    case "hub.room.mention": {
      // `<room id>:<seq>` (`roomMessageRef` in shared/hub/protocol.ts).
      const room = ref ? ref.slice(0, ref.lastIndexOf(":")) : "";
      return room
        ? [companyKeys.messages(room), companyKeys.rooms]
        : [companyKeys.rooms];
    }
    case "hub.file.changed":
      return [companyKeys.files];
    case "hub.skill.changed":
      return [companyKeys.skills];
    case "hub.memory.changed":
      return [companyKeys.memory, companyKeys.proposals];
    case "hub.memory.proposals":
      return [companyKeys.proposals];
    default:
      return [];
  }
}

/** The hub's facts as this surface says them, the status line's four and the screen's own. */
export function companyFactText(code: string | null): string | null {
  switch (code) {
    case "laf:hub_full":
      return t("The company's file space is full.");
    case "laf:hub_file_too_large":
      return t("This file is too large. Files up to 1 GB can be shared.");
    case "laf:hub_busy":
      return t("The company server is busy. Try again in a moment.");
    case "laf:memory_not_proposed":
      return t("Somebody already decided on this line.");
    case "laf:request_invalid":
      return t("That could not be sent as it is.");
    default:
      return hubFactText(code);
  }
}

/** What a failed read or press says: the fact's words, or the general sentence. */
export function companyFailureText(error: unknown): string {
  const code = error instanceof RequestRefusedError ? error.code : null;
  return companyFactText(code) ?? t("That did not go through. Try again.");
}

async function read<T>(path: string): Promise<T> {
  return (await requestOrRefusal(path, undefined)) as T;
}

export const companyMeQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.me,
    queryFn: () => read<CompanyMe>("/api/hub/me"),
    staleTime: 60_000,
  });

export const companyMembersQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.members,
    queryFn: async () =>
      (await read<{ members: CompanyMember[] }>("/api/hub/members")).members,
    staleTime: 60_000,
  });

export const companyRoomsQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.rooms,
    queryFn: async () =>
      (await read<{ rooms: CompanyRoom[] }>("/api/hub/rooms")).rooms,
  });

/** The newest page of a room, oldest first. Older pages are not offered yet. */
export const ROOM_PAGE = 100;

export const companyMessagesQueryOptions = (roomId: string) =>
  queryOptions({
    queryKey: companyKeys.messages(roomId),
    queryFn: async () =>
      (
        await read<{ messages: CompanyMessage[]; more: boolean }>(
          `/api/hub/rooms/${encodeURIComponent(roomId)}/messages?limit=${ROOM_PAGE}`,
        )
      ).messages,
  });

export const companyFilesQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.files,
    queryFn: async () =>
      (
        await read<{ files: CompanyFile[]; next: string | null }>(
          "/api/hub/files",
        )
      ).files,
  });

export const companySkillsQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.skills,
    queryFn: async () =>
      (await read<{ skills: CompanySkill[] }>("/api/hub/skills")).skills,
  });

export const companySkillQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: companyKeys.skill(slug),
    queryFn: async () =>
      (
        await read<{ skill: CompanySkill & { instructions: string } }>(
          `/api/hub/skills/${encodeURIComponent(slug)}`,
        )
      ).skill,
  });

export const companyMemoryQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.memory,
    queryFn: async () =>
      (await read<{ lines: CompanyMemoryLine[] }>("/api/hub/memory")).lines,
  });

export const companyProposalsQueryOptions = () =>
  queryOptions({
    queryKey: companyKeys.proposals,
    queryFn: async () =>
      (
        await read<{ proposals: CompanyProposal[] }>(
          "/api/hub/memory/proposals",
        )
      ).proposals,
  });

/** A write with a key made once per press, so a retried press is one write at the hub. */
export async function companyWrite(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  key: string,
): Promise<unknown> {
  return requestOrRefusal(path, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const isAdmin = (role: string | null | undefined): boolean =>
  role === "owner" || role === "admin";

/** A member's name as the screen says it, or the word for a member with none (or one who left). */
export function memberName(
  id: string,
  members: readonly CompanyMember[] | undefined,
): string {
  const found = members?.find((member) => member.id === id);
  if (!found) return t("A former member");
  return found.name?.trim() ? found.name : t("A member");
}

/** Who wrote a message: a person, or that person's Bot. */
export function authorOf(
  by: string,
  members: readonly CompanyMember[] | undefined,
): { name: string; isBot: boolean; memberId: string } {
  const at = by.indexOf(":");
  const kind = by.slice(0, at);
  const memberId = by.slice(at + 1);
  const name = memberName(memberId, members);
  return kind === "bot"
    ? { name: t("{name}'s Bot", { name }), isBot: true, memberId }
    : { name, isBot: false, memberId };
}

export function roleLabel(role: HubRole): string {
  switch (role) {
    case "owner":
      return t("Company owner");
    case "admin":
      return t("Company admin");
    default:
      return t("Company member");
  }
}

/** A file's size as a person reads it. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return t("{n} B", { n: bytes });
  if (bytes < 1024 * 1024) {
    return t("{n} KB", { n: Math.max(1, Math.round(bytes / 1024)) });
  }
  if (bytes < 1024 * 1024 * 1024) {
    return t("{n} MB", { n: (bytes / (1024 * 1024)).toFixed(1) });
  }
  return t("{n} GB", { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) });
}

/** Why a file is not even sent. Null when it may go. */
export function refusalBeforeTeamUpload(file: { size: number }): string | null {
  if (file.size === 0) return t("This file is empty.");
  if (file.size > HUB_UPLOAD_FILE_MAX_BYTES) {
    return t("This file is too large. Files up to 1 GB can be shared.");
  }
  return null;
}

/**
 * The multipart body the hub reads (`PUT /hub/v1/files`): `meta` first, then the bytes. The order
 * matters to the hub, which reads the parts as they arrive and must know the name before the blob.
 */
export function teamUploadBody(file: File, folder = "/"): FormData {
  const form = new FormData();
  form.append("meta", JSON.stringify({ name: file.name, folder }));
  form.append("blob", file, file.name);
  return form;
}

export async function uploadTeamFile(
  file: File,
  key: string,
): Promise<{ id: string; version: number }> {
  const response = await fetch("/api/hub/files", {
    method: "PUT",
    credentials: "include",
    headers: { "idempotency-key": key },
    body: teamUploadBody(file),
  });
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    id?: string;
    version?: number;
  } | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : null;
    throw new RequestRefusedError(
      companyFactText(code) ?? t("That did not go through. Try again."),
      response.status,
      code,
    );
  }
  return { id: body?.id ?? "", version: body?.version ?? 1 };
}

/** Where a file is opened: through this VM's server, saved rather than drawn. */
export function teamFileAddress(id: string): string {
  return `/api/hub/files/${encodeURIComponent(id)}/content`;
}
