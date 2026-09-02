import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createCredential,
  createCredentialStore,
  CredentialUnavailableError,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
  resolveModelApiKey,
  revokeCredential,
  rotateCredential,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config = loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: key }));
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const credentialIds: string[] = [];

afterEach(async () => {
  for (const credentialId of credentialIds.splice(0)) {
    await database.delete(credentials).where(eq(credentials.id, credentialId));
  }
});

describe("credential encryption", () => {
  test("stores a versioned AES-GCM envelope and restores it only server-side", async () => {
    const envelope = await encryptSecret(key, "openai-secret-value");

    expect(JSON.parse(envelope)).toEqual({
      version: 1,
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });
    await expect(decryptSecret(key, envelope)).resolves.toBe(
      "openai-secret-value",
    );
  });

  test("creates a write-only credential and audits safe metadata", async () => {
    const stored: unknown[] = [];
    const audited: unknown[] = [];

    const credential = await createCredential(
      {
        encryptionKey: key,
        store: {
          create: async (value) => {
            stored.push(value);
            return { id: "credential-1", revokedAt: null };
          },
          revoke: async () => new Date(),
          // No live credential for the key, so this is a creation rather than the rotation the
          // store now performs when one exists.
          findLiveByKey: async () => null,
        },
        auditStore: {
          insert: async (event) => {
            audited.push(event);
          },
        },
      },
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    );

    expect(credential).toEqual({
      id: "credential-1",
      kind: "model",
      provider: "openai",
      keyId: "primary",
      metadata: { label: "Production OpenAI" },
      revokedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain("openai-secret-value");
    expect(audited).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId: "primary",
        },
      },
    ]);
  });

  test("rotates then revokes credentials without returning plaintext", async () => {
    const revoked: string[] = [];
    const audited: unknown[] = [];
    const service = {
      encryptionKey: key,
      store: {
        create: async () => ({ id: "credential-new", revokedAt: null }),
        // The store owns atomicity now: retiring the old row and inserting the new one are one
        // write, so the double records the retirement where the transaction would perform it.
        rotate: async (input: { previousCredentialId: string }) => {
          revoked.push(input.previousCredentialId);
          return { id: "credential-new", revokedAt: null };
        },
        revoke: async (id: string) => {
          revoked.push(id);
          return new Date("2026-08-13T12:00:00.000Z");
        },
      },
      auditStore: {
        insert: async (event: unknown) => {
          audited.push(event);
        },
      },
    };

    await rotateCredential(service, {
      previousCredentialId: "credential-old",
      kind: "model",
      provider: "openai",
      keyId: "secondary",
      metadata: { label: "Rotated OpenAI" },
      plaintext: "new-openai-secret",
      actorUserId: "admin",
    });
    await revokeCredential(service, "credential-new", "admin");

    expect(revoked).toEqual(["credential-old", "credential-new"]);
    expect(JSON.stringify(audited)).not.toContain("new-openai-secret");
    expect(
      audited.map((event) => (event as { eventType: string }).eventType),
    ).toEqual(["credential.rotated", "credential.revoked"]);
  });

  test("decrypts only an active credential for server-side use", async () => {
    const encryptedValue = await encryptSecret(key, "connector-secret");

    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: null }) },
        "credential-1",
      ),
    ).resolves.toBe("connector-secret");
    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: new Date() }) },
        "credential-1",
      ),
    ).rejects.toThrow("Credential is revoked");
  });

  /**
   * The refusals are a CLASS, not a sentence, and they say which fact the vault could establish.
   *
   * `plugins/connections.ts` branches on this to decide between "your access was withdrawn, connect
   * again" and "that tool could not be called" — two very different things to tell somebody. It used
   * to decide by reading the words in the message, so rewording or translating them would have
   * swapped one for the other with every test still green.
   */
  test("an unavailable credential refuses with a class and a reason", async () => {
    const encryptedValue = await encryptSecret(key, "connector-secret");

    const missing = await decryptCredentialForUse(
      key,
      { readSecret: async () => null },
      "credential-1",
    ).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(CredentialUnavailableError);
    expect((missing as CredentialUnavailableError).reason).toBe("missing");

    const revoked = await decryptCredentialForUse(
      key,
      { readSecret: async () => ({ encryptedValue, revokedAt: new Date() }) },
      "credential-1",
    ).catch((error: unknown) => error);
    expect(revoked).toBeInstanceOf(CredentialUnavailableError);
    expect((revoked as CredentialUnavailableError).reason).toBe("revoked");

    // An envelope this deployment cannot read is a different failure entirely: nothing about
    // connecting again fixes it, so it must not arrive wearing the same class.
    const broken = await decryptCredentialForUse(
      key,
      { readSecret: async () => ({ encryptedValue: "{}", revokedAt: null }) },
      "credential-1",
    ).catch((error: unknown) => error);
    expect(broken).toBeInstanceOf(Error);
    expect(broken).not.toBeInstanceOf(CredentialUnavailableError);
  });

  /**
   * The two writes that decide in one statement report a third reason, and it is honest.
   *
   * Both guard on `revoked_at IS NULL` inside the write itself, deliberately, so that nothing can
   * revoke a row between a check and the write — which means the row's absence and its revocation
   * genuinely arrive as one answer rather than as a shrug.
   */
  test("a write against a credential that is gone or revoked says so as a reason", async () => {
    const store = createCredentialStore(database);
    const absent = randomUUID();

    const written = await store
      .updateSecret(absent, await encryptSecret(key, "nothing"))
      .catch((error: unknown) => error);
    expect(written).toBeInstanceOf(CredentialUnavailableError);
    expect((written as CredentialUnavailableError).reason).toBe(
      "missing_or_revoked",
    );

    const retired = await store.revoke(absent).catch((error: unknown) => error);
    expect(retired).toBeInstanceOf(CredentialUnavailableError);
    expect((retired as CredentialUnavailableError).reason).toBe(
      "missing_or_revoked",
    );
  });
});

