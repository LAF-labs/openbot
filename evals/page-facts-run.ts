/**
 * `bun run eval:page-facts` — the page-facts questions against the real decisions model, over pages
 * somebody else labelled, scored by `page-facts.ts` the way the product would act on the answers.
 *
 *   bun run eval:page-facts                 (OPENAI_API_KEY and an OpenRouter OPENAI_BASE_URL)
 *
 * Jev is asked about EVERY page in every run, though the product would ask only where the status
 * and the password field have not already decided and the text is 1,500 characters or less. It is
 * the same title and 600 characters either way, so the same tokens, and asking every page is the
 * only way to say whether the length limit is also keeping it right. Each arm is scored only on what
 * it would have asked.
 *
 * `EVAL_RUNS` (default 3: §6's stability bar is over three) asks every page that many times;
 * `EVAL_WIDTH` (default 4, as `eval:first-move`) is how many are in flight; `EVAL_SHOW=1` prints
 * every page with its answers; `EVAL_FROM=<report>` scores a saved report again without asking
 * anything. The report lands in evals/reports/ (local only) and holds ids and numbers, no text.
 */
import { mkdirSync } from "node:fs";
import {
  askDecision,
  type DecisionCall,
  decisionBaseUrlOf,
} from "../server/src/computer/decision-call";
import {
  ARMS,
  type Arm,
  asksJev,
  decidableFromText,
  dropReasons,
  factOf,
  isSoftUnusable,
  type JevAnswer,
  type LabelledPage,
  observe,
  PAGE_FACTS_BARS,
  PAGE_FACTS_MAX_CHARS,
  PAGE_FACTS_QUESTIONS,
  pageFactsStateOf,
  quantile,
  recommendedBar,
  type Score,
  SWEEP_BARS,
  scoreOf,
  shareOf,
  stabilityOf,
  type Tally,
  verdictOf,
} from "./page-facts";

/** One request, as the report keeps it: numbers only. */
type Ask = {
  run: number;
  id: string;
  unusable: number | null;
  captcha: number | null;
  ms: number;
  because: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const KEY = process.env.OPENAI_API_KEY ?? "";
const BASE = process.env.OPENAI_BASE_URL ?? "";
const MODEL = process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917";
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? "3") || 3);
const WIDTH = Math.max(1, Number(process.env.EVAL_WIDTH ?? "4") || 4);
const SHOW = process.env.EVAL_SHOW === "1";
const FROM = process.env.EVAL_FROM ?? "";
/** Asked with room to spare, so how long an answer takes is measured rather than cut. */
const EVAL_TIMEOUT_MS = 8_000;

const pages = (
  await Bun.file(new URL("./page-facts/pages.jsonl", import.meta.url)).text()
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as LabelledPage);

/**
 * `askDecision` logs `jev_consulted` for every request, on stdout. Hundreds of them would bury the
 * report; the outcome each one carries is kept in the report instead.
 */
function quietly<T>(work: () => Promise<T>): Promise<T> {
  const said = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes('"jev_consulted"')) {
      return;
    }
    said(...args);
  };
  return work().then(
    (value) => {
      console.log = said;
      return value;
    },
    (error: unknown) => {
      console.log = said;
      throw error;
    },
  );
}

async function ask(call: DecisionCall, page: LabelledPage, run: number) {
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const decided = await askDecision(
    {
      ...call,
      onUsage: (counted) => {
        usage = {
          inputTokens: counted.promptTokens,
          outputTokens: counted.completionTokens,
          costUsd: counted.costUsd ?? 0,
        };
      },
    },
    {
      purpose: "eval-page-facts",
      state: pageFactsStateOf(page),
      questions: PAGE_FACTS_QUESTIONS,
      timeoutMs: EVAL_TIMEOUT_MS,
    },
  );
  const p = (name: string) => {
    if (!decided.ok) return null;
    const answer = decided.answers[name];
    return answer && "noul" in answer ? answer.noul : null;
  };
  return {
    run,
    id: page.id,
    unusable: p("unusable"),
    captcha: p("captcha"),
    ms: decided.ms,
    because: decided.ok ? null : decided.because,
    ...usage,
  } satisfies Ask;
}

/** A few at a time: the endpoint is shared with everything else this key does. */
async function all<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index] as T);
      }
    }),
  );
  return out;
}

