import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Logger } from "../../../shared/log";
import type { HubDatabase } from "../db/client";
import { hubBlobs } from "../db/schema";
import { blobPath } from "./store";

/**
 * Every blob the hub keeps is copied once to the company's blob bucket (`laf-hub-blobs-<회사>`,
 * whose current objects never expire), so a hub whose disk is lost can be rebuilt from its
 * database dump and that bucket. The copy goes through a WRITE-ONLY door laf-control mints for
 * that bucket alone and leaves on the hub VM at `/etc/laf-hub-blob-remote` — the same two
 * spellings as a person's VM's backup door (`/etc/laf-backup-remote`), read the same way:
 *
 * - a pre-authenticated URL ending in `/o/` (OCI): `PUT <door>/<key>` is the whole protocol;
 * - `s3 <region> <bucket> <key id> <secret>` (AWS, put-only keys): the same PUT, signed here.
 *
 * The key is the blob's path on the volume, `ab/cd/<sha256>`, so the bucket is the volume's shape
 * and a restore is "copy every key back to the same path". A blob never changes once written, so a
 * copy is never redone: `hub_blobs.mirrored_at` says it is there.
 *
 * The door is a secret — on OCI the URL itself is the credential — so it is read from its file on
 * each pass and never logged, and a failure is logged by its status or its code, never its message
 * (Bun's fetch errors carry the URL they failed on).
 */

/** Ten minutes: the retry for whatever an upload's own copy did not finish. */
export const MIRROR_EVERY_MS = 10 * 60 * 1000;

/** Rows read per query of a pass. */
const PAGE = 100;

export type BlobDoor =
  | { kind: "url"; base: string }
  | {
      kind: "s3";
      region: string;
      bucket: string;
      keyId: string;
      secret: string;
    };

/** The door file's content as laf-control writes it, or null when it is neither spelling. */
export function parseBlobDoor(text: string): BlobDoor | null {
  const value = text.trim();
  if (value.startsWith("s3 ")) {
    const [, region, bucket, keyId, secret, ...rest] = value.split(/\s+/);
    if (!region || !bucket || !keyId || !secret || rest.length > 0) return null;
    if (!/^[a-z0-9-]+$/.test(region) || !/^[a-z0-9.-]{3,63}$/.test(bucket)) {
      return null;
    }
    return { kind: "s3", region, bucket, keyId, secret };
  }
  if (!/^https?:\/\/\S+$/.test(value)) return null;
  return { kind: "url", base: value.replace(/\/+$/, "") };
}

/** A blob's object key: its path under the volume, `ab/cd/<sha256>`. */
export const blobKey = (sha256: string): string =>
  `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

const sha256Hex = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

/**
 * AWS Signature Version 4 for one request, as an `Authorization` header. Written here rather than
 * taken from a package: a PUT of a known hash is all the mirror sends. `path` is already encoded;
 * `headers` are the ones signed, `host` and `x-amz-date` among them.
 */
export function signAwsV4(input: {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  keyId: string;
  secret: string;
}): string {
  const amzDate = input.headers["x-amz-date"];
  if (!amzDate) throw new Error("x-amz-date is not set");
  const day = amzDate.slice(0, 8);
  const names = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, " "),
    ]),
  );
  const signedHeaders = names.join(";");
  const canonical = [
    input.method,
    input.path,
    input.query ?? "",
    ...names.map((name) => `${name}:${lower[name]}`),
    "",
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonical),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secret}`, day), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** `20130524T000000Z`. */
const amzDateOf = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export type MirrorFetch = (
  url: string,
  init: RequestInit & { headers: Record<string, string> },
) => Promise<Response>;

/** The status a door answered when it did not take the blob. */
export class DoorRefused extends Error {
  constructor(readonly status: number) {
    super(`door answered ${status}`);
  }
}

/**
 * One blob through the door. The body is the file on the volume, which Bun sends from the disk
 * without reading it into the heap; on S3 the payload hash signed is the blob's own name, so the
 * bucket checks every byte against it.
 */
export async function putBlob(
  door: BlobDoor,
  blob: { sha256: string; bytes: number; path: string },
  options: { fetch?: MirrorFetch; now?: () => Date } = {},
): Promise<void> {
  const send: MirrorFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const key = blobKey(blob.sha256);
  // A floor of a megabyte a second, so a gigabyte still finishes and a dead door does not hold a
  // pass forever.
  const signal = AbortSignal.timeout(60_000 + Math.ceil(blob.bytes / 1024));
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(blob.bytes),
  };
  let url: string;
  if (door.kind === "url") {
    url = `${door.base}/${key}`;
  } else {
    const host = `${door.bucket}.s3.${door.region}.amazonaws.com`;
    const signed = {
      host,
      "x-amz-content-sha256": blob.sha256,
      "x-amz-date": amzDateOf((options.now ?? (() => new Date()))()),
    };
    headers["x-amz-content-sha256"] = signed["x-amz-content-sha256"];
    headers["x-amz-date"] = signed["x-amz-date"];
    headers.authorization = signAwsV4({
      method: "PUT",
      path: `/${key}`,
      headers: signed,
      payloadHash: blob.sha256,
      region: door.region,
      service: "s3",
      keyId: door.keyId,
      secret: door.secret,
    });
    url = `https://${host}/${key}`;
  }
  const response = await send(url, {
    method: "PUT",
    headers,
    body: Bun.file(blob.path),
    signal,
  });
  // Drained either way, so the connection is free for the next blob.
  await response.arrayBuffer().catch(() => {});
  if (!response.ok) throw new DoorRefused(response.status);
}

