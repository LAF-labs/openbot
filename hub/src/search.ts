import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_SEARCH_HITS,
  HUB_SEARCH_MAX_HITS,
  HUB_SNIPPET_CHARS,
  type HubSearchHit,
  type HubSearchRequest,
  type HubSearchResult,
} from "../../shared/hub/protocol";
import {
  charLength,
  type HubSearchWord,
  searchWords,
} from "../../shared/hub/search-words";
import { recordAudit, trailOf } from "./audit";
import type { MemberVariables } from "./auth";
import type { HubDatabase } from "./db/client";
import { hubChunks, hubFiles, hubFileVersions } from "./db/schema";
import { chunkStart } from "./files/chunks";
import { visibleTo } from "./visibility";

/**
 * `POST /hub/v1/search`, stage one: words, not meanings (design §6.1). No model and no vectors —
 * the substring index, a score from facts the hub has, and the permission inside the query.
 *
 * HOW A QUERY IS READ (`shared/hub/search-words.ts`): words split on spaces, each found when any of
 * its forms is in the text — the word as typed, and without its particle ("정산은" → "정산").
 * Every word must be found.
 *
 * TWO CHARACTERS HAVE NO TRIGRAM. A two-character form cannot use the index and reads every chunk
 * (0065 measured 0.5 s on 100,000 rows for the product's messages). So a query whose words are
 * all shorter than three characters looks only at file names, a small table; the chunks are read
 * when at least one word as typed has three characters or more.
 *
 * THE SCORE: `word_similarity` of the query, each word in its shortest form, to the chunk (how
 * closely some stretch of the chunk holds the query, 0 to 1) + 0.3 when every word is in the file's name + 0.1 when written in the last thirty
 * days + 0.2 when the file is the asking run's task. `word_similarity` rather than the design's
 * `similarity`: the latter compares the query with the WHOLE chunk, and a few words against 1,200
 * characters scores near nothing for every chunk alike — it would rank nothing.
 */

