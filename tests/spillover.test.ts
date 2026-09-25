import { describe, expect, test } from "bun:test";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import {
  previewOf,
  spillLine,
  spillPath,
  TOOL_RESULT_CUT,
} from "../shared/spillover";

/**
 * The line under a cut result: the server writes it once, where the result is first seen, and the
 * model reads it on every request after — so it must be exactly the same text each time.
 */
describe("a cut tool result", () => {
  test("is named by its tool call, in the one directory, with only safe characters", () => {
    expect(spillPath("call_abc-123")).toBe(".results/call_abc-123.txt");
    // A provider's id is not trusted to be a file name: nothing in it may mean a path.
    expect(spillPath("../../etc/passwd")).toBe(".results/______etc_passwd.txt");
    expect(spillPath("")).toBe(".results/result.txt");
    expect(spillPath("x".repeat(400))).toHaveLength(
      ".results/.txt".length + 120,
    );
  });

  test("shows the head up to the bound, then the line naming the file", () => {
    const text = "가".repeat(TOOL_RESULT_CUT + 100);
    const shown = previewOf(text, ".results/call_1.txt");
    expect(shown.startsWith("가".repeat(TOOL_RESULT_CUT))).toBe(true);
    expect(shown).not.toContain("가".repeat(TOOL_RESULT_CUT + 1));
    expect(shown.endsWith(spillLine(".results/call_1.txt", text.length))).toBe(
      true,
    );
  });

  test("is the same bytes however many times it is cut", () => {
    const text = `${"본문 ".repeat(9_000)}끝`;
    expect(previewOf(text, ".results/c.txt")).toBe(
      previewOf(text, ".results/c.txt"),
    );
  });

  test("the line says how much was shown, how much there was and where, in the table's words", () => {
    const line = spillLine(".results/call_1.txt", 64_000);
    expect(line).toBe(
      "[너무 길어 앞 20,000자만 보인다. 전체 64,000자는 작업 공간의 .results/call_1.txt에 있다. 이어 읽으려면 computer_read_file에 offset 20000을 준다.]",
    );
    // Filled in, not left as a template.
    expect(line).not.toContain("{chars}");
    expect(line).not.toContain("{total}");
    expect(line).not.toContain("{path}");
    expect(line).not.toContain("{offset}");
    expect(toolResultText("laf:tool_result_spilled")).toContain("{path}");
  });
});