async function asked(): Promise<{ asks: Ask[]; warmUp: Ask | null }> {
  if (FROM) {
    return JSON.parse(await Bun.file(FROM).text()) as {
      asks: Ask[];
      warmUp: Ask | null;
    };
  }
  const decisionBase = decisionBaseUrlOf(BASE);
  if (!KEY || !decisionBase) {
    console.error(
      "Needs OPENAI_API_KEY and an OpenRouter OPENAI_BASE_URL: Jev is reached through OpenRouter.",
    );
    process.exit(1);
  }
  const call: DecisionCall = {
    baseUrl: decisionBase,
    model: MODEL,
    apiKey: async () => KEY,
  };
  return quietly(async () => {
    // The first request of a process pays for the connection; the product's is a long-lived one.
    // Asked about the first page, counted in what was spent, and not in how long a request takes.
    const warmUp = await ask(call, pages[0] as LabelledPage, 0);
    const out: Ask[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
      out.push(...(await all(pages, WIDTH, (page) => ask(call, page, run))));
    }
    return { asks: out, warmUp };
  });
}
const { asks, warmUp } = await asked();

const runCount = Math.max(0, ...asks.map((item) => item.run));
const runs: Map<string, JevAnswer>[] = Array.from(
  { length: runCount },
  (_, index) =>
    new Map(
      asks
        .filter((item) => item.run === index + 1)
        .map((item) => [
          item.id,
          item.unusable === null || item.captcha === null
            ? null
            : { unusable: item.unusable, captcha: item.captcha },
        ]),
    ),
);

/* ── formatting ────────────────────────────────────────────────────────────────────────────── */
const pct = (share: number) => `${(100 * share).toFixed(1)}%`;
const of = (t: Tally) =>
  `${pct(shareOf(t))} ${t.hit}/${t.n}${t.hit > 0 ? ` [${t.ids.length}p]` : ""}`;
const pad = (text: string, width: number) => text.padEnd(width);
const ARM_NAMES: Record<Arm, string> = {
  rules: "rules",
  "rules+words": "+words",
  "rules+jev": "+Jev ≤1,500",
  "jev-any-length": "+Jev any length",
};
const answersOf = (id: string) =>
  runs
    .map((answers) => {
      const answer = answers.get(id);
      return answer
        ? `${answer.unusable.toFixed(2)}/${answer.captcha.toFixed(2)}`
        : "—";
    })
    .join(" ");

/* ── the set ───────────────────────────────────────────────────────────────────────────────── */
const usable = pages.filter((page) => !page.unusable);
const soft = pages.filter(isSoftUnusable);
const unreadable = pages.filter((page) => !decidableFromText(page));
const productAsks = pages.filter((page) => asksJev(page, "rules+jev"));
const count = <T>(items: readonly T[], key: (item: T) => string) =>
  Object.entries(Object.groupBy(items, key))
    .map(([name, group]) => `${name} ${group?.length ?? 0}`)
    .join(", ");

console.log(
  `\npage facts · ${MODEL} · ${pages.length} labelled pages × ${runCount} run(s) · width ${WIDTH}${FROM ? ` · scored again from ${FROM}` : ""}\n`,
);
console.log("the set");
console.log(
  `  usable ${usable.length} (hard good ${usable.filter((page) => page.hardGood).length}) · unusable ${pages.length - usable.length}: status ≥ 400 ${pages.filter((page) => page.unusable && page.status >= 400).length}, below 400 ${pages.filter((page) => page.unusable && page.status < 400).length} (sign-in wall ${pages.filter((page) => page.signInWall).length}, CAPTCHA ${pages.filter((page) => page.unusable && page.captcha && page.status < 400).length}, the rest — "soft" — ${soft.length})`,
);
console.log(
  `  cannot be decided from text: ${unreadable.length} — ${count(unreadable, (page) => page.decidingIn)}; of the soft ones ${soft.filter((page) => !decidableFromText(page)).length}`,
);
console.log(
  `  the product would ask Jev about ${productAsks.length} pages (status < 400, no password field, text ≤ ${PAGE_FACTS_MAX_CHARS.toLocaleString()}); of the soft ones ${soft.filter((page) => asksJev(page, "rules+jev")).length}`,
);
if (warmUp) {
  const first = warmUp;
  console.log(
    `  warm-up: one request, ${first.ms} ms${first.because ? ` (${first.because})` : ""} — not counted in the times below`,
  );
}

