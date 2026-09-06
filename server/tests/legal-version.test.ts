import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_VERSION } from "../src/account/consent";

/**
 * The version this deployment stamps on a consent is the version printed on the page.
 *
 * Two files on the other side of the repository carry the text a person agrees to, and this
 * server records `LEGAL_VERSION` as what they agreed to. Nothing else ties the two together — an
 * edit to the text that bumps its date and forgets this constant would record every new account as
 * having agreed to the old text, which is the one thing a consent record must never do.
 *
 * Read from the app's files rather than imported: the text is content, not a module, and the test
 * is about what is on the page.
 */

const LEGAL = join(import.meta.dir, "../../app/src/legal");
const DOCUMENTS: string[] = ["terms.md", "privacy.md"];

describe("the legal text and the consent stamp", () => {
  test.each(DOCUMENTS)("%s carries the version this server records", (file) => {
    const text = readFileSync(join(LEGAL, file), "utf8");
    expect(text).toContain(`버전 ${LEGAL_VERSION}`);
  });

  test.each(DOCUMENTS)("%s says it is a draft awaiting counsel", (file) => {
    // The banner the launch plan asks for, at the head: the text goes in front of people before
    // a lawyer has read it, and the page must say so until the day this file is replaced.
    const head = readFileSync(join(LEGAL, file), "utf8").slice(0, 400);
    expect(head).toContain("법률 자문 전 초안");
  });

  test("the version is a date, so the day the text changed is the version", () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
