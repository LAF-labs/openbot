/**
 * A membership change this conversation will not accept, named so the surface can say it in Korean.
 *
 * `code` and never prose: the server sends facts and the app owns the words. The three of them are
 * different refusals with different things to do about them, which is why they are not one.
 */
export class ChannelMembershipError extends Error {
  readonly status = 409;

  constructor(readonly code: ChannelMembershipRefusal) {
    super(code);
    this.name = "ChannelMembershipError";
  }
}

export type ChannelMembershipRefusal =
  | "laf:already_in_room"
  | "laf:not_in_room"
  | "laf:room_too_small";

export class ChannelNotFoundError extends Error {
  readonly code = "laf:channel_not_found";
  readonly status = 404;

  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}