/* ── the sweep ─────────────────────────────────────────────────────────────────────────────── */
const sweep = SWEEP_BARS.map((bar) => {
  const jev = scoreOf(observe(pages, "rules+jev", runs, bar));
  const anyLength = scoreOf(observe(pages, "jev-any-length", runs, bar));
  const stable = stabilityOf(productAsks, "rules+jev", runs, bar);
  return {
    bar,
    jev,
    anyLength,
    stable,
    falseUnusable: shareOf(jev.falseUnusable),
    softCaught: shareOf(jev.soft),
  };
});
console.log(
  `\nthe sweep — one bar for both questions, +Jev ≤1,500 unless said; pooled over ${runCount} run(s), [Np] = distinct pages`,
);
console.log(
  `  ${pad("bar", 6)}${pad("false unusable", 22)}${pad("soft caught", 22)}${pad("soft, from text", 22)}${pad("CAPTCHA caught", 20)}${pad("false CAPTCHA", 20)}${pad("same 3 runs", 16)}false unusable, any length`,
);
for (const step of sweep) {
  console.log(
    `  ${pad(step.bar.toFixed(2), 6)}${pad(of(step.jev.falseUnusable), 22)}${pad(of(step.jev.soft), 22)}${pad(of(step.jev.softFromText), 22)}${pad(of(step.jev.captchas), 20)}${pad(of(step.jev.falseCaptchas), 20)}${pad(`${pct(step.stable.stable / Math.max(1, step.stable.n))} ${step.stable.stable}/${step.stable.n}`, 16)}${of(step.anyLength.falseUnusable)}`,
  );
}

const recommended = recommendedBar(sweep);
const bar = recommended ?? 0.85;
console.log(
  recommended === null
    ? "\nNO BAR keeps false unusable at 1% or less; the tables below are at §6's provisional 0.85."
    : `\nrecommended bar: ${bar.toFixed(2)} — the lowest from which every higher bar keeps false unusable at 1% or less (§6's provisional bar was 0.85)`,
);

/* ── the arms at that bar ──────────────────────────────────────────────────────────────────── */
const scores = Object.fromEntries(
  ARMS.map((arm) => [arm, scoreOf(observe(pages, arm, runs, bar))]),
) as Record<Arm, Score>;
const ROWS: Array<[string, keyof Score]> = [
  ['false "unusable" on a usable page (≤ 1%)', "falseUnusable"],
  ["soft unusable caught (≥ 70%)", "soft"],
  ["  of them decidable from text", "softFromText"],
  ["soft unusable told anything", "softAny"],
  ["sign-in walls told sign_in_wall", "walls"],
  ["not a wall, told sign_in_wall", "falseWalls"],
  ["CAPTCHA told captcha", "captchas"],
  ["not a CAPTCHA, told captcha", "falseCaptchas"],
  ["usable page told anything", "anyFactOnUsable"],
];
const armTable = (title: string, among: (page: LabelledPage) => boolean) => {
  const subset = pages.filter(among);
  console.log(`\n${title} — ${subset.length} pages, at bar ${bar.toFixed(2)}`);
  console.log(
    `  ${pad("", 44)}${ARMS.map((arm) => pad(ARM_NAMES[arm], 22)).join("")}`,
  );
  const subsetScores = ARMS.map((arm) =>
    scoreOf(observe(subset, arm, runs, bar)),
  );
  for (const [label, key] of ROWS) {
    if (subsetScores.every((score) => score[key].n === 0)) continue;
    console.log(
      `  ${pad(label, 44)}${subsetScores.map((score) => pad(of(score[key]), 22)).join("")}`,
    );
  }
};
armTable("all pages", () => true);
armTable("hard good", (page) => page.hardGood);
armTable(
  "the pages not in the earlier set — the questions never met them",
  (page) => !page.fromEarlierSet,
);
armTable(
  "cannot be decided from text (dialog, screen, empty)",
  (page) => !decidableFromText(page),
);

/* ── the pages behind the numbers ──────────────────────────────────────────────────────────── */
const at = (arm: Arm, page: LabelledPage) =>
  [
    ...new Set(
      runs.map((answers) =>
        factOf(page, arm, answers.get(page.id) ?? null, bar),
      ),
    ),
  ]
    .map((fact) => fact ?? "—")
    .join("|");
