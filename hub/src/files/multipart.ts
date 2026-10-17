/**
 * A multipart/form-data body read AS IT ARRIVES, one part at a time, each part's bytes handed to
 * its sink as they come.
 *
 * WHY NOT `request.formData()` (or Hono's `parseBody`, which calls it): both hold the whole body in
 * memory before the first byte is looked at. A team file may be a gigabyte and the hub has three,
 * so one upload would take a third of the machine and two at once could take it down. Read this
 * way, a gigabyte costs the hub a chunk of the socket at a time, and a file over the limit is
 * refused at the byte that crosses it rather than after all of it has been held.
 *
 * Only what `PUT /files` needs: `Content-Disposition` with a `name` (and a `filename`), an optional
 * `Content-Type`, nothing nested. Header lines are at most `HEADER_MAX` bytes a part.
 */

export class MultipartInvalid extends Error {}

export type PartHeaders = {
  name: string;
  filename: string | null;
  contentType: string | null;
};

export type PartSink = {
  write(chunk: Uint8Array): void | Promise<void>;
  end(): void | Promise<void>;
};

const HEADER_MAX = 8 * 1024;
const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

/** The boundary a `Content-Type` names, or null when it is not multipart/form-data. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const [kind, ...params] = contentType.split(";");
  if (kind?.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const param of params) {
    const at = param.indexOf("=");
    if (at === -1) continue;
    if (param.slice(0, at).trim().toLowerCase() !== "boundary") continue;
    const value = param
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    // RFC 2046: 1 to 70 characters.
    return value.length >= 1 && value.length <= 70 ? value : null;
  }
  return null;
}

function parseHeaders(block: string): PartHeaders {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-type") contentType = value;
    if (key !== "content-disposition") continue;
    for (const piece of value.split(";").slice(1)) {
      const at = piece.indexOf("=");
      if (at === -1) continue;
      const param = piece.slice(0, at).trim().toLowerCase();
      const raw = piece.slice(at + 1).trim();
      const unquoted = raw.startsWith('"') ? raw.slice(1, -1) : raw;
      if (param === "name") name = unquoted;
      if (param === "filename") filename = unquoted;
    }
  }
  if (!name) throw new MultipartInvalid("part without a name");
  return { name, filename, contentType };
}

/**
 * Reads `body` part by part. `onPart` is called with each part's headers and returns the sink its
 * bytes go to; a sink that throws stops the read (the stream is cancelled) and the throw is
 * rethrown, so a size limit is enforced by the sink that counts.
 */
export async function readMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  onPart: (headers: PartHeaders) => PartSink,
): Promise<void> {
  // Every delimiter is CRLF "--" boundary; the first has no CRLF before it, so one is supplied.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const keep = delimiter.length - 1;
  const reader = body.getReader();
  let buffer: Buffer = Buffer.from(CRLF);
  let state: "preamble" | "after" | "headers" | "body" | "done" = "preamble";
  let sink: PartSink | null = null;

  const step = async (): Promise<boolean> => {
    // Returns true when it made progress and can be called again on the same buffer.
    if (state === "preamble" || state === "body") {
      const at = buffer.indexOf(delimiter);
      if (at === -1) {
        if (buffer.length > keep) {
          const out = buffer.subarray(0, buffer.length - keep);
          if (state === "body" && sink) await sink.write(out);
          // A copy of the few bytes kept, so the chunk they came from is not held on to.
          buffer = Buffer.from(buffer.subarray(buffer.length - keep));
        }
        return false;
      }
      if (state === "body" && sink) {
        if (at > 0) await sink.write(buffer.subarray(0, at));
        await sink.end();
        sink = null;
      }
      buffer = buffer.subarray(at + delimiter.length);
      state = "after";
      return true;
    }
    if (state === "after") {
      if (buffer.length < 2) return false;
      if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
        state = "done";
        return false;
      }
      // Transport padding (spaces, tabs) may sit before the CRLF.
      const crlf = buffer.indexOf(CRLF);
      if (crlf === -1) {
        if (buffer.length > 256) throw new MultipartInvalid("bad delimiter");
        return false;
      }
      buffer = buffer.subarray(crlf + 2);
      state = "headers";
      return true;
    }
    if (state === "headers") {
      const end = buffer.indexOf(HEADERS_END);
      if (end === -1) {
        if (buffer.length > HEADER_MAX) throw new MultipartInvalid("headers");
        return false;
      }
      const headers = parseHeaders(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + HEADERS_END.length);
      sink = onPart(headers);
      state = "body";
      return true;
    }
    return false;
  };

  /**
   * A new chunk in the middle of a part's bytes, WITHOUT COPYING IT. Measured with a 300 MB upload
   * from the same machine: joining every chunk to the bytes kept from the last one, a copy per
   * chunk, took the hub from 140 MB to 850 MB resident, all of it garbage the collector had not
   * reached yet. Here the chunk is searched and written where it lies; only the few bytes kept
   * for a delimiter cut in two are copied. Where the delimiter does start near the join, the
   * chunk is joined once and the general step takes it from there — once per part, not per chunk.
   */
  const feedPartBytes = async (chunk: Buffer): Promise<void> => {
    const kept = buffer;
    const head = Buffer.concat([kept, chunk.subarray(0, keep)]);
    // Too short to tell whether a delimiter starts in what was kept, or one does: the slow way.
    if (chunk.length < keep || head.indexOf(delimiter) !== -1) {
      buffer = Buffer.concat([kept, chunk]);
      return;
    }
    // Nothing kept begins a delimiter, so all of it is the part's.
    if (state === "body" && sink && kept.length > 0) await sink.write(kept);
    if (chunk.indexOf(delimiter) !== -1) {
      buffer = chunk;
      return;
    }
    const cut = chunk.length - keep;
    if (state === "body" && sink && cut > 0) {
      await sink.write(chunk.subarray(0, cut));
    }
    buffer = Buffer.from(chunk.subarray(cut));
  };

  // Read through a function: `step` moves the state, which the compiler cannot see from here.
  const finished = () => state === "done";
  const inPartBytes = () => state === "body" || state === "preamble";
  try {
    for (;;) {
      while (await step()) {}
      if (finished()) break;
      const { value, done } = await reader.read();
      if (done) throw new MultipartInvalid("body ended early");
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      if (inPartBytes()) await feedPartBytes(chunk);
      else
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  // Whatever follows the closing delimiter is an epilogue the format says to ignore.
  await reader.cancel().catch(() => {});
}
