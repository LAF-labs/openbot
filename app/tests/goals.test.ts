import { describe, expect, test } from "bun:test";
import { MOMENTUMS, GOAL_STATUSES } from "@shared/goals";
import { CATEGORIES } from "@shared/persona";
import {
  COMPOSE_SCREEN_KEY,
  offerSend,
  takeOfferedSend,
} from "../src/components/channels/composer/prefill";
import { CATEGORY_ICONS } from "../src/components/goals/goal-parts";
import { stepLineOf } from "../src/lib/copilot/step-labels";
import {
  GOAL_REFUSALS,
  type Goal,
  MOMENTUM_LABELS,
  measureLine,
  STATUS_LABELS,
} from "../src/lib/goals/queries";
import { ko } from "../src/lib/i18n-ko";

/**
 * 목표's words (muse-shape plan §3.4, phase 9). The momentum, status and refusal tables are read
 * through `t(variable)`, which `i18n-coverage.test.ts` cannot see, so they are walked here.
 */

describe("목표's tables", () => {
  test("every momentum, in our three words, in Korean", () => {
    expect(Object.keys(MOMENTUM_LABELS).sort()).toEqual([...MOMENTUMS].sort());
    for (const momentum of MOMENTUMS) {
      expect(ko[MOMENTUM_LABELS[momentum]]).toBeTruthy();
    }
    expect(ko[MOMENTUM_LABELS.on_track]).toBe("잘 가고 있어요");
    expect(ko[MOMENTUM_LABELS.at_risk]).toBe("조금 밀렸어요");
    expect(ko[MOMENTUM_LABELS.behind]).toBe("늦어지고 있어요");
  });

  test("every status and refusal in Korean", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      [...GOAL_STATUSES].sort(),
    );
    for (const status of GOAL_STATUSES) {
      expect(ko[STATUS_LABELS[status]]).toBeTruthy();
    }
    for (const words of Object.values(GOAL_REFUSALS)) {
      expect(ko[words]).toBeTruthy();
    }
  });

  test("every category has its icon and its Korean — the same seven for everyone", () => {
    expect(Object.keys(CATEGORY_ICONS).sort()).toEqual(
      CATEGORIES.map((one) => one.id).sort(),
    );
    for (const category of CATEGORIES) expect(ko[category.name]).toBeTruthy();
  });

  test("the sentence [대화에서 시작] sends is Korean, category and all", () => {
    const template = ko["Help me set a goal for {category}"];
    expect(template).toBe("{category} 목표를 같이 세워 줘");
    expect(template?.replace("{category}", ko["Study and growth"] ?? "")).toBe(
      "공부·성장 목표를 같이 세워 줘",
    );
  });

  test("a number to watch reads now and goal, with the unit on the number", () => {
    const goal = {
      measure: { unit: "점", start: 720, goal: 800 },
      latestValue: null,
    } as unknown as Goal;
    expect(measureLine(goal)).toBe("Now 720 · goal 800점");
    expect(measureLine({ ...goal, latestValue: 760 })).toBe(
      "Now 760 · goal 800점",
    );
    expect(measureLine({ ...goal, measure: null })).toBeNull();
  });

  test("the goal tools' steps read in Korean, never as their names", () => {
    for (const bare of [
      "save_goal",
      "update_goal",
      "log_progress",
      "list_goals",
    ]) {
      const line = stepLineOf(`mcp__goals__${bare}`);
      expect(line.label).not.toContain(bare);
      expect(ko[line.label]).toBeTruthy();
      expect(line.detail).toBe("Goals");
    }
  });
});

describe("a sentence another screen sends (offerSend)", () => {
  test("is taken once, by the conversation it names, and never by another", () => {
    offerSend("ch-1", "공부·성장 목표를 같이 세워 줘");
    expect(takeOfferedSend("ch-2")).toBeNull();
    expect(takeOfferedSend(COMPOSE_SCREEN_KEY)).toBeNull();
    expect(takeOfferedSend("ch-1")).toBe("공부·성장 목표를 같이 세워 줘");
    expect(takeOfferedSend("ch-1")).toBeNull();
  });

  test("comes from code on the page only: the conversation's address has no way to send", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(
      join(
        import.meta.dir,
        "../src/routes/_authed/_app/channel/$channelId.tsx",
      ),
      "utf8",
    );
    expect(route).not.toContain("offerSend");
  });
});
