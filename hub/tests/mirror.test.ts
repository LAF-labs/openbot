import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { HUB_FACTS } from "../../shared/hub/protocol";
import { hubBlobs } from "../src/db/schema";
import {
  blobKey,
  type MirrorFetch,
  parseBlobDoor,
  putBlob,
  signAwsV4,
} from "../src/files/mirror";
import { blobPath } from "../src/files/store";
import { put } from "./support/files";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

describe("the door file", () => {
  test("an OCI pre-authenticated URL is a base to PUT under", () => {
    expect(
      parseBlobDoor(
        "https://objectstorage.ap-seoul-1.oraclecloud.com/p/tok/n/ns/b/laf-hub-blobs-acme/o/\n",
      ),
    ).toEqual({
      kind: "url",
      base: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/tok/n/ns/b/laf-hub-blobs-acme/o",
    });
  });

  test("AWS put-only keys are read word by word", () => {
    expect(
      parseBlobDoor(
        "s3 ap-northeast-2 laf-hub-blobs-acme AKIAEXAMPLE s3cr3t/+x\n",
      ),
    ).toEqual({
      kind: "s3",
      region: "ap-northeast-2",
      bucket: "laf-hub-blobs-acme",
      keyId: "AKIAEXAMPLE",
      secret: "s3cr3t/+x",
    });
  });

  test.each([
    [""],
    ["s3 ap-northeast-2 bucket key"],
    ["s3 ap-northeast-2 bucket key secret extra"],
    ["ftp://example.com/o/"],
    ["https://example.com/a b"],
  ])("%p is no door", (text) => {
    expect(parseBlobDoor(text)).toBeNull();
  });

  test("a blob's key is its path under the volume", () => {
    const hash = sha("x");
    expect(blobKey(hash)).toBe(
      `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
    );
  });
});

describe("AWS Signature Version 4", () => {
  // The examples in Amazon's S3 documentation ("Signature Calculations for the Authorization
  // Header"), with its example keys.
  const keys = {
    keyId: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  };

  test("GET Object", () => {
    const empty =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(
      signAwsV4({
        ...keys,
        method: "GET",
        path: "/test.txt",
        headers: {
          host: "examplebucket.s3.amazonaws.com",
          range: "bytes=0-9",
          "x-amz-content-sha256": empty,
          "x-amz-date": "20130524T000000Z",
        },
        payloadHash: empty,
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  test("PUT Object", () => {
    const payload = sha("Welcome to Amazon S3.");
    expect(
      signAwsV4({
        ...keys,
        method: "PUT",
        path: "/test%24file.text",
        headers: {
          date: "Fri, 24 May 2013 00:00:00 GMT",
          host: "examplebucket.s3.amazonaws.com",
          "x-amz-content-sha256": payload,
          "x-amz-date": "20130524T000000Z",
          "x-amz-storage-class": "REDUCED_REDUNDANCY",
        },
        payloadHash: payload,
      }),
    ).toEndWith(
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  test("a blob goes to the bucket's own host, signed with its own hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laf-hub-mirror-"));
    try {
      const bytes = "a team file";
      const path = join(dir, "blob");
      await writeFile(path, bytes);
      const sent: { url: string; headers: Record<string, string> }[] = [];
      const capture: MirrorFetch = async (url, init) => {
        sent.push({ url, headers: init.headers });
        return new Response(null, { status: 200 });
      };
      await putBlob(
        {
          kind: "s3",
          region: "ap-northeast-2",
          bucket: "laf-hub-blobs-acme",
          keyId: "AKIAEXAMPLE",
          secret: "secret",
        },
        { sha256: sha(bytes), bytes: bytes.length, path },
        { fetch: capture, now: () => new Date("2026-10-16T09:00:00.000Z") },
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(
        `https://laf-hub-blobs-acme.s3.ap-northeast-2.amazonaws.com/${blobKey(sha(bytes))}`,
      );
      expect(sent[0]?.headers["x-amz-content-sha256"]).toBe(sha(bytes));
      expect(sent[0]?.headers["x-amz-date"]).toBe("20261016T090000Z");
      expect(sent[0]?.headers.authorization).toStartWith(
        "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261016/ap-northeast-2/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A bucket door on port 0 that keeps what it is sent, and can be told to refuse. */
function startDoor() {
  const received: { path: string; bytes: number; sha256: string }[] = [];
  let status = 200;
  let onPut: () => void = () => {};
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (status !== 200) return new Response("down", { status });
      const body = new Uint8Array(await request.arrayBuffer());
      received.push({
        path: new URL(request.url).pathname,
        bytes: body.length,
        sha256: sha(body),
      });
      onPut();
      return new Response(null, { status: 200 });
    },
  });
  return {
    received,
    base: `http://127.0.0.1:${server.port}/p/tok/n/ns/b/laf-hub-blobs-acme/o/`,
    setStatus(next: number) {
      status = next;
    },
    nextPut: () =>
      new Promise<void>((resolve) => {
        onPut = resolve;
      }),
    stop: () => server.stop(true),
  };
}

describe("the mirror", () => {
  let hub: TestHub;
  let door: ReturnType<typeof startDoor>;
  let doorDir: string;
  let doorFile: string;
  let pass: string;

  beforeEach(async () => {
    doorDir = await mkdtemp(join(tmpdir(), "laf-hub-door-"));
    doorFile = join(doorDir, "blob-remote");
    door = startDoor();
    hub = await startTestHub({ blobDoorFile: doorFile });
    pass = newPass();
    await putMember(hub, {
      email: "a@example.com",
      vmOrigin: "https://a.example",
      pass,
    });
  });

  afterEach(async () => {
    await hub.stop();
    await door.stop();
    await rm(doorDir, { recursive: true, force: true });
  });

  const mirroredAt = async (sha256: string) => {
    const [row] = await hub.database
      .select({ at: hubBlobs.mirroredAt })
      .from(hubBlobs)
      .where(eq(hubBlobs.sha256, sha256));
    return row?.at ?? null;
  };

  const metrics = async () =>
    (await (await fetch(`${hub.url}/hub/v1/metrics`)).json()) as {
      unmirrored: number;
      mirror: string;
    };

  test("each blob is PUT once under its key, and marked", async () => {
    await writeFile(doorFile, `${door.base}\n`);
    const contents = ["one", "two", "three"];
    const written = [];
    for (const [index, bytes] of contents.entries()) {
      written.push(
        await put(hub, pass, { meta: { name: `f${index}.txt` }, bytes }),
      );
    }
    await hub.mirror?.pass();
    expect(door.received.map((one) => one.path).sort()).toEqual(
      written
        .map(
          (file) =>
            `/p/tok/n/ns/b/laf-hub-blobs-acme/o/${blobKey(file.sha256)}`,
        )
        .sort(),
    );
    for (const [index, file] of written.entries()) {
      expect(file.sha256).toBe(sha(contents[index] ?? ""));
      expect(await mirroredAt(file.sha256)).toBeInstanceOf(Date);
    }
    expect(
      door.received.every((one) => one.sha256 === one.path.split("/").at(-1)),
    ).toBe(true);
    expect(await metrics()).toMatchObject({ unmirrored: 0, mirror: "on" });

    // Copied once: a later pass sends nothing.
    await hub.mirror?.pass();
    expect(door.received).toHaveLength(3);
  });

  test("an upload starts its own copy, without waiting for the loop", async () => {
    await writeFile(doorFile, door.base);
    await hub.mirror?.check();
    const arrived = door.nextPut();
    const file = await put(hub, pass, {
      meta: { name: "now.txt" },
      bytes: "now",
    });
    await arrived;
    expect(door.received.map((one) => one.sha256)).toEqual([file.sha256]);
  });

  test("a door that refuses leaves the rows unmirrored, and a later pass copies them", async () => {
    await writeFile(doorFile, door.base);
    door.setStatus(503);
    const file = await put(hub, pass, { meta: { name: "a.txt" }, bytes: "a" });
    const refused = await hub.mirror?.pass();
    expect(refused).toMatchObject({ failed: true, mirrored: 0 });
    expect(await mirroredAt(file.sha256)).toBeNull();
    expect(await metrics()).toMatchObject({ unmirrored: 1 });
    // The failure is logged by its status alone: the door's URL is a credential.
    const logged = hub.lines.filter((one) =>
      one.line.includes("blob_mirror_failed"),
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((one) => one.line.includes("503"))).toBe(true);
    expect(hub.lines.some((one) => one.line.includes("/p/tok/"))).toBe(false);

    door.setStatus(200);
    const back = await hub.mirror?.pass();
    expect(back).toMatchObject({ failed: false, mirrored: 1 });
    expect(await mirroredAt(file.sha256)).toBeInstanceOf(Date);
    expect(await metrics()).toMatchObject({ unmirrored: 0 });
  });

  test("no door file: nothing is sent and nothing breaks, until the door appears", async () => {
    const file = await put(hub, pass, { meta: { name: "b.txt" }, bytes: "b" });
    expect(await hub.mirror?.pass()).toEqual({
      door: "off",
      mirrored: 0,
      failed: false,
    });
    expect(door.received).toHaveLength(0);
    expect(await metrics()).toMatchObject({ unmirrored: 1, mirror: "off" });

    await writeFile(doorFile, door.base);
    expect(await hub.mirror?.pass()).toMatchObject({ door: "on", mirrored: 1 });
    expect(await mirroredAt(file.sha256)).toBeInstanceOf(Date);
  });

  test("a door file that is neither spelling is reported, and sends nothing", async () => {
    await writeFile(doorFile, "not a door");
    await put(hub, pass, { meta: { name: "c.txt" }, bytes: "c" });
    expect(await hub.mirror?.pass()).toMatchObject({
      door: "invalid",
      mirrored: 0,
    });
    expect(door.received).toHaveLength(0);
    expect(await metrics()).toMatchObject({ mirror: "invalid" });
  });

  test("a deleted file's blob is not copied", async () => {
    await put(hub, pass, { meta: { name: "d.txt" }, bytes: "d" });
    await hub.database.update(hubBlobs).set({ refs: 0 });
    await writeFile(doorFile, door.base);
    expect(await hub.mirror?.pass()).toMatchObject({ mirrored: 0 });
    expect(door.received).toHaveLength(0);
  });

  test("a blob whose bytes are not on the disk: the read says restoring, the mirror skips it", async () => {
    const lost = await put(hub, pass, {
      meta: { name: "lost.txt" },
      bytes: "lost",
    });
    const kept = await put(hub, pass, {
      meta: { name: "kept.txt" },
      bytes: "kept",
    });
    await rm(blobPath(hub.filesDir, lost.sha256));

    const response = await fetch(
      `${hub.url}/hub/v1/files/${lost.id}/content`,
      asMember(pass),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      ok: false,
      code: HUB_FACTS.blobRestoring,
    });
    // The one whose bytes are there is read as ever.
    const fine = await fetch(
      `${hub.url}/hub/v1/files/${kept.id}/content`,
      asMember(pass),
    );
    expect(fine.status).toBe(200);
    expect(await fine.text()).toBe("kept");

    await writeFile(doorFile, door.base);
    expect(await hub.mirror?.pass()).toMatchObject({
      mirrored: 1,
      failed: false,
    });
    expect(door.received.map((one) => one.sha256)).toEqual([kept.sha256]);
    expect(await mirroredAt(lost.sha256)).toBeNull();
  });
});
