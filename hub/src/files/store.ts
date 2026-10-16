import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PartSink } from "./multipart";

/**
 * The bytes on the hub's volume, by content: `<dir>/ab/cd/<sha256>`. A blob is written once and
 * never changed, so two uploads of the same file are one blob, a reader never meets a half-written
 * one, and copying the volume elsewhere is "copy what is not there yet".
 *
 * An upload is streamed to `<dir>/.incoming/<random>` while it is hashed, then renamed into place
 * — on the same volume, so the rename is atomic and a blob path holds either nothing or every
 * byte. Renaming over a blob that is already there is harmless: same name, same bytes.
 */

export class FileTooLarge extends Error {}
export class FilesFull extends Error {}

export function blobPath(dir: string, sha256: string): string {
  return join(dir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

const incomingDir = (dir: string) => join(dir, ".incoming");

/** Out of space, from the disk or the volume's quota: the hub is full, not broken. */
function isFull(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOSPC" || code === "EDQUOT";
}

export type Received = { path: string; sha256: string; bytes: number };

export type BlobReceiver = {
  sink: PartSink;
  /** Settles once the part has ended: the temporary file, its hash and its size. */
  done: Promise<Received>;
  /** Removes the temporary file, whatever happened. */
  discard(): Promise<void>;
};

/** A sink that hashes a part's bytes and writes them to a temporary file, up to `limit`. */
export async function receiveBlob(
  dir: string,
  limit: number,
): Promise<BlobReceiver> {
  await mkdir(incomingDir(dir), { recursive: true });
  const path = join(incomingDir(dir), randomUUID());
  let handle: FileHandle | null = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  let settle: (value: Received) => void = () => {};
  const done = new Promise<Received>((resolve) => {
    settle = resolve;
  });
  const close = async () => {
    const current = handle;
    handle = null;
    await current?.close();
  };
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      await close().catch(() => {});
      throw isFull(error) ? new FilesFull() : error;
    }
  };
  return {
    sink: {
      write: (chunk) =>
        guard(async () => {
          bytes += chunk.length;
          if (bytes > limit) throw new FileTooLarge();
          hash.update(chunk);
          if (!handle) throw new Error("blob part written after it ended");
          // Awaited, so a socket faster than the disk waits for the disk instead of piling up.
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            offset += bytesWritten;
          }
        }),
      end: () =>
        guard(async () => {
          // On the disk before the row that points at it commits: a crash after the commit must
          // not leave a version whose bytes were only ever in the page cache.
          await handle?.sync();
          await close();
          settle({ path, sha256: hash.digest("hex"), bytes });
        }),
    },
    done,
    async discard() {
      await close().catch(() => {});
      await rm(path, { force: true });
    },
  };
}

/** Moves a received file to its blob path. */
export async function placeBlob(
  dir: string,
  received: Received,
): Promise<void> {
  const target = blobPath(dir, received.sha256);
  try {
    await mkdir(join(target, ".."), { recursive: true });
    await rename(received.path, target);
  } catch (error) {
    throw isFull(error) ? new FilesFull() : error;
  }
}