describe("model credential resolution", () => {
  test("prefers a stored model credential over the environment", async () => {
    const encryptedValue = await encryptSecret(key, "stored-openai-key");

    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).resolves.toBe("stored-openai-key");
  });

  test("uses OPENAI_API_KEY when no stored credential exists", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: " environment-openai-key " },
      }),
    ).resolves.toBe("environment-openai-key");
  });

  test("returns null when neither credential source is configured", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: {},
      }),
    ).resolves.toBeNull();
  });

  test("rejects corrupt stored ciphertext instead of falling back to the environment", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue: "corrupt" }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).rejects.toThrow("Credential envelope is invalid");
  });
});

describe("model credential store lookup", () => {
  /*
   * This used to assert a created_at-then-id tie-break BETWEEN LIVE ROWS, and that scenario is now
   * impossible by construction: `credentials_active_key_idx` holds one live credential per key, so
   * what is left to pin is that the lookup picks the live row over revoked history and over every
   * near-miss key — and that the index actually refuses a second live row.
   *
   * The key id is suite-scoped rather than the real `openai-api-key`, because these tests share the
   * development database with the app and a deployment's genuine model credential now legitimately
   * OWNS that key under the unique index.
   */
  test("selects the live matching model credential over revoked history and near-miss keys", async () => {
    const keyId = `test-openai-key-${randomUUID().slice(0, 8)}`;
    const liveId = randomUUID();
    const retiredId = randomUUID();
    const ignoredIds = [randomUUID(), randomUUID(), randomUUID()];
    credentialIds.push(liveId, retiredId, ...ignoredIds);

    await database.insert(credentials).values([
      {
        id: retiredId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "retired-value",
        metadata: {},
        revokedAt: new Date("2026-03-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: liveId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "live-value",
        metadata: {},
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[0]!,
        kind: "connector",
        provider: "openai",
        keyId,
        encryptedValue: "wrong-kind-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[1]!,
        kind: "model",
        provider: "other",
        keyId,
        encryptedValue: "wrong-provider-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[2]!,
        kind: "model",
        provider: "openai",
        keyId: `${keyId}-other`,
        encryptedValue: "wrong-key-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      createCredentialStore(database).readModelSecret({
        provider: "openai",
        keyId,
      }),
    ).resolves.toEqual({ encryptedValue: "live-value" });

    // The invariant the lookup now leans on: a second live row for the same key cannot exist.
    // Drizzle wraps the refusal, so the index's name is on the CAUSE rather than the message.
    const refused = await database
      .insert(credentials)
      .values({
        id: randomUUID(),
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "second-live-value",
        metadata: {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).not.toBeNull();
    expect(String((refused as { cause?: unknown }).cause ?? refused)).toContain(
      "credentials_active_key_idx",
    );
  });
});

describe("admin credential API", () => {
  test("returns only credential status and metadata", async () => {
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@laf.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [
          {
            id: "credential-1",
            kind: "model",
            provider: "openai",
            keyId: "primary",
            metadata: { label: "Production OpenAI" },
            revokedAt: null,
          },
        ],
      },
    );

    const response = await app.request(
      "http://laf.local/api/admin/credentials",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: "credential-1",
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          revokedAt: null,
        },
      ],
    });
  });

  test("accepts plaintext only on credential creation and returns safe status", async () => {
    const created: unknown[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@laf.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async (input) => {
          created.push(input);
          return {
            id: "credential-1",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
      },
    );

    const response = await app.request(
      "http://laf.local/api/admin/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          plaintext: "openai-secret-value",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      credential: {
        id: "credential-1",
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        revokedAt: null,
      },
    });
    expect(created).toEqual([
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    ]);
  });

  test("rotates and revokes through write-only administrator operations", async () => {
    const calls: string[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@laf.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        rotate: async (input) => {
          calls.push(`rotate:${input.previousCredentialId}`);
          return {
            id: "credential-new",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
        revoke: async (id) => {
          calls.push(`revoke:${id}`);
          return { id, revokedAt: new Date("2026-08-13T12:00:00.000Z") };
        },
      },
    );

    const rotate = await app.request(
      "http://laf.local/api/admin/credentials/credential-old/rotate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "secondary",
          metadata: {},
          plaintext: "rotated-secret",
        }),
      },
    );
    const revoke = await app.request(
      "http://laf.local/api/admin/credentials/credential-new/revoke",
      { method: "POST" },
    );

    expect(rotate.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(calls).toEqual(["rotate:credential-old", "revoke:credential-new"]);
    expect(await rotate.text()).not.toContain("rotated-secret");
  });
});
