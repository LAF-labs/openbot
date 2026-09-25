import { describe, expect, test } from "bun:test";
import type { SnapshotResult } from "../src/computer/schema";
import { elementLine, snapshotForModel } from "../src/computer/snapshot-lines";

/**
 * The snapshot a model reads: a line per element instead of a JSON object per element
 * (agent-harness-review R10). The gateway keeps the objects; only what is handed on changes.
 */

const snapshot: SnapshotResult = {
  snapshotId: 7,
  url: "https://news.naver.com/section/101",
  title: "경제",
  elements: [
    { ref: "e3", role: "link", name: "본문 바로가기" },
    { ref: "e5", role: "searchbox", name: "검색", value: "무선 마우스" },
    {
      ref: "e6",
      role: "textbox",
      name: "비밀번호",
      value: "",
      type: "password",
    },
    { ref: "e7", role: "checkbox", name: "로그인 상태 유지", checked: false },
    { ref: "e8", role: "button", name: "구매", disabled: true },
    { ref: "e9", role: "button", name: "" },
  ],
  truncated: false,
  tabs: [
    { index: 0, title: "경제", url: "https://news.naver.com/", active: true },
  ],
  opaqueFrames: 0,
};

describe("a snapshot as lines", () => {
  test("one element is ref, role, name and only the facts it has", () => {
    const lines = snapshotForModel(snapshot).elements.split("\n");
    expect(lines).toEqual([
      "e3 link 본문 바로가기",
      'e5 searchbox 검색 = "무선 마우스"',
      'e6 textbox 비밀번호 = "" (password)',
      "e7 checkbox 로그인 상태 유지 [unchecked]",
      "e8 button 구매 [disabled]",
      "e9 button",
    ]);
  });

  test("a headline is cut for the model, never for the gateway", () => {
    const name = "가".repeat(100);
    const line = elementLine({ ref: "e1", role: "link", name });
    expect(line.length).toBeLessThan(70);
    expect(line.endsWith("…")).toBe(true);
    // The object the gateway judges a click by is untouched.
    expect(snapshot.elements[0]?.name).toBe("본문 바로가기");
  });

  test("what is always false or zero is left out, and the count stays for the card", () => {
    const shaped = snapshotForModel(snapshot);
    expect(shaped.count).toBe(6);
    expect("truncated" in shaped).toBe(false);
    expect("opaqueFrames" in shaped).toBe(false);
    expect(shaped.snapshotId).toBe(7);
    expect(shaped.tabs?.length).toBe(1);
    const cut = snapshotForModel({
      ...snapshot,
      truncated: true,
      opaqueFrames: 2,
    });
    expect(cut.truncated).toBe(true);
    expect(cut.opaqueFrames).toBe(2);
  });

  test("is far shorter than the objects it replaces", () => {
    const many: SnapshotResult = {
      ...snapshot,
      elements: Array.from({ length: 200 }, (_, index) => ({
        ref: `e${index}`,
        role: "link",
        name: `많이 본 뉴스 ${index}`,
      })),
    };
    const before = JSON.stringify(many).length;
    const after = JSON.stringify(snapshotForModel(many)).length;
    expect(after).toBeLessThan(before * 0.6);
  });
});
