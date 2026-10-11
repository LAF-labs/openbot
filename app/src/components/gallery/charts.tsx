import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { activeLocale, t } from "@/lib/i18n";
import { GalleryFrame } from "./frame";
import { leadColour, seriesColour } from "./palette";
import { GALLERY_CONFIRMATIONS } from "@shared/tools/gallery";

const point = z.object({
  label: z
    .string()
    .describe("What this point is called, e.g. a month or a team"),
  value: z.number().describe("Its value"),
});

const common = {
  title: z.string().describe("A short title for the chart"),
  caption: z
    .string()
    .optional()
    .describe(
      "One line under the title saying what the reader should take from it",
    ),
};

/** Charts share a height so several in one answer do not stagger down the page. */
const HEIGHT = 180;

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(activeLocale, { maximumFractionDigits: 0 });
  }
  return String(Math.round(value * 100) / 100);
}

/**
 * THE ROOM A LABEL NEEDS BEFORE IT IS DRAWN, as a container query on its own column
 * (`@container/bar` under each bar, `@container/tick` under each axis label). Twelve months of
 * seven-digit figures in 홈's 255px card (2026-10-11) put each column at 11px: the values were
 * drawn over one another and every month was cut to "1..". Under the width its text needs, a
 * label is kept for a screen reader and taken off the screen; the bars still say what they say,
 * and the card is pressed to be read where it was made.
 *
 * The width is the text's own, measured at this type size: "12" is 15px, "1,234" 33px,
 * "1,234,000" 58px, "12,345,678" 66px; "월" 11px, "1월" 16px, "12월" 23px, "Jan" 20px. Whole
 * class names in a table, because Tailwind sees a class only where it is written out.
 */
const VALUE_ROOM = {
  short: "@max-[1.5rem]/bar:sr-only",
  medium: "@max-[2.5rem]/bar:sr-only",
  long: "@max-[4.5rem]/bar:sr-only",
  longer: "@max-[5rem]/bar:sr-only",
} as const;

const LABEL_ROOM = {
  bar: {
    one: "@max-[1rem]/bar:sr-only",
    two: "@max-[1.5rem]/bar:sr-only",
    more: "@max-[2rem]/bar:sr-only",
  },
  tick: {
    one: "@max-[1rem]/tick:sr-only",
    two: "@max-[1.5rem]/tick:sr-only",
    more: "@max-[2rem]/tick:sr-only",
  },
} as const;

function valueRoom(text: string): string {
  if (text.length <= 3) return VALUE_ROOM.short;
  if (text.length <= 6) return VALUE_ROOM.medium;
  if (text.length <= 9) return VALUE_ROOM.long;
  return VALUE_ROOM.longer;
}

/**
 * `text` may not be there yet: a chart is drawn while the Bot is still writing it, and a point
 * arrives as `{}` before its label does. Reading its length threw, and a card that throws once in
 * the conversation is the "could not be drawn" line from then on (review of #189, 2026-10-11).
 */
function labelRoom(
  text: string | undefined,
  under: keyof typeof LABEL_ROOM,
): string {
  const room = LABEL_ROOM[under];
  const length = text?.length ?? 0;
  if (length <= 1) return room.one;
  if (length <= 2) return room.two;
  return room.more;
}

/** Nothing to draw is a sentence. An empty axis reads as a component that failed. */
function Empty() {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">
      {t("There is no data to chart.")}
    </p>
  );
}