const line = (page: LabelledPage) =>
  `${pad(page.id, 34)} ${pad(page.kind, 11)} ${pad(page.decidingIn, 6)} ${String(page.status).padStart(3)} ${String(page.textLength).padStart(5)} ch  Jev u/c ${answersOf(page.id)}`;

console.log(
  `\nthe pages behind them, +Jev ≤1,500 at ${bar.toFixed(2)} (Jev u/c: unusable/captcha per run)`,
);
const falseUnusable = usable.filter((page) =>
  scores["rules+jev"].falseUnusable.ids.includes(page.id),
);
console.log(`  usable, told page_unusable: ${falseUnusable.length}`);
for (const page of falseUnusable) {
  console.log(`    ${line(page)}${page.hardGood ? "  hard good" : ""}`);
}
const toldOtherwise = usable.filter(
  (page) =>
    !falseUnusable.includes(page) &&
    scores["rules+jev"].anyFactOnUsable.ids.includes(page.id),
);
console.log(`  usable, told something else: ${toldOtherwise.length}`);
for (const page of toldOtherwise) {
  console.log(`    ${line(page)}  → ${at("rules+jev", page)}`);
}
const missed = soft.filter(
  (page) => !scores["rules+jev"].soft.ids.includes(page.id),
);
console.log(`  soft unusable, never told page_unusable: ${missed.length}`);
for (const page of missed) {
  const why =
    page.passwordFields > 0
      ? "password field"
      : page.textLength > PAGE_FACTS_MAX_CHARS
        ? "too long to send"
        : "below the bar";
  console.log(`    ${line(page)}  ${why} → ${at("rules+jev", page)}`);
}
const partly = soft.filter(
  (page) =>
    scores["rules+jev"].soft.ids.includes(page.id) &&
    at("rules+jev", page).includes("|"),
);
console.log(`  soft unusable, told in some runs only: ${partly.length}`);
for (const page of partly) console.log(`    ${line(page)}`);
const anyLengthOnly = usable.filter(
  (page) =>
    scores["jev-any-length"].falseUnusable.ids.includes(page.id) &&
    !falseUnusable.includes(page),
);
console.log(
  `  usable, told page_unusable only without the length limit: ${anyLengthOnly.length}`,
);
for (const page of anyLengthOnly) console.log(`    ${line(page)}`);
console.log(`  cannot be decided from text: ${unreadable.length}`);
for (const page of unreadable) {
  console.log(
    `    ${line(page)}  ${page.unusable ? "unusable" : "usable  "} → rules ${at("rules", page)} · +words ${at("rules+words", page)} · +Jev ${at("rules+jev", page)}`,
  );
}
const unstable = stabilityOf(productAsks, "rules+jev", runs, bar);
console.log(
  `  a different fact in different runs: ${unstable.unstable.length}`,
);
for (const id of unstable.unstable) {
  const page = pages.find((item) => item.id === id) as LabelledPage;
  console.log(`    ${line(page)}  → ${at("rules+jev", page)}`);
}

/* ── time, tokens, money ───────────────────────────────────────────────────────────────────── */
const askedIds = new Set(productAsks.map((page) => page.id));
const productTimes = asks
  .filter((item) => askedIds.has(item.id))
  .map((item) => item.ms);
const allTimes = asks.map((item) => item.ms);
const noAnswer = asks.filter((item) => item.because !== null);
const p95 = quantile(productTimes, 0.95);
console.log("\nhow long a request takes, from this Mac");
console.log(
  `  the product's asks: ${productTimes.length} · p50 ${quantile(productTimes, 0.5)} ms · p95 ${p95} ms · max ${Math.max(0, ...productTimes)} ms · over 400 ms ${productTimes.filter((ms) => ms > 400).length} · over 1,200 ms ${productTimes.filter((ms) => ms > 1_200).length}`,
);
console.log(
  `  every ask:          ${allTimes.length} · p50 ${quantile(allTimes, 0.5)} ms · p95 ${quantile(allTimes, 0.95)} ms · max ${Math.max(0, ...allTimes)} ms · no answer ${noAnswer.length}${noAnswer.length ? ` (${count(noAnswer, (item) => item.because ?? "")})` : ""}`,
);
const spentOn = [...asks, ...(warmUp ? [warmUp] : [])];
const spent = spentOn.reduce((sum, item) => sum + item.costUsd, 0);
const inputs = asks.map((item) => item.inputTokens);
const outputs = asks.map((item) => item.outputTokens);
const meanCost =
  asks.reduce((sum, item) => sum + item.costUsd, 0) / Math.max(1, asks.length);
