import {
  lafiWorking,
  type RoomLine,
  roomAuthor,
  roomConversationId,
} from "@shared/hub/room-answers";
import type { ChannelSummary } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

/**
 * A team room's words for who said what and whose 라피 is working, for the screen that draws a
 * room. The rules are `@shared/hub/room-answers`, which the answering VM reads too; these are only
 * the words.
 *
 * `nameOf` is the room screen's own reading of the company's members (`GET /api/hub/…`); a member
 * it cannot name is 팀원, never an id.
 */
type NameOf = (member: string) => string | null | undefined;

const nameFor = (member: string, nameOf: NameOf) =>
  nameOf(member)?.trim() || t("A teammate");

/** Who wrote a message: the person by name, or "<name>의 라피" for their 라피's answer. */
export function roomAuthorName(by: string, nameOf: NameOf): string {
  const author = roomAuthor(by);
  if (!author) return t("A teammate");
  const name = nameFor(author.member, nameOf);
  return author.isLafi ? t("{name}'s Lafi", { name }) : name;
}

/**
 * One line for each member whose 라피 is answering a question in this room now — read off the
 * room, since nothing is posted while it works (`lafiWorking`).
 */
export function lafiWorkingLines(
  lines: readonly RoomLine[],
  now: Date,
  nameOf: NameOf,
): string[] {
  return lafiWorking(lines, now.getTime()).map(({ member }) =>
    t("{name}'s Lafi is looking into it", { name: nameFor(member, nameOf) }),
  );
}

/**
 * The conversation this person's 라피 answers the room in, once it has answered there: a room's
 * screen links to it (`/channel/$channelId`). Undefined before the first question.
 */
export function roomConversationOf(
  roomId: string,
  botId: string,
  channels: readonly ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  const id = roomConversationId(roomId, botId);
  return (channels ?? []).find(
    (channel) => channel?.id === id && channel.kind === "room",
  );
}

/** What a room's conversation is called, wherever a conversation is named. */
export function roomConversationName(channel: { name?: unknown }): string {
  const name = typeof channel.name === "string" ? channel.name.trim() : "";
  return t("Team room · {name}", { name: name || t("A team room") });
}