/** What a failure may say in a log: a status or an error code, never a message that holds a URL. */
function failureOf(error: unknown): Record<string, unknown> {
  if (error instanceof DoorRefused) return { status: error.status };
  const code = (error as { code?: unknown; name?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  return {
    code: typeof code === "string" ? code : null,
    kind: typeof name === "string" ? name : null,
  };
}

/** How many blobs a live file version holds that the bucket does not have yet. */
export async function countUnmirrored(database: HubDatabase): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(hubBlobs)
    .where(and(isNull(hubBlobs.mirroredAt), gt(hubBlobs.refs, 0)));
  return row?.n ?? 0;
}

export type DoorState = "off" | "invalid" | "on";

export type BlobMirror = {
  /** Starts a pass now, or one more after the pass that is running. Never throws. */
  kick(): void;
  /** One pass over every blob not yet copied; settles when it ends. */
  pass(): Promise<{ door: DoorState; mirrored: number; failed: boolean }>;
  /** The door as the last pass found it. */
  door(): DoorState;
  /** Reads the door without copying anything or logging: for the boot line. */
  check(): Promise<DoorState>;
  start(everyMs?: number): void;
  stop(): Promise<void>;
};

export function createBlobMirror(options: {
  database: HubDatabase;
  dir: string;
  /** `HUB_BLOB_DOOR_FILE`, or null: mirroring is off. */
  doorFile: string | null;
  log: Logger;
  fetch?: MirrorFetch;
  now?: () => Date;
}): BlobMirror {
  const { database, dir, doorFile, log } = options;
  let state: DoorState = "off";
  let running: Promise<unknown> | null = null;
  // A kick that arrived during a pass: one more pass once it ends.
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Read on every pass, not once at boot: laf-control mints the door AFTER the hub is first up
   * (its create starts the stack, then wires the buckets), and a door added later must start
   * working without anybody restarting the hub. Only a change of state is logged.
   */
  const readDoor = async (quiet = false): Promise<BlobDoor | null> => {
    let next: DoorState = "off";
    let door: BlobDoor | null = null;
    if (doorFile) {
      try {
        door = parseBlobDoor(await readFile(doorFile, "utf8"));
        next = door ? "on" : "invalid";
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOENT") {
          log.warn("blob_mirror_door_unreadable", { code: code ?? null });
        }
      }
    }
    if (next !== state && !quiet) {
      // The file's name and the door's kind, never its content.
      log.info("blob_mirror_door", {
        state: next,
        ...(door ? { kind: door.kind } : {}),
      });
    }
    state = next;
    return door;
  };

  const runPass = async () => {
    const door = await readDoor();
    if (!door) return { door: state, mirrored: 0, failed: false };
    let mirrored = 0;
    let after = "";
    for (;;) {
      const rows = await database
        .select({ sha256: hubBlobs.sha256, bytes: hubBlobs.bytes })
        .from(hubBlobs)
        .where(
          and(
            isNull(hubBlobs.mirroredAt),
            gt(hubBlobs.refs, 0),
            gt(hubBlobs.sha256, after),
          ),
        )
        .orderBy(asc(hubBlobs.sha256))
        .limit(PAGE);
      for (const row of rows) {
        after = row.sha256;
        const path = blobPath(dir, row.sha256);
        if (!(await Bun.file(path).exists())) {
          // Its bytes are gone from this disk (src/files/routes.ts answers a read of it
          // `laf:hub_blob_restoring`); there is nothing to copy, and the next pass looks again.
          log.warn("blob_mirror_missing", { blob: row.sha256.slice(0, 12) });
          continue;
        }
        try {
          await putBlob(door, { ...row, path }, options);
        } catch (error) {
          // The door is down or refusing: the rest wait for the next pass rather than each
          // failing in turn against it.
          log.warn("blob_mirror_failed", {
            blob: row.sha256.slice(0, 12),
            ...failureOf(error),
          });
          return { door: state, mirrored, failed: true };
        }
        await database
          .update(hubBlobs)
          .set({ mirroredAt: sql`now()` })
          .where(eq(hubBlobs.sha256, row.sha256));
        mirrored += 1;
      }
      if (rows.length < PAGE) break;
    }
    if (mirrored > 0) log.info("blob_mirror_pass", { mirrored });
    return { door: state, mirrored, failed: false };
  };

  /**
   * One pass at a time, as a single chain: a kick during a pass asks for one more after it, so an
   * upload that lands mid-pass is copied without two passes racing over the same rows.
   */
  const pass = (): Promise<{
    door: DoorState;
    mirrored: number;
    failed: boolean;
  }> => {
    if (running) return running.then(() => pass());
    const current = runPass().finally(() => {
      running = null;
      if (again) {
        again = false;
        kick();
      }
    });
    running = current;
    return current;
  };

  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    pass().catch((error: unknown) =>
      log.warn("blob_mirror_pass_failed", failureOf(error)),
    );
  };

  return {
    kick,
    pass,
    door: () => state,
    async check() {
      await readDoor(true);
      return state;
    },
    start(everyMs = MIRROR_EVERY_MS) {
      kick();
      timer = setInterval(kick, everyMs);
    },
    async stop() {
      clearInterval(timer);
      again = false;
      await running?.catch(() => {});
    },
  };
}
