// Vendored from https://github.com/tamaratran/fast-jev-compaction at e3f262a7f4d42bd8dd32ced30d26176f7cb545b0
// (MIT; see ./LICENSE). Not the npm package of the same name, which is a fork published elsewhere.
// Local changes are listed in ./README.md.

import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}
