import { describe, expect, test } from "bun:test";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import {
  previewOf,
  spillLine,
  spillLineOf,
  spillPath,
  TOOL_RESULT_PREVIEW,
} from "../shared/spillover";

/**
 * The line two services agree on: the server writes it under a preview, and `agent-bot` has to
 * find it again at the end of a result it is trimming, or the path is lost with the cut.
 */
describe("a filed tool result", () => {
  test("is named by its tool call, in the one directory, with only safe characters", () => {
    expect(spillPath("call_abc-123")).toBe(".results/call_abc-123.txt");
    // A provider's id is not trusted to be a file name: nothing in it may mean a path.
    expect(spillPath("../../etc/passwd")).toBe(".results/______etc_passwd.txt");
    expect(spillPath("")).toBe(".results/result.txt");
    expect(spillPath("x".repeat(400))).toHaveLength(
      ".results/.txt".length + 120,
    );
  });

  test("the preview is the head, then the line naming the file", () => {
    const text = "가".repeat(TOOL_RESULT_PREVIEW + 100);
    const shown = previewOf(text, ".results/call_1.txt");
    expect(shown.startsWith("가".repeat(TOOL_RESULT_PREVIEW))).toBe(true);
    expect(shown).not.toContain("가".repeat(TOOL_RESULT_PREVIEW + 1));
    expect(shown.endsWith(spillLine(".results/call_1.txt"))).toBe(true);
  });

  test("the line says how much was shown and where the rest is, in the table's words", () => {
    const line = spillLine(".results/call_1.txt");
    expect(line).toBe(
      '[앞 1,500자] … 전체는 computer_read_file(".results/call_1.txt")',
    );
    // Filled in, not left as a template.
    expect(line).not.toContain("{chars}");
    expect(line).not.toContain("{path}");
    expect(toolResultText("laf:tool_result_spilled")).toContain("{path}");
  });

  test("the line is found again at the end of a result, and nowhere else", () => {
    const line = spillLine(".results/call_9.txt");
    expect(spillLineOf(`${"본문".repeat(10)}\n${line}`)).toBe(line);
    expect(spillLineOf("본문만 있다")).toBeNull();
    // Mentioned in the middle of a page is not the same as filed.
    expect(spillLineOf(`${line}\n그리고 그 뒤에 더 있다`)).toBeNull();
  });
});
