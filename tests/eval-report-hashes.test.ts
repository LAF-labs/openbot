import { describe, expect, test } from "bun:test";
import {
  CORE_CONNECTED_TOOLS,
  PLACE_LINES,
  systemMessageFor,
} from "../evals/prompt";
import { placeText } from "../shared/prompt";
import {
  CORE_TOOL_NAMES,
  DEFERRED_TOOL_PREFIX,
  WEATHER_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../shared/tools/bridge";

/**
 * What a report's two hashes are taken over.
 *
 * The ritual's rule is that a prompt or catalogue edit inside a verdict starts a new verdict, and
 * the hashes in the report are the only thing that makes the rule checkable. On 2026-10-02 both sat
 * still through a batch that changed what a Bot reads — the place line stopped sending the weather
 * to 네이버, and the web search and the weather went on the core list — because neither was in what
 * the hashes covered. These pin that both are now.
 */
describe("what an eval report's hashes cover", () => {
  test("the place line, for each kind of person and both modes", () => {
    // Four people — a said place, a device's with and without a name for it, nobody's — in two
    // modes, and nobody's twice: for a run that holds the weather tool and for one that may not.
    expect(PLACE_LINES).toHaveLength(10);
    expect(new Set(PLACE_LINES).size).toBe(10);
    expect(PLACE_LINES).toContain(
      placeText(undefined, "chat", { weatherTool: true }),
    );
    expect(PLACE_LINES).toContain(placeText({ place: "어느 곳" }, "chat"));
    expect(PLACE_LINES).toContain(placeText(undefined, "routine"));
    // The words, not somebody's place: a fixed input, so the hash moves only when the wording does.
    expect(PLACE_LINES.join("\n")).toContain("get_weather");
  });

  test("the eval's prompt is told whether the scenario's Bot holds the weather tool, as the server's is", () => {
    /*
     * The server builds the place line from the run's tools: a run that holds the weather tool is
     * not told what to do without it. An eval that built its prompt without saying would measure
     * the longer line, which no Bot on a deployment with the key is sent.
     */
    const road = "그 도구가 없으면 검색어에 서울을 넣는다";
    const told = (holds?: boolean) =>
      systemMessageFor(
        "chat",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        holds,
      ).content;
    expect(told(true)).not.toContain(road);
    expect(told(false)).toContain(road);
    // Built without knowing: the road stays.
    expect(told()).toContain(road);
    // And nothing else in the message turns on it: only that sentence is gone.
    expect(
      told(false).replace(` ${road}(예: 네이버 검색 '서울 날씨').`, ""),
    ).toBe(told(true));
  });

  test("every connected tool on the core list, and only those", () => {
    const names = CORE_CONNECTED_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual([WEATHER_TOOL_NAME, WEB_SEARCH_TOOL_NAME].sort());
    // By the core list itself: the next connected tool put there is covered by being put there.
    expect(names).toEqual(
      [...CORE_TOOL_NAMES]
        .filter((name) => name.startsWith(DEFERRED_TOOL_PREFIX))
        .sort(),
    );
    for (const tool of CORE_CONNECTED_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
