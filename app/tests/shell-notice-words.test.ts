import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noticeWindowNote } from "../src/components/notifications/notification-permission";
import { t } from "../src/lib/i18n";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE INSTALLED APP HAS NO TAB, NO ADDRESS BAR AND NO DEPLOYMENT.
 *
 * The 0.5.3 audit read, inside the PC app — the surface this product leads with — that
 * notifications come "only while a tab is open — nothing arrives once they are all closed", that
 * the browser was blocking them "for this site", and, on the first line of Settings, that
 * preferences hold "on every deployment you sign in to". Only one of those sentences asked where it
 * was running. None of that fails a type check or a render; each is a sentence, and a sentence is
 * what this checks.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

const scope = globalThis as { __TAURI__?: unknown };
afterEach(() => {
  delete scope.__TAURI__;
});

describe("when notices arrive, said where the page runs", () => {
  test("in the installed app, the app — not a tab", () => {
    scope.__TAURI__ = { core: {} };
    const said = ko[noticeWindowNote()] ?? "";
    expect(said).toContain("앱");
    expect(said).not.toContain("탭");
    expect(said).not.toContain("브라우저");
  });

  test("in a browser, the tab is the honest word", () => {
    expect(noticeWindowNote()).toBe(t("Only while a tab is open."));
  });

  test("Settings and a Bot's switch ask the environment instead of saying 탭 themselves", () => {
    const settings = read("routes/_authed/settings/index.tsx");
    expect(settings).toContain("noticeWindowNote()");
    expect(settings).not.toContain("Only while a tab is open");
    expect(read("components/agents/agent-profile.tsx")).toContain(
      "grantedNote={noticeWindowNote()}",
    );
  });
});

describe("the words that replaced them", () => {
  test("say nothing of 배포, 방, 주소창, 탭 or the model", () => {
    const keys = [
      "How {product} looks and behaves on this device.",
      "Tell me when my Bot speaks in a conversation I am not looking at.",
      "While the app is running. Quitting the app stops them.",
      "This computer has notifications turned off for this app.",
      "On for this app.",
      "Your Bot cannot read this at the moment, so what is written here is not being applied and you are being asked about everything. It is kept, and starts working again by itself.",
    ];
    for (const key of keys) {
      const korean = ko[key] ?? "";
      expect(korean).not.toBe("");
      expect(korean).not.toMatch(/배포|대화방|방에서|주소창|탭|모델/);
    }
  });
});
