import { describe, expect, test } from "bun:test";
import {
  kekIdOf,
  LoginSealError,
  openLogin,
  sealLogin,
} from "../src/logins/crypto";

/**
 * A SAVED LOGIN IS SEALED UNDER A KEY OF ITS OWN, WRAPPED UNDER THE DEPLOYMENT'S
 * (`logins/crypto.ts`, `docs/laf/redesign-2026-10.md` §6).
 */
const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const KEY = key(7);
const ROW = { id: "login_a", userId: "user-1" };
const VALUES = {
  username: "sajang@example.com",
  password: "  hunter2 한글 🔑 ",
};

describe("a saved login's seal", () => {
  test("opens to exactly what was sealed, and holds neither value in anything that is stored", async () => {
    const sealed = await sealLogin(KEY, ROW, VALUES);
    expect(await openLogin(KEY, ROW, sealed)).toEqual(VALUES);

    const stored = JSON.stringify(sealed);
    expect(stored).not.toContain(VALUES.username);
    expect(stored).not.toContain("hunter2");
    // Nor either value's bytes, the way a seal carries bytes.
    for (const value of Object.values(VALUES)) {
      expect(stored).not.toContain(Buffer.from(value).toString("base64"));
    }
    // Its own format, told from the vault's beside it at a glance.
    for (const part of [
      sealed.wrappedKey,
      sealed.sealedUsername,
      sealed.sealedPassword,
    ]) {
      expect(part.startsWith("lv1.")).toBe(true);
    }
    expect(sealed.kekId).toBe(await kekIdOf(KEY));
  });

  test("is made under a new key every time: the same login sealed twice shares nothing", async () => {
    const one = await sealLogin(KEY, ROW, VALUES);
    const two = await sealLogin(KEY, ROW, VALUES);
    expect(two.wrappedKey).not.toBe(one.wrappedKey);
    expect(two.sealedUsername).not.toBe(one.sealedUsername);
    expect(two.sealedPassword).not.toBe(one.sealedPassword);
    // One row's key opens one row's values: the other's password under this one's key is noise.
    expect(
      await openLogin(KEY, ROW, {
        ...one,
        sealedPassword: two.sealedPassword,
      }).catch((error: unknown) => error),
    ).toBeInstanceOf(LoginSealError);
  });

  test("opens only as the row, the owner and the field it was sealed for, under the key that sealed it", async () => {
    const sealed = await sealLogin(KEY, ROW, VALUES);
    const opened = (...call: Parameters<typeof openLogin>) =>
      openLogin(...call).catch((error: unknown) => error);

    // Another row, or the same row under another owner.
    expect(await opened(KEY, { ...ROW, id: "login_b" }, sealed)).toBeInstanceOf(
      LoginSealError,
    );
    expect(
      await opened(KEY, { ...ROW, userId: "user-2" }, sealed),
    ).toBeInstanceOf(LoginSealError);
    // The password copied onto the name's column, and the other way.
    expect(
      await opened(KEY, ROW, {
        ...sealed,
        sealedUsername: sealed.sealedPassword,
      }),
    ).toBeInstanceOf(LoginSealError);
    // Another deployment's key.
    expect(await opened(key(8), ROW, sealed)).toBeInstanceOf(LoginSealError);
    // Bytes that were changed, and things that are not a seal at all.
    const [prefix, iv, ciphertext] = sealed.sealedPassword.split(".");
    const flipped = Buffer.from(ciphertext ?? "", "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    for (const sealedPassword of [
      [prefix, iv, flipped.toString("base64")].join("."),
      "",
      "lv1..",
      "lv2.AAAA.AAAA",
      `${sealed.sealedPassword}.more`,
      '{"version":1,"iv":"AAAA","ciphertext":"AAAA"}',
    ]) {
      expect(
        await opened(KEY, ROW, { ...sealed, sealedPassword }),
      ).toBeInstanceOf(LoginSealError);
    }
  });

  test("says nothing of what it could not open: one message, whatever went wrong", async () => {
    const sealed = await sealLogin(KEY, ROW, VALUES);
    const failure = (await openLogin(key(8), ROW, sealed).catch(
      (error: unknown) => error,
    )) as Error;
    expect(failure.message).toBe("laf:login_seal_unreadable");
    expect(JSON.stringify(failure)).not.toContain("hunter2");
  });

  test("names the deployment key by a fingerprint that is not the key", async () => {
    const id = await kekIdOf(KEY);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await kekIdOf(KEY)).toBe(id);
    expect(await kekIdOf(key(8))).not.toBe(id);
    expect(KEY).not.toContain(id);
  });
});
