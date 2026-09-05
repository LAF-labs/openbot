/**
 * `/channel/new` asks who a conversation is for exactly once.
 *
 * It used to ask twice: a combobox in the header and a row of faces in the middle, answering the
 * same question through two controls that could not agree — only the combobox could add several,
 * only the faces could show who was chosen, and a face already chosen did nothing when pressed.
 *
 * A source walk rather than a render, because what is being guarded is that the second control is
 * GONE. Rendering the route would prove the surviving picker works and would say nothing at all
 * about a control quietly coming back.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "@/lib/i18n-ko";

const source = readFileSync(
  join(import.meta.dir, "../src/routes/_authed/_app/channel/new.tsx"),
  "utf8",
);

describe("the compose screen's recipient picker", () => {
  it("has one picker, and it is the faces", () => {
    expect(source).toContain("<RosterStrip");
    expect(source.match(/<RosterStrip/g)).toHaveLength(1);
  });

  it("no longer carries a second picker in the header", () => {
    // The whole finding in one assertion.
    expect(source).not.toContain("<Combobox");
    expect(source).not.toContain("ComboboxInput");
    expect(source).not.toContain('from "@/components/ui/combobox"');
  });

  it("can show several chosen at once, which is what a room is", () => {
    expect(source).toContain("selectedIds");
  });

  it("lets a press take a Bot back out", () => {
    // Add-only faces were the reason a chosen tile did nothing when pressed.
    expect(source).toContain("removeRecipient");
    expect(source).toContain("addRecipient");
  });

  it("keeps the chosen recipients as chips with a way to remove each", () => {
    expect(source).toContain("Remove {name}");
  });

  it("asks the question in a way a room does not contradict", () => {
    const heading = "Who should be in this conversation?";
    expect(source).toContain(heading);
    expect(ko[heading]).toBeString();
    // The singular one it replaced asked to SEND to one person.
    expect(source).not.toContain("Who is this for?");
  });
});
