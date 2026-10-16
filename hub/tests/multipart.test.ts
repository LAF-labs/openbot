import { describe, expect, test } from "bun:test";
import {
  boundaryOf,
  MultipartInvalid,
  readMultipart,
} from "../src/files/multipart";

const BOUNDARY = "----laf7MA4YWxk";

/** A body cut into pieces of `size` bytes, as a socket might hand it over. */
function streamOf(body: Buffer, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(body.subarray(at, at + size)));
      at += size;
    },
  });
}

function bodyOf(parts: { name: string; filename?: string; data: Buffer }[]) {
  const pieces: Buffer[] = [Buffer.from("preamble to ignore\r\n")];
  for (const part of parts) {
    const filename = part.filename ? `; filename="${part.filename}"` : "";
    pieces.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      part.data,
      Buffer.from("\r\n"),
    );
  }
  pieces.push(Buffer.from(`--${BOUNDARY}--\r\nepilogue`));
  return Buffer.concat(pieces);
}

async function read(body: Buffer, size: number) {
  const parts: Record<string, Buffer> = {};
  const names: (string | null)[] = [];
  await readMultipart(streamOf(body, size), BOUNDARY, (headers) => {
    const pieces: Buffer[] = [];
    names.push(headers.filename);
    return {
      write: (chunk) => {
        pieces.push(Buffer.from(chunk));
      },
      end: () => {
        parts[headers.name] = Buffer.concat(pieces);
      },
    };
  });
  return { parts, names };
}

// Bytes that look like a delimiter's start without being one, a lone CR, a lone LF, and every
// byte value, so a reader that matched part of the boundary and dropped it would be caught.
const tricky = Buffer.concat([
  Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}X\r\n--\r`),
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
  Buffer.from("\n정산 끝"),
]);

describe("readMultipart", () => {
  test.each([1, 3, 7, 19, 33, 64, 100_000])(
    "reads every part's bytes exactly, cut into pieces of %d bytes",
    async (size) => {
      const { parts, names } = await read(
        bodyOf([
          { name: "meta", data: Buffer.from('{"name":"정산.xlsx"}') },
          { name: "blob", filename: "정산.xlsx", data: tricky },
          { name: "empty", data: Buffer.alloc(0) },
        ]),
        size,
      );
      expect(parts.meta?.toString()).toBe('{"name":"정산.xlsx"}');
      expect(parts.blob?.equals(tricky)).toBe(true);
      expect(parts.empty?.length).toBe(0);
      expect(names).toEqual([null, "정산.xlsx", null]);
    },
  );

  test("a body that stops before its closing delimiter is refused", async () => {
    const whole = bodyOf([{ name: "blob", data: Buffer.from("half") }]);
    const cut = whole.subarray(0, whole.length - 20);
    await expect(read(cut, 5)).rejects.toBeInstanceOf(MultipartInvalid);
  });

  test("a part without a name is refused", async () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nx\r\n--${BOUNDARY}--`,
    );
    await expect(read(body, 4)).rejects.toBeInstanceOf(MultipartInvalid);
  });

  test("a sink that throws stops the read with its error", async () => {
    class Stop extends Error {}
    const body = bodyOf([{ name: "blob", data: Buffer.alloc(5000, 1) }]);
    let written = 0;
    const reading = readMultipart(streamOf(body, 100), BOUNDARY, () => ({
      write: (chunk) => {
        written += chunk.length;
        if (written > 1000) throw new Stop();
      },
      end: () => {},
    }));
    await expect(reading).rejects.toBeInstanceOf(Stop);
    expect(written).toBeLessThan(1200);
  });
});

describe("boundaryOf", () => {
  test.each([
    [`multipart/form-data; boundary=${BOUNDARY}`, BOUNDARY],
    [`Multipart/Form-Data; charset=utf-8; boundary="${BOUNDARY}"`, BOUNDARY],
    ["application/json", null],
    ["multipart/form-data", null],
    [undefined, null],
  ])("%s → %s", (header, expected) => {
    expect(boundaryOf(header)).toBe(expected);
  });
});
