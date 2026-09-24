export class ChannelNotFoundError extends Error {
  readonly code = "laf:channel_not_found";
  readonly status = 404;

  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}