console.log("tokens and money");
console.log(
  `  per request: input p50 ${quantile(inputs, 0.5)}, max ${Math.max(0, ...inputs)} · output p50 ${quantile(outputs, 0.5)} · US$${meanCost.toFixed(6)} on average`,
);
console.log(
  `  per page, as the product would send: ${productAsks.length} of ${pages.length} pages asked, US$${((meanCost * productAsks.length) / pages.length).toFixed(6)} a page read`,
);
console.log(
  `  spent: US$${spent.toFixed(4)} over ${spentOn.length} requests (warm-up included) · ${spentOn.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0).toLocaleString()} tokens`,
);

if (SHOW) {
  console.log("\nevery page");
  for (const page of pages) {
    console.log(
      `  ${line(page)}  ${page.unusable ? "U" : "-"}${page.signInWall ? "W" : "-"}${page.captcha ? "C" : "-"} → ${at("rules+jev", page)}`,
    );
  }
}

/* ── the verdict ───────────────────────────────────────────────────────────────────────────── */
const jevAt = scores["rules+jev"];
const stableShare = unstable.stable / Math.max(1, unstable.n);
const failed = verdictOf({
  falseUnusable: shareOf(jevAt.falseUnusable),
  softCaught: shareOf(jevAt.soft),
  stable: stableShare,
  p95Ms: p95,
});
if (recommended === null) failed.unshift("no bar keeps false unusable at 1%");
if (runCount < 3) failed.push(`only ${runCount} run(s): stability unmeasured`);
const drop = dropReasons({
  sweep,
  words: {
    falseUnusable: shareOf(scores["rules+words"].falseUnusable),
    softCaught: shareOf(scores["rules+words"].soft),
  },
  jev: { softCaught: shareOf(jevAt.soft) },
});
const mark = (ok: boolean) => (ok ? "ok" : "FAIL");
console.log(`\nverdict at bar ${bar.toFixed(2)}, against §6`);
console.log(
  `  ${pad('false "unusable" on a usable page', 36)}${pad(of(jevAt.falseUnusable), 22)}${pad("≤ 1%", 10)}${mark(shareOf(jevAt.falseUnusable) <= PAGE_FACTS_BARS.falseUnusable)}`,
);
console.log(
  `  ${pad("soft unusable caught", 36)}${pad(of(jevAt.soft), 22)}${pad("≥ 70%", 10)}${mark(shareOf(jevAt.soft) >= PAGE_FACTS_BARS.softCaught)}`,
);
console.log(
  `  ${pad("  of them decidable from text", 36)}${of(jevAt.softFromText)}`,
);
console.log(
  `  ${pad("same fact in all runs", 36)}${pad(`${pct(stableShare)} ${unstable.stable}/${unstable.n}`, 22)}${pad("≥ 98%", 10)}${mark(stableShare >= PAGE_FACTS_BARS.stable && runCount >= 3)}`,
);
console.log(
  `  ${pad("p95 per request", 36)}${pad(`${p95} ms`, 22)}${pad("≤ 400 ms", 10)}${mark(p95 <= PAGE_FACTS_BARS.p95Ms)}`,
);
console.log(
  `  ${pad("plain rules (+words), same bar", 36)}false unusable ${of(scores["rules+words"].falseUnusable)} · soft caught ${of(scores["rules+words"].soft)}`,
);
console.log(
  `  the numbers that drop it: ${drop.length ? drop.join("; ") : "none of the two this eval can see"} (the third — the Bot acting the same with the fact as without — is eval:model's)`,
);
console.log(
  `verdict: ${failed.length || drop.length ? "FAIL" : "PASS"}${failed.length ? ` — ${failed.join("; ")}` : ""}${drop.length ? ` — dropped: ${drop.join("; ")}` : ""}`,
);

mkdirSync("evals/reports", { recursive: true });
const file = `evals/reports/page-facts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(
  file,
  JSON.stringify(
    {
      model: MODEL,
      ranAt: new Date().toISOString(),
      runs: runCount,
      width: WIDTH,
      bar,
      recommended,
      failed,
      drop,
      spentUsd: spent,
      warmUp,
      asks,
    },
    null,
    2,
  ),
);
console.log(`report: ${file}`);
process.exit(failed.length || drop.length ? 1 : 0);
