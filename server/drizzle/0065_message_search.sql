-- Searching what was said, in every conversation a person has. 2026-10-10.
-- (docs/laf/redesign-2026-10.md §3 "통합검색", piece 4-3.)
--
-- KOREAN IS SEARCHED BY SUBSTRING. Postgres's own full-text search has no Korean morphology: it
-- splits on spaces, and "메뉴판을" is one word that "메뉴" does not find. `pg_trgm` indexes every
-- three characters in a row, so `ILIKE '%메뉴판%'` reads the index and not the table. It ships in
-- the plain `postgres:17` image this product runs on (contrib), and it is a trusted extension: the
-- database's owner may create it, which is who runs these migrations.
--
-- MEASURED ON THE IMAGE'S LOCALE (en_US.utf8), where it matters: under `C` pg_trgm takes every
-- character outside ASCII for a word break and extracts nothing from Korean. The answer would
-- still be right — the index would only stop helping — and `show_trgm('가을 메뉴')` is the check.
--
-- WHAT IS SEARCHED IS WHAT THE CONVERSATION DREW AS WORDS: a person's message and the Bot's
-- answer. `laf_message_text` is that reading, once, for the index and for the query that must
-- name the same expression to use it: a message's `content` where it is a string, and the text
-- parts of one that carried files, a line each (`toVisibleChatItems` in the app reads it the same
-- way). A tool's result is neither indexed nor read — a page the Bot fetched is not something the
-- person said or was told, and it is where a search would find what nobody remembers seeing.
--
-- NO STATISTICS ARE KEPT FOR THE INDEX'S EXPRESSION, AND THAT LINE IS NOT OPTIONAL. Measured on
-- 100,000 messages (two thirds of them words, about 250 Korean characters each): with the
-- default target `ANALYZE` of this table ran for more than five minutes at a full core and was
-- cancelled; with the target at 1 — three hundred sampled rows — it was still running at 45
-- seconds; at 0 it takes 0.7 s. Autovacuum analyses a table as it grows, so without the line every
-- VM pays that on its own schedule, on its one database. Why the expression's statistics cost
-- that much was not established (ordering long Korean text under the database's collation is the
-- guess). Nothing is lost: the planner has no use for a histogram of whole messages, and with the
-- target at 0 it takes the index for a word of three characters or more — 2 ms for a rare one —
-- and reads every searchable row for a two-character one, which has no trigram: 0.5 s at that
-- size, 0.9 s for two words that are in every message.
--
-- Not drizzle's to describe (a function, an operator class, a partial index on an expression), so
-- the schema file points here and this file is the definition.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE FUNCTION "laf_message_text"("message" jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE jsonb_typeof("message" -> 'content')
  WHEN 'string' THEN "message" ->> 'content'
  WHEN 'array' THEN (
    SELECT string_agg(part.value ->> 'text', E'\n' ORDER BY part.ordinality)
    FROM jsonb_array_elements("message" -> 'content') WITH ORDINALITY AS part
    WHERE part.value ->> 'type' = 'text'
  )
END;--> statement-breakpoint
CREATE INDEX "laf_thread_messages_said_trgm_idx" ON "laf_thread_messages"
USING gin ("laf_message_text"("message") gin_trgm_ops)
WHERE "message" ->> 'role' IN ('user', 'assistant');--> statement-breakpoint
ALTER INDEX "laf_thread_messages_said_trgm_idx" ALTER COLUMN 1 SET STATISTICS 0;
