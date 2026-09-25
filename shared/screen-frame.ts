/**
 * One live-screen frame on the wire: a binary websocket message, the picture's bytes as they are.
 *
 * It was JSON text with the JPEG in base64 (`{"type":"frame","data":"…"}`): a third larger than the
 * picture, then decoded back to bytes one character at a time in the viewer's browser. Measured
 * 2026-09-25 (performance audit): ~123 KB a frame at 25–30 fps on a Naver page, 3.1–3.7 MB/s. As
 * bytes, a message is a small header saying what the picture is — its size, and the site, which the
 * pane shows — then the JPEG:
 *
 *   [uint32 big-endian header length][header, UTF-8 JSON][JPEG]
 *
 * Everything else on the socket (errors, the probe) stays JSON text, so a reader tells the two apart
 * by the message's type — text or binary — before it reads a byte.
 */

export type FrameHeader = {
  type: "frame";
  width: number;
  height: number;
  /** The page's host only; null when there is no page. */
  site: string | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeScreenFrame(
  header: FrameHeader,
  jpeg: Uint8Array,
): Uint8Array {
  const head = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(jpeg, 4 + head.length);
  return out;
}

/** The header and the picture, or null for a message that is not a frame this can read. */
export function decodeScreenFrame(
  message: ArrayBuffer | Uint8Array,
): { header: FrameHeader; jpeg: Uint8Array } | null {
  const bytes =
    message instanceof Uint8Array ? message : new Uint8Array(message);
  if (bytes.length < 4) return null;
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  if (4 + length > bytes.length) return null;
  try {
    const header = JSON.parse(
      decoder.decode(bytes.subarray(4, 4 + length)),
    ) as FrameHeader;
    if (header?.type !== "frame") return null;
    return { header, jpeg: bytes.subarray(4 + length) };
  } catch {
    return null;
  }
}
