import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * "출처: 기상청" UNDER AN ANSWER, AS A LINE AND NOT A COUNT TO PRESS.
 *
 * The rule the line is for (기상청's source-line guide, 2026-09-14) asks that it be readable where
 * the data is: a link or a button alone does not count. So unlike the pages an answer was read
 * from — folded behind "출처 N개" — this is drawn open. And once: the model is asked to write the
 * line too, and where its own words already carry it the screen does not say it twice.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3115/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(unmountAll);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const KMA = "Korea Meteorological Administration";

async function line(text: string, names: string[] = [KMA]) {
  const { CreditLine } = await import("../src/components/channels/sources-row");
  const view = await mount(createElement(CreditLine, { names, text }));
  return view.host.querySelector('[data-testid="answer-credit"]');
}

describe("the source line under an answer", () => {
  test("is drawn open, as words, with nothing to press", async () => {
    const drawn = await line("서울은 지금 17.7도, 습도 57%예요.");
    // Tests read the English keys; on a Korean screen this is "출처: 기상청".
    expect(drawn?.textContent).toBe(`Source: ${KMA}`);
    expect(drawn?.tagName).toBe("P");
    expect(drawn?.closest("details")).toBeNull();
    expect(drawn?.querySelector("a, button")).toBeNull();
  });

  test("is left to the answer's own words where they already carry it", async () => {
    for (const text of [
      `서울은 17.7도예요.\n\nSource: ${KMA}`,
      `서울은 17.7도예요. (출처: ${KMA})`,
      `자료 제공: ${KMA}`,
      `자료: ${KMA}`,
    ]) {
      expect([text, await line(text)]).toEqual([text, null]);
    }
    // Naming the agency is not crediting it: the line is still owed.
    expect(await line(`${KMA}은 내일 비가 온다고 해요.`)).not.toBeNull();
  });

  test("names each provider once, and draws nothing where none is owed", async () => {
    expect(await line("…", [])).toBeNull();
    const two = await line("…", [KMA, "Another agency"]);
    expect(two?.textContent).toBe(`Source: ${KMA}, Another agency`);
  });
});