function Legend({ items }: { items: { label: string; colour: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <li className="flex items-center gap-1.5 text-xs" key={item.label}>
          <span className={`size-2 shrink-0 rounded-[3px] ${item.colour}`} />
          <span className="text-muted-foreground">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

export const BarChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One bar per point, in the order they should appear"),
});

export function BarChartCard({
  title,
  caption,
  points: given,
}: Partial<z.infer<typeof BarChartProps>>) {
  const points = given ?? [];
  const max = Math.max(...points.map((entry) => entry.value ?? 0), 0);
  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 ? (
        <Empty />
      ) : (
        // Columns stretch to full row height so percentage bar heights use the chart area.
        <div className="flex items-stretch gap-2" style={{ height: HEIGHT }}>
          {points.map((entry) => (
            // Each column measures itself, and a label with no room gives way (`valueRoom`).
            <div
              className="@container/bar flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              key={entry.label}
            >
              <span
                className={`${valueRoom(formatNumber(entry.value))} text-xs tabular-nums text-muted-foreground`}
              >
                {formatNumber(entry.value)}
              </span>
              {/* The bar lives in its own flexible box so the number above and the label below keep
                  their natural height and only the bar itself scales. */}
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t-md transition-[height] ${leadColour("bg")}`}
                  style={{
                    // Normalize to the largest bar so similar values still show their differences.
                    height:
                      max > 0
                        ? `${Math.max((entry.value / max) * 100, 2)}%`
                        : "2%",
                  }}
                />
              </div>
              <span
                className={`${labelRoom(entry.label, "bar")} w-full truncate text-center text-xs text-muted-foreground`}
              >
                {entry.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </GalleryFrame>
  );
}

export const PieChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One slice per point. Values are summed to make the whole"),
});

export function PieChartCard({
  title,
  caption,
  points: given,
}: Partial<z.infer<typeof PieChartProps>>) {
  const points = given ?? [];
  const size = 160;
  const stroke = 28;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = points.reduce((sum, entry) => sum + (entry.value || 0), 0);

  /*
   * A loop rather than a `map` whose callback advanced `travelled`: the React Compiler cannot tell a
   * callback that runs now from one kept for later, so it refuses to compile a component whose
   * callback reassigns a variable from outside it.
   */
  const slices = [];
  let travelled = 0;
  for (const [index, entry] of points.entries()) {
    const arc = total > 0 ? (entry.value / total) * circumference : 0;
    slices.push({
      ...entry,
      arc,
      offset: -travelled,
      stroke: seriesColour(index, "stroke"),
      swatch: seriesColour(index, "bg"),
    });
    travelled += arc;
  }

  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 || total <= 0 ? (
        <Empty />
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          {/* One circle per slice: dasharray controls length and dashoffset controls start. */}
          <svg
            aria-hidden="true"
            className="shrink-0 -rotate-90"
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            width={size}
          >
            {slices.map((slice) => (
              <circle
                className={slice.stroke}
                cx={size / 2}
                cy={size / 2}
                fill="none"
                key={slice.label}
                r={radius}
                strokeDasharray={`${slice.arc} ${circumference - slice.arc}`}
                strokeDashoffset={slice.offset}
                strokeWidth={stroke}
              />
            ))}
          </svg>
          {/*
           * The legend asks for a width of its own, so beside a donut in 홈's 255px card it wraps
           * underneath instead of being squeezed to its percentages with no names (measured
           * 2026-10-11: 39px, every label truncated away). Beside a conversation it still fits.
           */}
          <ul className="min-w-0 flex-1 basis-32 space-y-1.5">
            {slices.map((slice) => (
              <li className="flex items-center gap-2 text-sm" key={slice.label}>
                <span
                  className={`size-2.5 shrink-0 rounded-[3px] ${slice.swatch}`}
                />
                <span className="min-w-0 flex-1 truncate">{slice.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round((slice.value / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Line and area */

const seriesSchema = z.object({
  name: z.string().describe("What this line is called"),
  values: z
    .array(z.number())
    .describe("One value per label, in the same order"),
});

export const LineChartProps = z.object({
  ...common,
  labels: z.array(z.string()).describe("The x axis, e.g. months"),
  series: z.array(seriesSchema).describe("One line per series"),
});

type LineArgs = z.infer<typeof LineChartProps>;

/**
 * Line and area are the same geometry, so they are the same function.
 *
 * Sharing the scaler keeps line and area charts aligned.
 */
function Plot({
  labels,
  series,
  filled,
}: { labels: string[]; series: { name: string; values: number[] }[] } & {
  filled: boolean;
}) {
  const width = 520;
  const height = HEIGHT;
  const pad = { top: 8, right: 8, bottom: 18, left: 8 };

  const all = series.flatMap((line) => line.values);
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const steps = Math.max(labels.length - 1, 1);

  const xAt = (index: number) =>
    pad.left + (index / steps) * (width - pad.left - pad.right);
  const yAt = (value: number) =>
    pad.top + (1 - (value - min) / span) * (height - pad.top - pad.bottom);

  return (
    <>
      <svg
        aria-hidden="true"
        className="w-full"
        height={height}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        {/* Two guide lines give slope context without turning the chart into a grid. */}
        {[0.5, 1].map((fraction) => (
          <line
            className="stroke-border"
            key={fraction}
            strokeDasharray="3 3"
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + fraction * (height - pad.top - pad.bottom)}
            y2={pad.top + fraction * (height - pad.top - pad.bottom)}
          />
        ))}
        {series.map((line, index) => {
          const points = line.values.map(
            (value, i) => `${xAt(i)},${yAt(value)}`,
          );
          return (
            <g key={line.name}>
              {filled ? (
                <polygon
                  className={seriesColour(index, "fill")}
                  fillOpacity={0.14}
                  points={`${xAt(0)},${height - pad.bottom} ${points.join(" ")} ${xAt(line.values.length - 1)},${height - pad.bottom}`}
                />
              ) : null}
              <polyline
                className={seriesColour(index, "stroke")}
                fill="none"
                points={points.join(" ")}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      {/*
       * One column per label, each measuring itself, as the bar chart's columns do (`labelRoom`):
       * a label with no room is kept for a screen reader and taken off the screen rather than cut
       * to "1...", which twelve months in 홈's 255px card were (2026-10-11). The first and last sit
       * on the axis's ends, where their points are.
       */}
      <div className="flex">
        {labels.map((label) => (
          <span
            className="@container/tick min-w-0 flex-1 text-center first:text-left last:text-right"
            key={label}
          >
            <span
              className={`${labelRoom(label, "tick")} block truncate text-xs text-muted-foreground`}
            >
              {label}
            </span>
          </span>
        ))}
      </div>
      {series.length > 1 ? (
        <Legend
          items={series.map((line, index) => ({
            label: line.name,
            colour: seriesColour(index, "bg"),
          }))}
        />
      ) : null}
    </>
  );
}

export function LineChartCard(args: Partial<LineArgs>) {
  const labels = args.labels ?? [];
  const series = (args.series ?? []).map((line) => ({
    name: line.name ?? "",
    values: line.values ?? [],
  }));
  return (
    <GalleryFrame caption={args.caption} title={args.title}>
      {series.length === 0 || labels.length === 0 ? (
        <Empty />
      ) : (
        <Plot filled={false} labels={labels} series={series} />
      )}
    </GalleryFrame>
  );
}

// Not exported: it is `LineChartProps` under a second name, which the import graph's check
// (`tests/knip.test.ts`) reports as a duplicate export the moment a test imports this file.
const AreaChartProps = LineChartProps;

export function AreaChartCard(args: Partial<LineArgs>) {
  const labels = args.labels ?? [];
  const series = (args.series ?? []).map((line) => ({
    name: line.name ?? "",
    values: line.values ?? [],
  }));
  return (
    <GalleryFrame caption={args.caption} title={args.title}>
      {series.length === 0 || labels.length === 0 ? (
        <Empty />
      ) : (
        <Plot filled labels={labels} series={series} />
      )}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Progress */

export const ProgressChartProps = z.object({
  ...common,
  points: z
    .array(
      point.extend({
        target: z.number().describe("What the value is measured against"),
      }),
    )
    .describe("One row per thing being tracked"),
});

/**
 * Progress against a target, distinct from comparing independent bars.
 */
export function ProgressChartCard({
  title,
  caption,
  points: given,
}: Partial<z.infer<typeof ProgressChartProps>>) {
  const points = given ?? [];
  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-3">
          {points.map((entry) => {
            const share =
              entry.target > 0
                ? Math.min((entry.value / entry.target) * 100, 100)
                : 0;
            return (
              <li key={entry.label}>
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="min-w-0 truncate">{entry.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(entry.value)} / {formatNumber(entry.target)}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-foreground/5">
                  <div
                    className={`h-full rounded-full ${leadColour("bg")}`}
                    style={{ width: `${share}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </GalleryFrame>
  );
}

/** Gallery component registration kept beside the chart implementations. */
export const GALLERY: GalleryComponent[] = [
  {
    name: "showBarChart",
    title: "Bar chart",
    kind: "chart",
    description:
      "Show values as a bar chart. Use when comparing a handful of named things, teams, months, categories. Not for a trend over time, which is showLineChart.",
    parameters: BarChartProps,
    Component: BarChartCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showBarChart,
  },
  {
    name: "showPieChart",
    title: "Donut chart",
    kind: "chart",
    description:
      "Show how a whole is divided, as a donut with a legend. Use only when the parts sum to something meaningful, and prefer a bar chart above about six slices.",
    parameters: PieChartProps,
    Component: PieChartCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showPieChart,
  },
  {
    name: "showLineChart",
    title: "Line chart",
    kind: "chart",
    description:
      "Show one or more series over an ordered axis, usually time. Every series must have one value per label.",
    parameters: LineChartProps,
    Component: LineChartCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showLineChart,
  },
  {
    name: "showAreaChart",
    title: "Area chart",
    kind: "chart",
    description:
      "The same as showLineChart with the area under each line filled. Use for volume or accumulation rather than for a rate.",
    parameters: AreaChartProps,
    Component: AreaChartCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showAreaChart,
  },
  {
    name: "showProgress",
    title: "Progress against target",
    kind: "chart",
    description:
      "Show values against their targets as progress bars. Use for 'are we there yet' questions, budget spent against budget, done against planned.",
    parameters: ProgressChartProps,
    Component: ProgressChartCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showProgress,
  },
];