/** Candidates read before the best are picked: enough that the last bonus can still reorder. */
const CANDIDATES = 50;
/** Matching chunks scored at most, newest first (see the pool in `search`). */
const POOL = 200;
/** The design's bound for a search (§4.1). Past it the answer is a fact, not a hung request. */
const SEARCH_TIMEOUT_MS = 10_000;
/** How much of a snippet comes before the word found, so it is read with what led to it. */
const SNIPPET_LEAD = 60;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A form as a LIKE pattern meaning its own characters: `%` and `_` typed are not wildcards. */
export function likePattern(form: string): string {
  return `%${form.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * A form found in `column`. `LIKE` where the form has no case to fold — Hangul, digits — and
 * `ILIKE` only where it has: `ILIKE` lowers every row's text before it compares, and measured on
 * 10,000 Korean chunks a scan with it took 269 ms where `LIKE` took 86 ms for the same rows.
 * The trigram index serves both.
 */
function holds(column: AnyPgColumn, form: string): SQL {
  return form.toLowerCase() === form.toUpperCase()
    ? sql`${column} like ${likePattern(form)}`
    : sql`${column} ilike ${likePattern(form)}`;
}

/** Every word found in `column`, each by any of its forms. */
function holdsEvery(column: AnyPgColumn, words: HubSearchWord[]): SQL {
  return and(
    ...words.map((word) =>
      or(...word.forms.map((form) => holds(column, form))),
    ),
  ) as SQL;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `HUB_SNIPPET_CHARS` characters around the first form found, on one line, cut where a person
 * sees a character end (a cut through an emoji is not text — the product's search learnt it).
 */
export function snippetOf(text: string, words: HubSearchWord[]): string {
  const line = [...GRAPHEMES.segment(text.replace(/\s+/gu, " ").trim())].map(
    (one) => one.segment,
  );
  const lower = line.map((character) => character.toLowerCase());
  const whole = lower.join("");
  let first = -1;
  for (const word of words) {
    for (const form of word.forms) {
      const found = whole.indexOf(form.toLowerCase());
      if (found !== -1 && (first === -1 || found < first)) first = found;
    }
  }
  let lead = 0;
  if (first > 0) {
    let units = 0;
    for (const character of lower) {
      if (units + character.length > first) break;
      units += character.length;
      lead += 1;
    }
  }
  const start =
    line.length <= HUB_SNIPPET_CHARS ? 0 : Math.max(0, lead - SNIPPET_LEAD);
  const end = Math.min(line.length, start + HUB_SNIPPET_CHARS);
  return line.slice(start, end).join("");
}

type Candidate = {
  id: string;
  title: string;
  folder: string;
  from: number;
  text: string | null;
  score: number;
  at: Date;
  by: string | null;
};

export function searchRoute(options: {
  database: HubDatabase;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
  filesDir: string | null;
}) {
  const { database } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.post(
    "/",
    options.member,
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) =>
        context.json({ ok: false, code: "laf:request_invalid" }, 413),
    }),
    async (context) => {
      if (!options.filesDir) {
        return context.json({ ok: false, code: HUB_FACTS.filesUnset }, 503);
      }
      const invalid = (field: string) =>
        context.json({ ok: false, code: "laf:request_invalid", field }, 400);
      let input: { [K in keyof HubSearchRequest]?: unknown };
      try {
        const parsed: unknown = await context.req.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return invalid("body");
        }
        input = parsed;
      } catch {
        return invalid("body");
      }
      const words = searchWords(input.q);
      if (!words) return invalid("q");
      const limit = input.limit ?? HUB_SEARCH_HITS;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > HUB_SEARCH_MAX_HITS
      ) {
        return invalid("limit");
      }
      const task = input.task ?? null;
      if (task !== null && (typeof task !== "string" || !TASK_ID.test(task))) {
        return invalid("task");
      }

      const me = context.get("member").id;
      let hits: HubSearchHit[];
      try {
        hits = await search(database, { me, words, limit, task });
      } catch (error) {
        if (isCancelled(error)) {
          return context.json(
            { ok: false, code: "laf:hub_search_timeout" },
            503,
          );
        }
        throw error;
      }
      // What was looked for is content, so the trail keeps how much was asked and found, not what.
      await recordAudit(database, {
        ...trailOf(context),
        action: "search",
        outcome: "ok",
        payload: { words: words.length, hits: hits.length },
      });
      const body: HubSearchResult = { ok: true, hits };
      return context.json(body);
    },
  );
  return route;
}

function isCancelled(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function search(
  database: HubDatabase,
  input: {
    me: string;
    words: HubSearchWord[];
    limit: number;
    task: string | null;
  },
): Promise<HubSearchHit[]> {
  const { me, words, limit, task } = input;
  const stemmed = words.map((word) => word.forms.at(-1)).join(" ");
  const readsChunks = words.some((word) => charLength(word.word) >= 3);
  const bonus = (at: AnyPgColumn, taskOf: AnyPgColumn) =>
    sql`(case when ${at} > now() - interval '30 days' then 0.1 else 0 end) + (case when ${task}::text is not null and ${taskOf} = ${task}::text then 0.2 else 0 end)`;

  return database.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`set local statement_timeout = ${SEARCH_TIMEOUT_MS}`),
    );
    const found = new Map<string, Candidate>();
    const keep = (candidate: Candidate) => {
      const held = found.get(candidate.id);
      if (!held || held.score < candidate.score) {
        found.set(candidate.id, candidate);
      }
    };

    if (readsChunks) {
      // The pool: the newest matching chunks the member may see, from hub_chunks alone. Only these
      // are scored — `word_similarity` costs about 0.15 ms on a 1,200-character chunk, and a word
      // in nearly every chunk would otherwise be scored 10,000 times (measured: 3.2 s at 10,000
      // chunks). Newest first, because for a word that common every chunk scores alike on the
      // words (one word held is 1.0), and what still separates them is the name — which the names
      // query below finds whatever the pool held — and how recent.
      const pool = tx
        .select({
          sourceId: hubChunks.sourceId,
          ordinal: hubChunks.ordinal,
          text: hubChunks.text,
          title: hubChunks.title,
          taskId: hubChunks.taskId,
          at: hubChunks.at,
        })
        .from(hubChunks)
        .where(
          and(
            eq(hubChunks.sourceKind, "file"),
            visibleTo(hubChunks.visibility, me),
            holdsEvery(hubChunks.text, words),
          ),
        )
        .orderBy(desc(hubChunks.at), desc(hubChunks.id))
        .limit(POOL)
        .as("pool");
      const nameHolds = holdsEvery(pool.title, words);
      const scored = tx
        .select({
          sourceId: pool.sourceId,
          ordinal: pool.ordinal,
          text: pool.text,
          at: pool.at,
          score:
            sql<number>`(word_similarity(${stemmed}, ${pool.text}) + (case when ${nameHolds} then 0.3 else 0 end) + ${bonus(pool.at, pool.taskId)})::float8`.as(
              "score",
            ),
        })
        .from(pool)
        .orderBy(sql`"score" desc`, desc(pool.at))
        .limit(CANDIDATES)
        .as("scored");
      // Only the best few meet the files table, so the join's cost does not grow with the pool.
      const rows = await tx
        .select({
          id: scored.sourceId,
          ordinal: scored.ordinal,
          text: scored.text,
          title: hubFiles.name,
          folder: hubFiles.folder,
          at: scored.at,
          by: hubFileVersions.by,
          score: scored.score,
        })
        .from(scored)
        .innerJoin(hubFiles, eq(hubFiles.id, scored.sourceId))
        .innerJoin(
          hubFileVersions,
          and(
            eq(hubFileVersions.fileId, hubFiles.id),
            eq(hubFileVersions.version, hubFiles.version),
          ),
        )
        .where(
          and(isNull(hubFiles.deletedAt), visibleTo(hubFiles.visibility, me)),
        );
      for (const row of rows) {
        keep({
          id: row.id,
          title: row.title,
          folder: row.folder,
          from: chunkStart(row.ordinal),
          text: row.text,
          score: Number(row.score),
          at: row.at,
          by: row.by,
        });
      }
    }

    // File names, for every query: the only place a two-character word is looked for, and a
    // name that holds every word is a hit even where the words are not in its text.
    const named = await tx
      .select({
        id: hubFiles.id,
        title: hubFiles.name,
        folder: hubFiles.folder,
        at: hubFileVersions.at,
        by: hubFileVersions.by,
        score:
          sql<number>`(word_similarity(${stemmed}, ${hubFiles.name}) + 0.3 + ${bonus(hubFileVersions.at, hubFiles.taskId)})::float8`.as(
            "score",
          ),
      })
      .from(hubFiles)
      .innerJoin(
        hubFileVersions,
        and(
          eq(hubFileVersions.fileId, hubFiles.id),
          eq(hubFileVersions.version, hubFiles.version),
        ),
      )
      .where(
        and(
          isNull(hubFiles.deletedAt),
          visibleTo(hubFiles.visibility, me),
          holdsEvery(hubFiles.name, words),
        ),
      )
      .orderBy(sql`"score" desc`, sql`${hubFileVersions.at} desc`)
      .limit(CANDIDATES);
    for (const row of named) {
      if (found.has(row.id)) continue;
      keep({ ...row, from: 0, text: null, score: Number(row.score) });
    }

    const best = [...found.values()]
      .sort((a, b) => b.score - a.score || b.at.getTime() - a.at.getTime())
      .slice(0, limit);

    // A hit found by its name alone shows the start of its text.
    const opening = best
      .filter((hit) => hit.text === null)
      .map((hit) => hit.id);
    if (opening.length > 0) {
      const firsts = await tx
        .select({ id: hubChunks.sourceId, text: hubChunks.text })
        .from(hubChunks)
        .where(
          and(
            eq(hubChunks.sourceKind, "file"),
            inArray(hubChunks.sourceId, opening),
            eq(hubChunks.ordinal, 0),
            visibleTo(hubChunks.visibility, me),
          ),
        );
      const firstOf = new Map(firsts.map((row) => [row.id, row.text]));
      for (const hit of best) {
        if (hit.text === null) hit.text = firstOf.get(hit.id) ?? null;
      }
    }

    return best.map(
      (hit): HubSearchHit => ({
        kind: "file",
        id: hit.id,
        title: hit.title,
        where: { folder: hit.folder, from: hit.from },
        snippet: hit.text ? snippetOf(hit.text, words) : "",
        score: Math.round(hit.score * 1000) / 1000,
        at: hit.at.toISOString(),
        by: hit.by,
      }),
    );
  });
}
