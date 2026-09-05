import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_REFUSALS } from "../src/lib/agents/mutations";
import {
  BOT_AVATAR_ACCESSORIES,
  BOT_AVATAR_EYES,
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
} from "../src/lib/avatar/bot-avatar";
import { AGENT_PRESETS, WORK_PATTERNS } from "../src/lib/agents/presets";
import { ko } from "../src/lib/i18n-ko";
import { ROUTINE_REFUSALS } from "../src/lib/routines/queries";

/**
 * THE SHOP OWNER'S SCREENS DO NOT SPEAK ENGINEERING, AND THEY CALL ONE THING ONE NAME.
 *
 * The same object was called 에이전트 in the sidebar, 봇 on the welcome screen, 코워커 in a tool
 * line and 어시스턴트 on the computer panel — four words for the Bot, on four screens somebody
 * crosses in a minute. The manual (docs/laf/user-guide.md) settled on 봇, and the surface has to
 * agree with the manual or the manual is wrong the day it is printed.
 *
 * The other half is vocabulary that belongs to whoever runs the deployment: 엔드포인트, 게이트웨이,
 * 스레드, 플러그인. Those are real words for real things and they stay on `/admin`, where the reader
 * is an operator. On the owner's screens they are noise that makes a person think they broke
 * something.
 *
 * WHAT THIS WALKS. Literal `t("…")` keys in every source file that is not an admin screen, plus the
 * tables read through `t(variable)` — those are invisible to `i18n-coverage.test.ts` for the same
 * reason, and a preset or a refusal is as user-facing as anything else.
 */

const SOURCE = join(import.meta.dir, "../src");
const DICTIONARY_FILE = "lib/i18n-ko.ts";

/** Files whose reader is an operator, where 경계 and 플러그인 are the right words. */
const ADMIN_SURFACE = ["routes/_authed/admin/", "components/admin/"];

/**
 * Words the owner's screens must never say, and what the manual says instead.
 *
 * 봇 covers the first three: one thing, one name. The rest are the deployment's own machinery —
 * a person who hires a Bot to watch their reviews has no use for the word 엔드포인트.
 */
const FORBIDDEN: Record<string, string> = {
  에이전트: "봇",
  코워커: "봇",
  어시스턴트: "봇",
  스레드: "대화",
  엔드포인트: "(운영자 화면에만)",
  "AG-UI": "(운영자 화면에만)",
  MCP: "연결",
  게이트웨이: "(운영자 화면에만)",
  경계: "허락",
  토큰: "(운영자 화면에만)",
  플러그인: "연결",
  컴포넌트: "(운영자 화면에만)",
};

/**
 * Keys that reach an owner-surface FILE but never an owner's EYES.
 *
 * Every exception here has to name the gate that hides it, and goes the moment the gate does.
 */
const BEHIND_AN_ADMIN_GATE = new Set([
  // `agent-fields.tsx` puts these three inside the 고급 disclosure, which is not rendered at all
  // unless the reader is an administrator: every Bot a person makes is `remote_ag_ui` on this
  // deployment's own endpoint, so an owner has nothing to type there.
  "Agent endpoint (optional)",
  "Key for that agent (optional)",
  "Leave empty to use the built-in Bot. Anything that speaks AG-UI works. This server dials your agent, so an agent on your own machine has to be reachable from here.",
  /*
   * The approval card's footnote names the admin screen where a standing allowance is taken back,
   * and the manual names it the same way ("관리 화면의 경계 설정"). Memo item 6 — that a non-admin
   * cannot open it — is a separate change to `approval-request.tsx`, which owns this sentence.
   */
  "Asked because of this rule. Allowing once covers this action; the other covers every one like it until you take it back in Boundaries.",
]);

/**
 * Strings read through `t(variable)` on an owner screen, listed because a regex cannot find them.
 *
 * `AGENT_PRESETS`, `ROUTINE_REFUSALS` and `AGENT_REFUSALS` are imported whole; these are the ones
 * that live inline in a component and have no export to walk.
 */
const READ_BY_VARIABLE = [
  // bot-sidebar.tsx FOOTER_LINKS
  "Routines",
  "Skills",
  "Bots",
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

function ownerKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const path of sourceFiles(SOURCE)) {
    const relative = path.replace(`${SOURCE}/`, "");
    if (relative === DICTIONARY_FILE || relative === "routeTree.gen.ts")
      continue;
    if (ADMIN_SURFACE.some((prefix) => relative.startsWith(prefix))) continue;
    for (const match of readFileSync(path, "utf8").matchAll(
      /\bt\(\s*"((?:[^"\\]|\\.)*)"/g,
    )) {
      const key = match[1];
      if (key && !keys.has(key)) keys.set(key, relative);
    }
  }
  return keys;
}

/** Every Korean sentence an owner can read, with where it came from. */
function ownerKorean(): [string, string][] {
  const sentences: [string, string][] = [];
  for (const [key, where] of ownerKeys()) {
    if (BEHIND_AN_ADMIN_GATE.has(key)) continue;
    const korean = ko[key];
    if (korean) sentences.push([korean, where]);
  }
  for (const key of READ_BY_VARIABLE) {
    const korean = ko[key];
    if (korean) sentences.push([korean, "read through t(variable)"]);
  }
  for (const preset of AGENT_PRESETS) {
    for (const value of [preset.name, preset.title, preset.roleDescription]) {
      const korean = ko[value];
      if (korean) sentences.push([korean, `presets.ts: ${preset.id}`]);
    }
  }
  for (const pattern of WORK_PATTERNS) {
    for (const value of [pattern.name, pattern.connection]) {
      const korean = ko[value];
      if (korean) sentences.push([korean, `presets.ts: ${pattern.id}`]);
    }
  }
  for (const table of [ROUTINE_REFUSALS, AGENT_REFUSALS]) {
    for (const sentence of Object.values(table)) {
      const korean = ko[sentence];
      if (korean) sentences.push([korean, "a refusal table"]);
    }
  }
  /*
   * The face picker's three rows and the eye styles behind the shuffle. Every one of these is read
   * through `t(option.name)`, which the regex above cannot see — the same blind spot the presets
   * have, and the same answer.
   */
  for (const table of [
    BOT_AVATAR_SHAPES,
    BOT_AVATAR_PALETTES,
    BOT_AVATAR_EYES,
    BOT_AVATAR_ACCESSORIES,
  ]) {
    for (const option of table) {
      const korean = ko[option.name];
      if (korean) sentences.push([korean, `bot avatar: ${option.id}`]);
    }
  }
  return sentences;
}

describe("the owner's vocabulary", () => {
  test("says none of the words that belong to the operator", () => {
    const offences: string[] = [];
    for (const [korean, where] of ownerKorean()) {
      for (const [word, instead] of Object.entries(FORBIDDEN)) {
        if (korean.includes(word)) {
          offences.push(`${where}: "${word}" → ${instead} — ${korean}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  test("checks enough of the app to be worth having", () => {
    // A walker that silently stopped finding anything would pass the test above for the wrong
    // reason, the same way `i18n-coverage.test.ts` guards its own regex.
    expect(ownerKorean().length).toBeGreaterThan(250);
  });

  test("every gate exception is a key the app still asks for", () => {
    // An exception left behind after its sentence was rewritten is a hole nobody can see.
    const asked = new Set(ownerKeys().keys());
    const stale = [...BEHIND_AN_ADMIN_GATE].filter((key) => !asked.has(key));
    expect(stale).toEqual([]);
  });
});
