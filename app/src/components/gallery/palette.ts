/**
 * Fixed chart palette. Models do not choose series colours, so a series keeps the same colour across
 * charts and avoids state colours such as refusal red.
 *
 * THE FIRST IS THE ACCENT (the owner, 2026-10-11): a card has one thing it is about, and in a chart
 * that is its first series. The colours are the sheet's `--chart-1` … `--chart-6`, so the first
 * follows the accent into the dark; they were six hex values here, the same in both themes, put on
 * each mark as an inline style. Whole class names in a table, because Tailwind sees a class only
 * where it is written out.
 */
const SERIES = [
  { bg: "bg-chart-1", stroke: "stroke-chart-1", fill: "fill-chart-1" },
  { bg: "bg-chart-2", stroke: "stroke-chart-2", fill: "fill-chart-2" },
  { bg: "bg-chart-3", stroke: "stroke-chart-3", fill: "fill-chart-3" },
  { bg: "bg-chart-4", stroke: "stroke-chart-4", fill: "fill-chart-4" },
  { bg: "bg-chart-5", stroke: "stroke-chart-5", fill: "fill-chart-5" },
  { bg: "bg-chart-6", stroke: "stroke-chart-6", fill: "fill-chart-6" },
] as const;

/** How a mark takes its colour: a block's background, a line's stroke, an area's fill. */
type Paint = keyof (typeof SERIES)[number];

/** The class that paints the series at `index`, counted from the accent and wrapping after six. */
export function seriesColour(index: number, paint: Paint): string {
  return (SERIES[index % SERIES.length] as (typeof SERIES)[number])[paint];
}

/**
 * The accent, for a card whose marks are all one series: the bars of a bar chart, the fills of a
 * progress card. One colour per bar said nothing — a bar's colour was its place in the row — and
 * left the card with no one thing to look at.
 */
export function leadColour(paint: Paint): string {
  return seriesColour(0, paint);
}
