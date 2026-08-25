import { describe, expect, test } from "bun:test";
import { createSignInAllowlist } from "../src/auth/allowlist";

describe("who may sign in", () => {
  test("unset means open — the behavior every deployment had before the lock existed", () => {
    const door = createSignInAllowlist({
      allowedEmails: [],
      initialAdminEmails: [],
    });
    expect(door.enforced).toBe(false);
    expect(door.admits("anyone@example.com")).toBe(true);
  });

  test("admin emails alone do not arm the lock", () => {
    // They predate it. Arming on them would have turned every existing deployment exclusive on
    // upgrade, locking out anybody who was signing in beside the admin.
    const door = createSignInAllowlist({
      allowedEmails: [],
      initialAdminEmails: ["owner@example.com"],
    });
    expect(door.enforced).toBe(false);
    expect(door.admits("anyone@example.com")).toBe(true);
  });

  test("set, it admits the list and refuses the rest", () => {
    const door = createSignInAllowlist({
      allowedEmails: ["owner@example.com"],
      initialAdminEmails: [],
    });
    expect(door.enforced).toBe(true);
    expect(door.admits("owner@example.com")).toBe(true);
    expect(door.admits("stranger@example.com")).toBe(false);
  });

  test("an administrator cannot lock themselves out by omission", () => {
    const door = createSignInAllowlist({
      allowedEmails: ["staff@example.com"],
      initialAdminEmails: ["owner@example.com"],
    });
    expect(door.admits("owner@example.com")).toBe(true);
    expect(door.admits("staff@example.com")).toBe(true);
  });

  test("matching is case-insensitive and trimmed, and nothing more", () => {
    const door = createSignInAllowlist({
      allowedEmails: [" Owner@Example.COM "],
      initialAdminEmails: [],
    });
    expect(door.admits("owner@example.com")).toBe(true);
    // Gmail conventions are not address semantics: a lock that admits spellings it was never
    // given is a worse surprise than one that wants the exact address.
    expect(door.admits("o.wner@example.com")).toBe(false);
    expect(door.admits("owner+laf@example.com")).toBe(false);
  });

  test("blank entries do not arm the lock", () => {
    // `SIGN_IN_ALLOWED_EMAILS=` with a trailing comma or stray space must stay open, not become
    // a door that admits nobody.
    const door = createSignInAllowlist({
      allowedEmails: [" ", ""],
      initialAdminEmails: [],
    });
    expect(door.enforced).toBe(false);
    expect(door.admits("anyone@example.com")).toBe(true);
  });
});
