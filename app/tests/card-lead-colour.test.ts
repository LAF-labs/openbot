import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cardToDraw,
  GalleryCard,
} from "../src/components/gallery/gallery-card";

/*
 * ONE THING PER CARD IS IN THE ACCENT (the owner, 2026-10-11, `docs/laf/redesign-2026-10.md` §1
 * "색과 깊이"): the fill of a progress bar, a chart's first series — and no figure of a key-figures
 * card, whose figures are all the ink (the owner again, on seeing the first one blue). A bar chart drew each bar in the next colour of the palette and a progress card each row,
 * which made a bar's colour its place in the row and left the card with nothing to look at first.
 *
 * The colours are classes on the sheet's `--chart-1` … `--chart-6` (`gallery/palette.ts`), the
 * first of which is the accent — `accent-contrast.test.ts` measures that end. This end is what the
 * cards put the classes on, and that no mark carries a colour of its own as an inline style, which
 * is how the first series could not follow the accent into the dark.
 */

const drawn = (name: string, args: unknown): string => {
  const card = cardToDraw(name, args);
  if (!card) throw new Error(`${name} did not take these values`);
  return renderToStaticMarkup(createElement(GalleryCard, { card }));
};

/** Every class of the palette's that the markup names, in the order it names them. */
const series = (markup: string, paint: "bg" | "stroke" | "fill"): string[] =>
  [...markup.matchAll(new RegExp(`\\b${paint}-chart-([1-6])\\b`, "g"))].map(
    (match) => match[1] as string,
  );

const MONTHS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월"];

describe("what a card is about is in the accent, and only that", () => {
  test("a bar chart is one series: every bar is the first colour, however many there are", () => {
    const markup = drawn("showBarChart", {
      title: "월별 매출",
      points: MONTHS.map((label, index) => ({ label, value: index + 1 })),
    });
    expect(series(markup, "bg")).toEqual(MONTHS.map(() => "1"));
  });

  test("a progress card fills every row in the first colour", () => {
    const markup = drawn("showProgress", {
      title: "목표 대비 진행",
      points: [
        { label: "분기 매출", value: 2150, target: 3000 },
        { label: "신규 고객", value: 128, target: 200 },
        { label: "리뷰", value: 44, target: 50 },
      ],
    });
    expect(series(markup, "bg")).toEqual(["1", "1", "1"]);
  });

  test("a key-figures card's figures are the ink, every one: none is written in the accent", () => {
    const markup = drawn("showMetrics", {
      title: "이번 달 주요 수치",
      metrics: [
        { label: "매출", value: "12,450,000원" },
        { label: "주문", value: "342건" },
        { label: "재방문율", value: "41%" },
      ],
    });
    const figures = [
      ...markup.matchAll(/<p class="([^"]*\btext-xl\b[^"]*)">([^<]*)</g),
    ].map((match) => ({
      value: match[2],
      isLead: (match[1] as string).split(/\s+/).includes("text-link"),
    }));
    expect(figures).toEqual([
      { value: "12,450,000원", isLead: false },
      { value: "342건", isLead: false },
      { value: "41%", isLead: false },
    ]);
  });

  test("a chart of several series gives the first the accent and the rest their own, legend and all", () => {
    const args = {
      title: "온라인·매장 매출",
      labels: ["1월", "2월", "3월"],
      series: [
        { name: "온라인", values: [120, 150, 170] },
        { name: "매장", values: [200, 190, 220] },
        { name: "도매", values: [80, 90, 70] },
      ],
    };
    const line = drawn("showLineChart", args);
    expect(series(line, "stroke")).toEqual(["1", "2", "3"]);
    expect(series(line, "bg")).toEqual(["1", "2", "3"]);
    const area = drawn("showAreaChart", args);
    expect(series(area, "fill")).toEqual(["1", "2", "3"]);
    expect(series(area, "stroke")).toEqual(["1", "2", "3"]);
  });

  test("a donut's slices are the palette in order, and its legend says the same", () => {
    const markup = drawn("showPieChart", {
      title: "채널별 매출",
      points: [
        { label: "온라인", value: 5 },
        { label: "매장", value: 3 },
        { label: "도매", value: 2 },
      ],
    });
    expect(series(markup, "stroke")).toEqual(["1", "2", "3"]);
    expect(series(markup, "bg")).toEqual(["1", "2", "3"]);
  });

  test("no mark carries a colour of its own: a value written on the element cannot follow the theme", () => {
    for (const markup of [
      drawn("showBarChart", {
        title: "t",
        points: [{ label: "a", value: 1 }],
      }),
      drawn("showProgress", {
        title: "t",
        points: [{ label: "a", value: 1, target: 2 }],
      }),
      drawn("showPieChart", {
        title: "t",
        points: [{ label: "a", value: 1 }],
      }),
      drawn("showLineChart", {
        title: "t",
        labels: ["a", "b"],
        series: [{ name: "s", values: [1, 2] }],
      }),
    ]) {
      expect(markup).not.toMatch(/#[0-9a-f]{6}\b/i);
      expect(markup).not.toMatch(/style="[^"]*background/);
      expect(markup).not.toMatch(/stroke="(?!none)[^"]/);
    }
  });
});
